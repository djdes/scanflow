import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import express from 'express';
import { resetDb, closeTestDb } from '../helpers/db';
vi.mock('../../src/config', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/config')>();
  const os = await import('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-recognition-'));
  const dirs = Object.fromEntries(['inboxDir', 'processedDir', 'failedDir'].map(name => {
    const dir = path.join(root, name); fs.mkdirSync(dir); return [name, dir];
  }));
  return { config: { ...real.config, ...dirs } };
});
vi.mock('../../src/ai/engine', () => ({ aiEngineState: vi.fn(async () => ({ available: true, text: 'connected' })) }));
vi.mock('../../src/services/queueJobs', () => ({ activeQueueJob: () => null }));
vi.mock('../../src/utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import { config } from '../../src/config';
import { getDb } from '../../src/database/db';
import { userRepo } from '../../src/database/repositories/userRepo';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';
import { recognitionJobRepo } from '../../src/database/repositories/recognitionJobRepo';
import { enqueueRecognitionFile, runRecognitionQueuePass, retryDelaySeconds, adoptUnfinishedRecognition, type RecognitionWorker } from '../../src/services/recognitionQueue';
import { aiEngineState } from '../../src/ai/engine';
import router from '../../src/api/routes/recognitionQueue';
import uploadRouter, { setFileWatcher } from '../../src/api/routes/upload';
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  const owner = req.headers['x-owner'];
  if (!owner) { res.status(401).end(); return; }
  req.user = { id: Number(owner), username: 'fixture', role: 'user' }; next();
});
app.use('/api/recognition-queue', router);
app.use('/api/upload', uploadRouter);
setFileWatcher({ markProcessing() {}, unmarkProcessing() {} } as never);
app.use((error: Error, _req: unknown, res: express.Response, _next: unknown) => res.status(500).json({ error: error.message }));

