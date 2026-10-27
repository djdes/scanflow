import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../config';
import { getDb } from '../database/db';
import { recognitionJobRepo, type RecognitionJob } from '../database/repositories/recognitionJobRepo';
import { invoiceRepo } from '../database/repositories/invoiceRepo';
import { sha256File } from '../utils/fileHash';
import { logger } from '../utils/logger';
import { aiEngineState } from '../ai/engine';
import { activeQueueJob } from './queueJobs';
import { acquireRecognitionActivity } from './recognitionActivity';
import type { UploadMeta } from '../watcher/fileWatcher';

export interface RecognitionWorker {
  processFile(filePath: string, fileName: string, engine?: string, meta?: UploadMeta): Promise<number>;
  processQueuedInvoice(invoiceId: number, engine?: string): Promise<number>;
  unmarkProcessing?(filePath: string): void;
  reconcileInbox?(): Promise<void>;
}
let worker: RecognitionWorker | null = null;
let running = false;
let timer: NodeJS.Timeout | null = null;
let lastAdoption = 0;
export const retryDelaySeconds = (attempt: number) => Math.min(3600, 30 * 2 ** Math.min(7, Math.max(0, attempt - 1)));

export async function enqueueRecognitionFile(filePath: string, fileName: string, engine?: string, meta?: UploadMeta, originalName = fileName) {
  if (!Number.isSafeInteger(meta?.ownerUserId) || (meta?.ownerUserId ?? 0) <= 0) throw new Error('Владелец загрузки не определён');
  const hash = sha256File(filePath);
  const input = { owner_user_id: meta!.ownerUserId!, file_name: fileName, file_path: filePath,
    file_hash: hash, original_name: originalName, source: meta?.source ?? 'inbox', user_agent: meta?.userAgent ?? null, force_engine: engine?.slice(0, 32) ?? null };
  let job = await recognitionJobRepo.enqueue(input);
  if (job.state === 'cancelled' || (job.state === 'completed' && job.invoice_id && !(await invoiceRepo.getById(job.invoice_id)))) {
    job = await recognitionJobRepo.revive(job, input);
  }
  // A repeated upload is also a way to restore a missing physical copy, without creating a second invoice.
  const roots = [config.inboxDir, config.processedDir, config.failedDir].map(dir => path.resolve(dir));
  const storedExists = fs.existsSync(job.file_path) || (!job.file_name.includes(',') && roots.some(dir => fs.existsSync(path.join(dir, path.basename(job.file_name)))));
  if (!job.file_name.includes(',') && !storedExists && roots.includes(path.dirname(path.resolve(job.file_path)))) {
    try { fs.copyFileSync(filePath, job.file_path, fs.constants.COPYFILE_EXCL); } catch (error) {
      logger.warn('Could not restore recognition source', { jobId: job.id, error: (error as Error).message });
    }
  }
  if (path.resolve(filePath) !== path.resolve(job.file_path) && path.dirname(path.resolve(filePath)) === path.resolve(config.inboxDir)) {
    const duplicatePath = path.join(config.processedDir, path.basename(filePath));
    try { if (!fs.existsSync(duplicatePath)) fs.renameSync(filePath, duplicatePath); } catch { /* durable canonical copy is still retained */ }
  }
  kickRecognitionQueue();
  return job;
}

/** Existing failures are adopted in place. Sent/approved/paid documents are never re-driven. */
export async function adoptUnfinishedRecognition(): Promise<number> {
  const rows = await getDb().prepare(`SELECT i.id, i.owner_user_id, i.file_name, i.file_path, i.file_hash, i.upload_source, i.upload_user_agent
    FROM invoices i WHERE i.owner_user_id IS NOT NULL AND i.status IN ('new','ocr_processing','parsing','waiting_ai','error')
      AND i.approved_for_1c = 0 AND i.paid_externally = 0 AND i.duplicate_of IS NULL
      AND NOT EXISTS (SELECT 1 FROM sber_payments sp WHERE sp.invoice_id = i.id AND sp.status <> 'failed')
      AND NOT EXISTS (SELECT 1 FROM recognition_jobs j WHERE j.invoice_id = i.id OR (j.owner_user_id = i.owner_user_id AND j.file_hash = i.file_hash))
    ORDER BY i.id LIMIT 200`).all<{ id: number; owner_user_id: number; file_name: string; file_path: string; file_hash: string | null; upload_source: string | null; upload_user_agent: string | null }>();
  for (const inv of rows) {
    await recognitionJobRepo.enqueue({ owner_user_id: inv.owner_user_id, invoice_id: inv.id, file_name: inv.file_name,
      file_path: inv.file_path, file_hash: inv.file_hash ?? createHash('sha256').update(`legacy-invoice:${inv.id}`).digest('hex'),
      original_name: inv.file_name, source: inv.upload_source ?? 'inbox', user_agent: inv.upload_user_agent, force_engine: null });
  }
  return rows.length;
}

