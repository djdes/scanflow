import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const h = vi.hoisted(() => ({ listAll: vi.fn(), countWaiting: vi.fn(), send: vi.fn(), last: vi.fn() }));
vi.mock('../../src/database/repositories/userRepo', () => ({ userRepo: { listAll: h.listAll } }));
vi.mock('../../src/database/repositories/invoiceRepo', () => ({ invoiceRepo: { countWaitingAi: h.countWaiting } }));
vi.mock('../../src/services/ownerAlerts', () => ({ sendOwnerAlert: h.send, lastOwnerAlertMs: h.last }));

import { reportAiOutage, reportAiResumed } from '../../src/services/aiOutage';
import { AiUnavailableError } from '../../src/ai/errors';

beforeEach(() => {
  vi.resetAllMocks();
  h.listAll.mockResolvedValue([{ id: 1, role: 'admin' }, { id: 2, role: 'user' }, { id: 3, role: 'admin' }]);
  h.countWaiting.mockResolvedValue(4);
  h.send.mockResolvedValue(true);
});

describe('reportAiOutage', () => {
  it('всем админам, не чаще раза в 6 часов, с причиной и числом ждущих', async () => {
    await reportAiOutage(new AiUnavailableError('reauth_required', null));
    expect(h.send).toHaveBeenCalledTimes(2);
    for (const call of h.send.mock.calls) {
      expect([1, 3]).toContain(call[0]);
      expect(call[1]).toBe('ai_unavailable');
      expect(call[2]).toContain('ChatGPT просит войти заново');
      expect(call[2]).toContain('Ждут распознавания: 4');
      expect(call[3]).toBe(6);
    }
  });

  it('никогда не бросает', async () => {
    h.listAll.mockRejectedValue(new Error('db down'));
    await expect(reportAiOutage(new AiUnavailableError('network', null))).resolves.toBeUndefined();
  });
});

describe('reportAiResumed', () => {
  it('только после «остановился» и один раз', async () => {
    // админ 1: «остановился» в 10:00, «снова работает» ещё не было → шлём;
    // админ 3: «остановился» не было вовсе → молчим.
    h.last.mockImplementation(async (id: number, kind: string) => (id === 1 && kind === 'ai_unavailable' ? 1000 : null));
    await reportAiResumed(4);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0]).toEqual([1, 'ai_resumed', expect.stringContaining('GPT снова работает'), 0]);
  });

  it('«снова работает» уже было после «остановился» — повторно не шлём', async () => {
    h.last.mockImplementation(async (_id: number, kind: string) => (kind === 'ai_unavailable' ? 1000 : 2000));
    await reportAiResumed(1);
    expect(h.send).not.toHaveBeenCalled();
  });
});
