import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  startQueueJob,
  queueJobStatus,
  cancelQueueJob,
  activeQueueJob,
  assertQueueJobFree,
  resetQueueJobsForTests,
  QueueJobBusyError,
  resumePausedQueueJobs,
} from '../../src/services/queueJobs';
import { AiUnavailableError } from '../../src/ai/errors';

vi.mock('../../src/services/aiOutage', () => ({ reportAiOutage: vi.fn(async () => {}) }));

// Фоновые задачи «Очереди в 1С»: одна на сервер, накладные строго по одной.

beforeEach(() => resetQueueJobsForTests());

describe('startQueueJob', () => {
  it('накладные — строго по одной; ошибка одной не останавливает задачу', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const worker = vi.fn(async (id: number) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 3));
      inFlight--;
      if (id === 2) throw new Error('Claude API error: 529');
      return { invoice_id: id, status: 'done' };
    });
    const { job, done } = startQueueJob({ kind: 'reocr', ownerUserId: 1, startedBy: 1, invoiceIds: [1, 2, 3], worker });
    expect(activeQueueJob()).toBe(job);
    await done;
    expect(maxInFlight).toBe(1);
    expect(worker.mock.calls.map(c => c[0])).toEqual([1, 2, 3]);
    expect(job.status).toBe('done');
    expect(job.results).toEqual([
      { invoice_id: 1, status: 'done' },
      { invoice_id: 2, status: 'error', error: 'Claude API error: 529' },
      { invoice_id: 3, status: 'done' },
    ]);
    expect(activeQueueJob()).toBeNull();
  });

  it('одна задача на сервер — любого вида и любой компании', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const { done } = startQueueJob({
      kind: 'reocr', ownerUserId: 1, startedBy: 1, invoiceIds: [1],
      worker: async (id) => { await gate; return { invoice_id: id, status: 'done' }; },
    });
    const other = () => startQueueJob({ kind: 'llm_map', ownerUserId: 1, startedBy: 1, invoiceIds: [5], worker: async (id) => ({ invoice_id: id, status: 'ok' }) });
    expect(other).toThrow(QueueJobBusyError);
    try { other(); } catch (e) { expect((e as QueueJobBusyError).own).toBe(true); expect((e as QueueJobBusyError).kind).toBe('reocr'); }
    try { assertQueueJobFree(2); } catch (e) { expect((e as QueueJobBusyError).own).toBe(false); }
    release();
    await done;
    expect(() => assertQueueJobFree(2)).not.toThrow();
  });

  it('«Остановить» — после текущей накладной; статус cancelled', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const worker = vi.fn(async (id: number) => { if (id === 1) await gate; return { invoice_id: id, status: 'done' }; });
    const { job, done } = startQueueJob({ kind: 'reocr', ownerUserId: 1, startedBy: 1, invoiceIds: [1, 2, 3], worker });
    expect(cancelQueueJob(2, 'reocr')).toBe(false); // чужая компания не может
    expect(cancelQueueJob(1, 'llm_map')).toBe(false); // не тот вид
    expect(cancelQueueJob(1, 'reocr')).toBe(true);
    release();
    await done;
    expect(worker).toHaveBeenCalledTimes(1);
    expect(job.status).toBe('cancelled');
    expect(job.processed).toBe(1);
  });
});

describe('queueJobStatus — изоляция', () => {
  it('подробности видит только своя компания; другой — только «сервер занят»', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const { done } = startQueueJob({
      kind: 'reocr', ownerUserId: 1, startedBy: 1, invoiceIds: [7, 8],
      meta: { model: 'claude-sonnet-5' },
      worker: async (id) => { await gate; return { invoice_id: id, status: 'done' }; },
    });

    const own = queueJobStatus(1, 'reocr');
    expect(own.busy).toBeNull();
    expect(own.job).toMatchObject({ kind: 'reocr', status: 'running', planned: 2, processed: 0, current_invoice_id: 7, meta: { model: 'claude-sonnet-5' } });

    const foreign = queueJobStatus(2, 'reocr');
    expect(foreign.job).toBeNull();
    expect(foreign.busy).toEqual({ kind: 'reocr', own: false });

    const ownOtherKind = queueJobStatus(1, 'llm_map');
    expect(ownOtherKind.job).toBeNull();
    expect(ownOtherKind.busy).toEqual({ kind: 'reocr', own: true });

    release();
    await done;
    const finished = queueJobStatus(1, 'reocr');
    expect(finished.busy).toBeNull();
    expect(finished.job).toMatchObject({ status: 'done', processed: 2, counts: { done: 2 }, current_invoice_id: null });
    expect(queueJobStatus(2, 'reocr')).toEqual({ job: null, busy: null });
  });
});

describe('пауза при недоступной модели', () => {
  it('AiUnavailableError → status paused с причиной; продолжение — с оставшихся накладных', async () => {
    const worker = vi.fn(async (id: number) => {
      if (id === 8) throw new AiUnavailableError('rate_limited', null);
      return { invoice_id: id, status: 'done' };
    });
    const resume = vi.fn(async () => undefined);
    const { done } = startQueueJob({ kind: 'reocr', ownerUserId: 1, startedBy: 1, invoiceIds: [7, 8, 9], worker, resume });
    await done;

    const view = queueJobStatus(1, 'reocr').job;
    expect(view).toMatchObject({ status: 'paused', processed: 1 });
    expect(view?.error).toContain('Лимит подписки ChatGPT');
    expect(worker).toHaveBeenCalledTimes(2); // 9-я не трогалась
    expect(activeQueueJob()).toBeNull();

    expect(await resumePausedQueueJobs()).toBe(true);
    expect(resume).toHaveBeenCalledWith([8, 9]);
    expect(await resumePausedQueueJobs()).toBe(false); // продолжается один раз
  });

  it('«Остановить» задачу на паузе — продолжения не будет', async () => {
    const resume = vi.fn(async () => undefined);
    const { done } = startQueueJob({
      kind: 'llm_map', ownerUserId: 2, startedBy: 2, invoiceIds: [1],
      worker: async () => { throw new AiUnavailableError('network', null); }, resume,
    });
    await done;
    expect(cancelQueueJob(2, 'llm_map')).toBe(true);
    expect(queueJobStatus(2, 'llm_map').job?.status).toBe('cancelled');
    expect(await resumePausedQueueJobs()).toBe(false);
    expect(resume).not.toHaveBeenCalled();
  });
});
