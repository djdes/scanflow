import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// Запись в api_requests_log замокана: проверяем только, какие запросы пишутся.
const run = vi.fn(async () => ({ changes: 1, lastInsertRowid: 1 }));
vi.mock('../../src/database/db', () => ({
  getDb: () => ({ prepare: () => ({ run }) }),
}));

import { apiRequestLog, shouldLogRequest } from '../../src/api/middleware/requestLog';

async function hit(method: string, url: string): Promise<void> {
  const req = {
    method,
    path: url.split('?')[0],
    originalUrl: url,
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  };
  const res = Object.assign(new EventEmitter(), { statusCode: 200 });
  const next = vi.fn();
  apiRequestLog(req as never, res as never, next);
  expect(next).toHaveBeenCalledOnce();
  res.emit('finish');
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('api_requests_log: что пишется (п.20)', () => {
  beforeEach(() => { run.mockClear(); });

  it('GET …/sync-flag не пишется — 1С опрашивает его раз в минуту', async () => {
    await hit('GET', '/api/onec/exchange/nomenclature/sync-flag');
    await hit('GET', '/api/integrations/sync-flag?x=1');
    expect(run).not.toHaveBeenCalled();
  });

  it('/pending пишется: по нему считается last1cPollAt', async () => {
    await hit('GET', '/api/invoices/pending?limit=10');
    expect(run).toHaveBeenCalledOnce();
    expect((run.mock.calls[0] as unknown[]).slice(0, 2)).toEqual(['GET', '/api/invoices/pending']);
  });

  it('сброс флага (POST …/sync-flag/clear) по-прежнему пишется', () => {
    expect(shouldLogRequest('POST', '/api/onec/exchange/nomenclature/sync-flag/clear')).toBe(true);
    expect(shouldLogRequest('POST', '/api/integrations/sync-flag')).toBe(true);
    expect(shouldLogRequest('GET', '/api/onec/exchange/nomenclature/sync-flag/')).toBe(false);
  });
});
