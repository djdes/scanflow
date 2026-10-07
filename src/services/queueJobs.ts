import { logger } from '../utils/logger';
import { AiUnavailableError } from '../ai/errors';
import { reportAiOutage } from './aiOutage';

/**
 * Фоновые задачи «Очереди в 1С»: перераспознавание очереди и массовый подбор
 * позиций ИИ.
 *
 * Жёсткие правила (CLAUDE.md, правило 21 — инцидент 2026-07-14: параллельные
 * вызовы Claude на картинках пробили лимит памяти):
 *   - на сервер — ОДНА задача за раз, любого вида и любой компании: оба вида
 *     зовут Claude, и вместе это были бы параллельные тяжёлые вызовы;
 *   - внутри задачи накладные идут строго по одной;
 *   - ошибка на одной накладной записывается в её результат, задача идёт дальше;
 *   - «Остановить» срабатывает между накладными (текущий вызов модели не рвём);
 *   - модель недоступна (лимит подписки, вход, связь) — задача встаёт на паузу
 *     (status 'paused'), а когда модель вернётся, aiResume продолжает её с
 *     оставшихся накладных (resumePausedQueueJobs).
 *
 * Состояние — в памяти процесса (PM2 instances: 1). Итог последней задачи
 * каждой компании хранится, пока процесс жив; результаты перераспознавания
 * при этом лежат в БД (queue_reocr_results) и перезапуск переживают.
 */

export type QueueJobKind = 'reocr' | 'llm_map';
export type QueueJobStatus = 'running' | 'done' | 'cancelled' | 'error' | 'paused';

export interface QueueJobResult {
  invoice_id: number;
  status: string;
  [key: string]: unknown;
}

export interface QueueJob {
  id: number;
  kind: QueueJobKind;
  ownerUserId: number;
  startedBy: number | null;
  startedAt: string;
  finishedAt: string | null;
  status: QueueJobStatus;
  planned: number[];
  processed: number;
  currentInvoiceId: number | null;
  cancelRequested: boolean;
  results: QueueJobResult[];
  error: string | null;
  meta: Record<string, unknown>;
}

/** То, что видит владелец задачи в /status. */
export interface QueueJobView {
  id: number;
  kind: QueueJobKind;
  status: QueueJobStatus;
  started_at: string;
  finished_at: string | null;
  planned: number;
  processed: number;
  current_invoice_id: number | null;
  cancel_requested: boolean;
  counts: Record<string, number>;
  results: QueueJobResult[];
  error: string | null;
  meta: Record<string, unknown>;
}

export interface QueueJobStatusView {
  /** Задача этой компании этого вида (идущая или последняя законченная). */
  job: QueueJobView | null;
  /** Сервер занят задачей: своей другого вида или чужой (без подробностей). */
  busy: { kind: QueueJobKind; own: boolean } | null;
}

export class QueueJobBusyError extends Error {
  constructor(public kind: QueueJobKind, public own: boolean) {
    super(own
      ? (kind === 'reocr' ? 'Уже идёт перераспознавание очереди — дождитесь окончания или остановите его' : 'Уже идёт подбор позиций ИИ — дождитесь окончания или остановите его')
      : `Сервер сейчас ${kind === 'reocr' ? 'перераспознаёт очередь' : 'подбирает позиции ИИ для очереди'} другой компании — такие задачи идут по одной, попробуйте позже`);
    this.name = 'QueueJobBusyError';
  }
}

/** Задачу нельзя начать (нет ключа, пустой каталог, пустая очередь) — 400 с текстом для человека. */
export class QueueStartError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'QueueStartError';
  }
}

let active: QueueJob | null = null;
let seq = 0;
const lastByOwnerKind = new Map<string, QueueJob>();
/** Задачи на паузе из-за недоступной модели: как продолжить с оставшихся накладных. */
const paused = new Map<string, { job: QueueJob; remaining: number[]; resume: (ids: number[]) => Promise<unknown> }>();
const key = (owner: number, kind: QueueJobKind) => `${owner}:${kind}`;

export function activeQueueJob(): QueueJob | null {
  return active;
}

export function assertQueueJobFree(ownerUserId: number): void {
  if (active) throw new QueueJobBusyError(active.kind, active.ownerUserId === ownerUserId);
}

