import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const h = vi.hoisted(() => ({
  state: vi.fn(),
  listWaiting: vi.fn(),
  activeJob: vi.fn(),
  resumePaused: vi.fn(),
  resumed: vi.fn(),
}));
vi.mock('../../src/ai/engine', () => ({ aiEngineState: h.state }));
vi.mock('../../src/database/repositories/invoiceRepo', () => ({
  invoiceRepo: { listWaitingAiIds: h.listWaiting, countRecognizing: vi.fn(async () => 0) },
}));
vi.mock('../../src/services/queueJobs', () => ({ activeQueueJob: h.activeJob, resumePausedQueueJobs: h.resumePaused }));
vi.mock('../../src/services/aiOutage', () => ({ reportAiResumed: h.resumed }));

import { runAiResumePass, resetAiResumeForTests } from '../../src/services/aiResume';

const available = { engine: 'gpt', model: 'gpt-6.1-sol', available: true, reason: null, retryAtMs: null, text: 'ok' };
const noIdleWait = { waitForIdle: async () => {} };

beforeEach(() => {
  vi.resetAllMocks();
  resetAiResumeForTests();
  h.state.mockResolvedValue(available);
  h.activeJob.mockReturnValue(null);
  h.resumePaused.mockResolvedValue(false);
});

describe('runAiResumePass — накладные, ждавшие GPT', () => {
  it('строго по одной, по порядку; после первой удачи — «снова работает»; потом пауза очереди', async () => {
    h.listWaiting.mockResolvedValue([3, 7, 9]);
    let inFlight = 0;
    let maxInFlight = 0;
    const order: number[] = [];
    const watcher = {
      resumeWaitingInvoice: vi.fn(async (id: number) => {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        order.push(id);
        await new Promise(r => setTimeout(r, 2));
        inFlight--;
        return 'processed' as const;
      }),
    };
    const out = await runAiResumePass(watcher, noIdleWait);
    expect(out).toEqual({ resumed: 3, stopped: false });
    expect(order).toEqual([3, 7, 9]);
    expect(maxInFlight).toBe(1);
    expect(h.resumed).toHaveBeenCalledTimes(1);
    expect(h.resumed).toHaveBeenCalledWith(3);
    expect(h.resumePaused).toHaveBeenCalledTimes(1);
  });

  it('снова «недоступна» — проход останавливается, остальные ждут, очередь не продолжается', async () => {
    h.listWaiting.mockResolvedValue([3, 7, 9]);
    const watcher = { resumeWaitingInvoice: vi.fn(async (id: number) => (id === 7 ? 'waiting' as const : 'processed' as const)) };
    const out = await runAiResumePass(watcher, noIdleWait);
    expect(out).toEqual({ resumed: 1, stopped: true });
    expect(watcher.resumeWaitingInvoice).toHaveBeenCalledTimes(2);
    expect(h.resumePaused).not.toHaveBeenCalled();
  });

  it('модель недоступна заранее — ничего не трогаем', async () => {
    h.state.mockResolvedValue({ ...available, available: false, reason: 'rate_limited', retryAtMs: Date.now() + 3_600_000 });
    const watcher = { resumeWaitingInvoice: vi.fn() };
    expect(await runAiResumePass(watcher, noIdleWait)).toEqual({ resumed: 0, stopped: true });
    expect(h.listWaiting).not.toHaveBeenCalled();
    expect(watcher.resumeWaitingInvoice).not.toHaveBeenCalled();
  });

  it('идёт задача очереди — проход не запускается (одна тяжёлая задача за раз)', async () => {
    h.activeJob.mockReturnValue({ id: 1 });
    const watcher = { resumeWaitingInvoice: vi.fn() };
    expect(await runAiResumePass(watcher, noIdleWait)).toEqual({ resumed: 0, stopped: false });
    expect(h.state).not.toHaveBeenCalled();
  });

  it('второй одновременный проход — пустой', async () => {
    h.listWaiting.mockResolvedValue([1]);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const watcher = { resumeWaitingInvoice: vi.fn(async () => { await gate; return 'processed' as const; }) };
    const first = runAiResumePass(watcher, noIdleWait);
    await vi.waitFor(() => expect(watcher.resumeWaitingInvoice).toHaveBeenCalled());
    expect(await runAiResumePass(watcher, noIdleWait)).toEqual({ resumed: 0, stopped: false });
    release();
    expect(await first).toEqual({ resumed: 1, stopped: false });
  });
});
