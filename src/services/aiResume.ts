import cron from 'node-cron';
import { invoiceRepo } from '../database/repositories/invoiceRepo';
import { logger } from '../utils/logger';
import { aiEngineState } from '../ai/engine';
import { reportAiResumed } from './aiOutage';
import { activeQueueJob, resumePausedQueueJobs } from './queueJobs';

/**
 * Возобновление после недоступности модели (подписка ChatGPT: лимит, вход, связь).
 *
 * Накладные, пришедшие во время сбоя, ждут в статусе waiting_ai. Здесь их
 * распознают — строго по одной (правило 21: параллельные распознавания пробивают
 * лимит памяти), по порядку загрузки. Снова «недоступна» — проход останавливается,
 * накладные ждут дальше. После ждущих продолжается задача очереди, вставшая на паузу.
 *
 * Когда проверяем: каждые 5 минут, сразу после входа в ChatGPT и успешной проверки
 * связи (kickAiResume) и через 30 секунд после названного времени сброса лимита.
 */

export interface ResumeWatcher {
  resumeWaitingInvoice(invoiceId: number): Promise<'processed' | 'waiting' | 'error' | 'skipped'>;
}

const IDLE_POLL_MS = 5_000;
const IDLE_MAX_WAIT_MS = 10 * 60_000;
const RESET_GRACE_MS = 30_000;
const MAX_RESET_WAIT_MS = 24 * 3_600_000;

let watcherRef: ResumeWatcher | null = null;
let running = false;
let resetTimer: NodeJS.Timeout | null = null;

/** Новые загрузки распознаются в том же процессе — дождаться, пока они закончатся. */
async function waitForRecognitionIdle(): Promise<void> {
  const deadline = Date.now() + IDLE_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const busy = await invoiceRepo.countRecognizing(10).catch(() => 0);
    if (busy === 0) return;
    await new Promise(r => setTimeout(r, IDLE_POLL_MS));
  }
}

function scheduleAtReset(retryAtMs: number | null): void {
  if (!retryAtMs) return;
  const delay = retryAtMs - Date.now() + RESET_GRACE_MS;
  if (delay <= 0 || delay > MAX_RESET_WAIT_MS) return;
  if (resetTimer) clearTimeout(resetTimer);
  resetTimer = setTimeout(() => { resetTimer = null; kickAiResume(); }, delay);
  resetTimer.unref?.();
}

export async function runAiResumePass(
  watcher: ResumeWatcher,
  deps: { waitForIdle?: () => Promise<void> } = {},
): Promise<{ resumed: number; stopped: boolean }> {
  if (running) return { resumed: 0, stopped: false };
  // Задача очереди сама распознаёт по одной — не запускаем параллельно с ней.
  if (activeQueueJob()) return { resumed: 0, stopped: false };
  running = true;
  try {
    const state = await aiEngineState();
    if (!state.available) {
      scheduleAtReset(state.retryAtMs);
      return { resumed: 0, stopped: true };
    }
    const ids = await invoiceRepo.listWaitingAiIds(200);
    let resumed = 0;
    for (const id of ids) {
      await (deps.waitForIdle ?? waitForRecognitionIdle)();
      const outcome = await watcher.resumeWaitingInvoice(id);
      if (outcome === 'waiting') {
        logger.warn('AI resume: model unavailable again, pass stopped', { invoiceId: id, resumed });
        const again = await aiEngineState().catch(() => null);
        scheduleAtReset(again?.retryAtMs ?? null);
        return { resumed, stopped: true };
      }
      if (outcome === 'processed') {
        resumed++;
        if (resumed === 1) void reportAiResumed(ids.length);
      }
    }
    if (ids.length) logger.info('AI resume: waiting invoices processed', { total: ids.length, resumed });
    if (!activeQueueJob()) await resumePausedQueueJobs();
    return { resumed, stopped: false };
  } finally {
    running = false;
  }
}

/** Внеочередной проход (после входа в ChatGPT, проверки связи, сброса лимита). Не ждёт и не бросает. */
export function kickAiResume(): void {
  const watcher = watcherRef;
  if (!watcher) return;
  void runAiResumePass(watcher).catch(err => logger.error('AI resume pass failed', { error: (err as Error).message }));
}

export function startAiResume(watcher: ResumeWatcher): void {
  watcherRef = watcher;
  cron.schedule('*/5 * * * *', () => kickAiResume());
  // Первый проход — чуть позже старта: сначала crash recovery и сканирование inbox.
  setTimeout(() => kickAiResume(), 60_000).unref?.();
  logger.info('AI resume scheduled (every 5 minutes)');
}

/** Только для тестов. */
export function resetAiResumeForTests(): void {
  running = false;
  watcherRef = null;
  if (resetTimer) clearTimeout(resetTimer);
  resetTimer = null;
}