export async function runRecognitionQueuePass(target: RecognitionWorker): Promise<void> {
  if (running || activeQueueJob()) return;
  const release = acquireRecognitionActivity();
  if (!release) return;
  running = true;
  try {
    const state = await aiEngineState();
    // Respect other explicit recognition operations; normal uploads all use this single worker.
    const outside = await getDb().prepare(`SELECT i.id FROM invoices i WHERE i.status IN ('ocr_processing','parsing')
      AND i.created_at > DATE_SUB(NOW(), INTERVAL 10 MINUTE)
      AND NOT EXISTS (SELECT 1 FROM recognition_jobs j WHERE j.state IN ('queued','processing','retry')
        AND (j.invoice_id = i.id OR (j.owner_user_id = i.owner_user_id AND j.file_hash = i.file_hash))) LIMIT 1`).get();
    if (outside) return;
    const job = await recognitionJobRepo.claim(!state.available);
    if (!job) return;
    let invoiceId = job.invoice_id;
    const heartbeat = setInterval(() => {
      void recognitionJobRepo.heartbeat(job).catch(error => logger.error('Recognition lease renewal failed', { jobId: job.id, error: (error as Error).message }));
    }, 30000);
    heartbeat.unref?.();
    try {
      let inv = invoiceId ? await invoiceRepo.getById(invoiceId) : await invoiceRepo.findByFileHash(job.file_hash, job.owner_user_id);
      if (!inv && invoiceId) {
        const targetId = await invoiceRepo.resolveMergeTarget(invoiceId);
        if (targetId) { inv = await invoiceRepo.getById(targetId); invoiceId = targetId; }
      }
      if (inv && inv.owner_user_id !== job.owner_user_id) throw new Error('Владелец задания не совпадает с владельцем накладной');
      if (inv && ['processed', 'sent_to_1c', 'duplicate'].includes(inv.status)) {
        await recognitionJobRepo.settle(job, { invoiceId: inv.id }); return;
      }
      if (inv && (inv.approved_for_1c || inv.paid_externally || inv.duplicate_of)) throw new Error('Документ закрыт для автоматического распознавания');
      if (inv) {
        invoiceId = inv.id;
        await recognitionJobRepo.linkInvoice(job, inv.id);
        invoiceId = await target.processQueuedInvoice(inv.id, job.force_engine ?? undefined);
      } else {
        if (job.invoice_id) throw new Error('Накладная удалена. Автоматически создавать её заново нельзя');
        if (!fs.existsSync(job.file_path)) throw new Error('Фото не найдено на сервере. Нужна повторная загрузка фотографии');
        invoiceId = await target.processFile(job.file_path, job.file_name, job.force_engine ?? undefined,
          { ownerUserId: job.owner_user_id, source: job.source as UploadMeta['source'], userAgent: job.user_agent, durableQueue: true,
            onCreated: async id => { invoiceId = id; await recognitionJobRepo.linkInvoice(job, id); } });
      }
      inv = await invoiceRepo.getById(invoiceId);
      if (!inv) {
        const merged = await invoiceRepo.resolveMergeTarget(invoiceId);
        if (merged) invoiceId = merged;
        else throw new Error('Результат распознавания не найден — задание сохранено для проверки');
      } else if (!['processed', 'sent_to_1c', 'duplicate'].includes(inv.status)) {
        throw new Error(inv.error_message || 'Документ ещё не распознан');
      }
      await recognitionJobRepo.settle(job, { invoiceId });
    } catch (error) {
      if (!invoiceId) invoiceId = (await invoiceRepo.findByFileHash(job.file_hash, job.owner_user_id))?.id ?? null;
      const text = (error as Error).message || 'Не удалось распознать накладную';
      await recognitionJobRepo.settle(job, { invoiceId, error: text.slice(0, 2000), delaySeconds: retryDelaySeconds(job.attempts) });
      logger.warn('Recognition kept in durable queue', { jobId: job.id, invoiceId, attempts: job.attempts, error: text });
    } finally { clearInterval(heartbeat); target.unmarkProcessing?.(job.file_path); }
  } finally { running = false; release(); }
}

export function kickRecognitionQueue(): void {
  if (!worker || running) return;
  void runRecognitionQueuePass(worker).catch(error => logger.error('Recognition queue pass failed', { error: (error as Error).message }));
}
export async function startRecognitionQueue(target: RecognitionWorker): Promise<void> {
  worker = target;
  try { await adoptUnfinishedRecognition(); } catch (error) { logger.error('Recognition queue adoption failed', { error: (error as Error).message }); }
  lastAdoption = Date.now();
  timer = setInterval(() => {
    void (async () => {
      if (Date.now() - lastAdoption >= 60000) {
        lastAdoption = Date.now();
        await target.reconcileInbox?.();
        await adoptUnfinishedRecognition();
      }
      kickRecognitionQueue();
    })().catch(error => logger.error('Recognition queue maintenance failed', { error: (error as Error).message }));
  }, 5000);
  timer.unref?.();
  kickRecognitionQueue();
}
export function stopRecognitionQueue(): void { if (timer) clearInterval(timer); timer = null; worker = null; }
export function recognitionQueueBusy(): boolean { return running; }