export function startQueueJob(opts: {
  kind: QueueJobKind;
  ownerUserId: number;
  startedBy: number | null;
  invoiceIds: number[];
  meta?: Record<string, unknown>;
  worker: (invoiceId: number, job: QueueJob) => Promise<QueueJobResult>;
  /** Продолжить задачу с оставшихся накладных после паузы (модель недоступна). */
  resume?: (remainingIds: number[]) => Promise<unknown>;
}): { job: QueueJob; done: Promise<void> } {
  // Проверка и захват — синхронно, без await между ними: второй одновременный
  // запуск гарантированно получит «занято».
  assertQueueJobFree(opts.ownerUserId);
  const job: QueueJob = {
    id: ++seq,
    kind: opts.kind,
    ownerUserId: opts.ownerUserId,
    startedBy: opts.startedBy,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'running',
    planned: [...opts.invoiceIds],
    processed: 0,
    currentInvoiceId: null,
    cancelRequested: false,
    results: [],
    error: null,
    meta: { ...(opts.meta ?? {}) },
  };
  active = job;
  lastByOwnerKind.set(key(job.ownerUserId, job.kind), job);
  paused.delete(key(job.ownerUserId, job.kind));
  logger.info('Queue job started', { jobId: job.id, kind: job.kind, ownerUserId: job.ownerUserId, planned: job.planned.length });

  const done = (async () => {
    try {
      let pausedBy: AiUnavailableError | null = null;
      for (let k = 0; k < job.planned.length; k++) {
        const invoiceId = job.planned[k];
        if (job.cancelRequested) break;
        job.currentInvoiceId = invoiceId;
        let result: QueueJobResult;
        try {
          result = await opts.worker(invoiceId, job);
        } catch (err) {
          if (err instanceof AiUnavailableError) {
            // Модель недоступна: дальше по очереди упадёт так же — пауза до её возвращения.
            pausedBy = err;
            const remaining = job.planned.slice(k);
            job.meta = { ...job.meta, remaining: remaining.length };
            if (opts.resume) paused.set(key(job.ownerUserId, job.kind), { job, remaining, resume: opts.resume });
            break;
          }
          const message = (err as Error).message || String(err);
          logger.warn('Queue job: invoice failed', { jobId: job.id, kind: job.kind, invoiceId, error: message });
          result = { invoice_id: invoiceId, status: 'error', error: message.slice(0, 500) };
        }
        job.results.push(result);
        job.processed++;
      }
      if (pausedBy) {
        job.status = 'paused';
        job.error = `Приостановлено: ${pausedBy.text}. Продолжится само, когда GPT снова будет доступен.`;
        logger.warn('Queue job paused — AI model unavailable', { jobId: job.id, kind: job.kind, reason: pausedBy.reason });
        void reportAiOutage(pausedBy);
      } else {
        job.status = job.cancelRequested ? 'cancelled' : 'done';
      }
    } catch (err) {
      job.status = 'error';
      job.error = ((err as Error).message || String(err)).slice(0, 500);
      logger.error('Queue job crashed', { jobId: job.id, kind: job.kind, error: job.error });
    } finally {
      job.currentInvoiceId = null;
      job.finishedAt = new Date().toISOString();
      if (active === job) active = null;
      logger.info('Queue job finished', {
        jobId: job.id, kind: job.kind, ownerUserId: job.ownerUserId, status: job.status,
        processed: job.processed, planned: job.planned.length,
      });
    }
  })();
  return { job, done };
}

export function viewQueueJob(job: QueueJob): QueueJobView {
  const counts: Record<string, number> = {};
  for (const r of job.results) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    started_at: job.startedAt,
    finished_at: job.finishedAt,
    planned: job.planned.length,
    processed: job.processed,
    current_invoice_id: job.currentInvoiceId,
    cancel_requested: job.cancelRequested,
    counts,
    results: job.results.slice(-200),
    error: job.error,
    meta: job.meta,
  };
}

/** Статус задачи вида kind для компании: подробности — только своей. */
export function queueJobStatus(ownerUserId: number, kind: QueueJobKind): QueueJobStatusView {
  const own = lastByOwnerKind.get(key(ownerUserId, kind)) ?? null;
  const busy = active && !(active.ownerUserId === ownerUserId && active.kind === kind)
    ? { kind: active.kind, own: active.ownerUserId === ownerUserId }
    : null;
  return { job: own ? viewQueueJob(own) : null, busy };
}

/** Остановить свою идущую задачу (после текущей накладной); задачу на паузе — снять. */
export function cancelQueueJob(ownerUserId: number, kind: QueueJobKind): boolean {
  if (paused.delete(key(ownerUserId, kind))) {
    const job = lastByOwnerKind.get(key(ownerUserId, kind));
    if (job && job.status === 'paused') job.status = 'cancelled';
    return true;
  }
  if (!active || active.ownerUserId !== ownerUserId || active.kind !== kind) return false;
  active.cancelRequested = true;
  return true;
}

/**
 * Модель снова доступна — продолжить задачу на паузе с оставшихся накладных.
 * Одна за раз: на сервер — одна задача (правило 21). Остальные — следующим проходом.
 * true — задача запущена.
 */
export async function resumePausedQueueJobs(): Promise<boolean> {
  if (active) return false;
  for (const [k, entry] of paused) {
    paused.delete(k);
    try {
      await entry.resume(entry.remaining);
      logger.info('Queue job resumed after AI outage', { kind: entry.job.kind, ownerUserId: entry.job.ownerUserId, remaining: entry.remaining.length });
      return true;
    } catch (err) {
      logger.warn('Queue job resume failed', { kind: entry.job.kind, ownerUserId: entry.job.ownerUserId, error: (err as Error).message });
    }
  }
  return false;
}

/** Только для тестов: сбросить состояние модуля. */
export function resetQueueJobsForTests(): void {
  active = null;
  lastByOwnerKind.clear();
  paused.clear();
}