describe.runIf((process.env.DB_NAME || '').includes('test'))('durable recognition queue', () => {
  beforeEach(async () => {
    await resetDb();
    await userRepo.create({ username: 'queue-1', password_hash: 'x', api_key: 'queue-1' });
    await userRepo.create({ username: 'queue-2', password_hash: 'x', api_key: 'queue-2' });
    vi.mocked(aiEngineState).mockResolvedValue({ available: true, text: 'connected' } as never);
  });
  afterAll(closeTestDb);
  let serial = 0;
  async function enqueue(owner = 1, content = `photo-${++serial}`, ext = 'jpg') {
    const filename = `upload-${owner}-${Date.now()}-${++serial}.${ext}`;
    const file = path.join(config.inboxDir, filename);
    fs.writeFileSync(file, content);
    return enqueueRecognitionFile(file, filename, undefined, { ownerUserId: owner, source: 'web' });
  }
  function worker(fail = false): RecognitionWorker {
    return {
      processFile: vi.fn(async (file, name, _engine, meta) => {
        const inv = await invoiceRepo.create({ file_name: name, file_path: file, file_hash: require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex'), owner_user_id: meta!.ownerUserId });
        await meta?.onCreated?.(inv.id);
        await invoiceRepo.updateStatus(inv.id, fail ? 'error' : 'processed', fail ? 'model timeout' : undefined);
        if (fail) throw new Error('model timeout');
        return inv.id;
      }),
      processQueuedInvoice: vi.fn(async id => {
        await invoiceRepo.updateStatus(id, fail ? 'error' : 'processed', fail ? 'model timeout' : undefined);
        if (fail) throw new Error('model timeout'); return id;
      }),
    };
  }
  it('commits a receipt before 202, deduplicates repeated uploads and keeps owners separate', async () => {
    const upload = () => request(app).post('/api/upload').set('X-Owner', '1').attach('file', Buffer.from('same-bytes'), 'invoice.jpg');
    const first = await upload(), second = await upload();
    expect(first.status).toBe(202); expect(second.status).toBe(202);
    expect(second.body.job_id).toBe(first.body.job_id);
    const job = (await recognitionJobRepo.get(first.body.job_id, 1))!;
    expect(job).toMatchObject({ state: 'queued', attempts: 0, invoice_id: null });
    expect(fs.readFileSync(job.file_path).toString()).toBe('same-bytes');
    const other = await request(app).post('/api/upload').set('X-Owner', '2').attach('file', Buffer.from('same-bytes'), 'invoice.jpg');
    expect(other.body.job_id).not.toBe(first.body.job_id);
    const listing = await request(app).get('/api/recognition-queue?ids=' + other.body.job_id).set('X-Owner', '1');
    expect(listing.body.total).toBe(1); expect(listing.body.receipts).toEqual([]);
    expect(listing.body.data[0]).not.toHaveProperty('file_path'); expect(listing.body.data[0]).not.toHaveProperty('file_hash');
    expect((await request(app).get('/api/recognition-queue/' + job.id).set('X-Owner', '2')).status).toBe(404);
  });
  it('retains failed recognition indefinitely and retries the same invoice, without starving a later upload', async () => {
    const job = await enqueue(); const failing = worker(true);
    for (let attempt = 0; attempt < 9; attempt++) {
      await getDb().prepare('UPDATE recognition_jobs SET next_attempt_at = NOW() WHERE id = ?').run(job.id);
      await runRecognitionQueuePass(failing);
    }
    const failed = (await recognitionJobRepo.get(job.id, 1))!;
    expect(failed).toMatchObject({ state: 'retry', attempts: 9, last_error: 'model timeout' });
    expect(fs.existsSync(job.file_path)).toBe(true);
    expect(failing.processFile).toHaveBeenCalledTimes(1); expect(failing.processQueuedInvoice).toHaveBeenCalledTimes(8);
    const next = await enqueue();
    const good = worker(); await runRecognitionQueuePass(good);
    expect((await recognitionJobRepo.get(next.id, 1))?.state).toBe('completed');
    await recognitionJobRepo.retry(job.id, 1); await runRecognitionQueuePass(good);
    expect((await recognitionJobRepo.get(job.id, 1))!).toMatchObject({ state: 'completed', invoice_id: failed.invoice_id });
    expect(retryDelaySeconds(1000)).toBe(3600);
  });
  it('does not acknowledge a DB failure, retains the photo and recovers it on a later upload', async () => {
    const fail = vi.spyOn(recognitionJobRepo, 'enqueue').mockRejectedValueOnce(Error('database offline'));
    const response = await request(app).post('/api/upload').set('X-Owner', '2').attach('file', Buffer.from('unacknowledged-photo'), 'invoice.jpg');
    fail.mockRestore();
    expect(response.status).toBe(503); expect(response.body.job_id).toBeUndefined();
    const saved = fs.readdirSync(config.inboxDir).find(name => name.startsWith('upload-2-') && fs.readFileSync(path.join(config.inboxDir, name)).toString() === 'unacknowledged-photo');
    expect(saved).toBeDefined();
    const job = await enqueueRecognitionFile(path.join(config.inboxDir, saved!), saved!, undefined, { ownerUserId: 2 });
    const retry = await request(app).post('/api/upload').set('X-Owner', '2').attach('file', Buffer.from('unacknowledged-photo'), 'invoice.jpg');
    expect(retry.status).toBe(202); expect(retry.body.job_id).toBe(job.id);
    expect((await recognitionJobRepo.list(2)).total).toBe(1);
  });
  it('keeps an explicitly deleted invoice cancelled and allows an explicit new upload', async () => {
    const job = await enqueue(1, 'cancelled-photo'); await runRecognitionQueuePass(worker());
    const done = (await recognitionJobRepo.get(job.id, 1))!;
    await invoiceRepo.delete(done.invoice_id!);
    await recognitionJobRepo.cancelInvoice(done.invoice_id!, 1, job.file_hash);
    await runRecognitionQueuePass(worker());
    expect((await recognitionJobRepo.get(job.id, 1))?.state).toBe('cancelled');
    const reuploaded = await enqueue(1, 'cancelled-photo');
    expect(reuploaded).toMatchObject({ id: job.id, state: 'queued', invoice_id: null, attempts: 0 });
    await runRecognitionQueuePass(worker());
    expect((await recognitionJobRepo.get(job.id, 1))?.state).toBe('completed');
  });
  it('recovers an expired processing lease after restart and fences a stale worker', async () => {
    const job = await enqueue();
    const claims = await Promise.all([recognitionJobRepo.claim(), recognitionJobRepo.claim()]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const old = claims.find(Boolean)!;
    expect(await recognitionJobRepo.heartbeat(old)).toBe(true);
    const inv = await invoiceRepo.create({ file_name: job.file_name, file_path: job.file_path, file_hash: job.file_hash, owner_user_id: 1 });
    await invoiceRepo.updateStatus(inv.id, 'ocr_processing'); await recognitionJobRepo.linkInvoice(old, inv.id);
    await getDb().prepare('UPDATE recognition_worker_lease SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE)').run();
    await getDb().prepare('UPDATE recognition_jobs SET lease_expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?').run(job.id);
    const renewed = (await recognitionJobRepo.claim())!;
    await recognitionJobRepo.settle(old, { invoiceId: inv.id });
    expect((await recognitionJobRepo.get(job.id, 1))?.state).toBe('processing');
    expect(await recognitionJobRepo.claim()).toBe(null);
    await recognitionJobRepo.settle(renewed, { invoiceId: inv.id, error: 'restart', delaySeconds: 0 });
    const target = worker(); await runRecognitionQueuePass(target);
    expect(target.processQueuedInvoice).toHaveBeenCalledWith(inv.id, undefined);
    expect(target.processFile).not.toHaveBeenCalled();
    expect((await recognitionJobRepo.get(job.id, 1))?.state).toBe('completed');
  });
  it('keeps jobs while GPT is unavailable and still handles XML', async () => {
    const image = await enqueue(); const xml = await enqueue(1, 'xml-fixture', 'xml');
    vi.mocked(aiEngineState).mockResolvedValue({ available: false, text: 'rate limit' } as never);
    await runRecognitionQueuePass(worker());
    expect((await recognitionJobRepo.get(image.id, 1))).toMatchObject({ state: 'queued', attempts: 0 });
    expect((await recognitionJobRepo.get(xml.id, 1))?.state).toBe('completed');
  });
  it('adopts incomplete rows without promoting partial items; excludes paid/approved documents', async () => {
    const names = [];
    for (let n = 0; n < 3; n++) {
      const filename = `legacy-${n}-${++serial}.jpg`, file = path.join(config.processedDir, filename);
      fs.writeFileSync(file, filename);
      const inv = await invoiceRepo.create({ file_name: filename, file_path: file, owner_user_id: 1 });
      await invoiceRepo.updateStatus(inv.id, 'parsing'); names.push(inv.id);
      await invoiceRepo.addItem({ invoice_id: inv.id, original_name: 'Partial row', quantity: 1, unit: 'шт', total: 5 });
    }
    await getDb().prepare('UPDATE invoices SET paid_externally = 1 WHERE id = ?').run(names[1]);
    await getDb().prepare('UPDATE invoices SET approved_for_1c = 1 WHERE id = ?').run(names[2]);
    expect(await adoptUnfinishedRecognition()).toBe(1);
    expect((await recognitionJobRepo.list(1)).data[0].invoice_id).toBe(names[0]);
    expect((await invoiceRepo.getById(names[0]))?.status).toBe('parsing');
  });
  it('retains a missing source and its diagnosis instead of dropping the job', async () => {
    const job = await enqueue(); fs.unlinkSync(job.file_path);
    await runRecognitionQueuePass(worker());
    expect((await recognitionJobRepo.get(job.id, 1))).toMatchObject({ state: 'retry', last_error: expect.stringContaining('Фото не найдено') });
  });
});
