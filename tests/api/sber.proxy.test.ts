import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

// POST /api/sber/proxy — запросы SUBEX в Sber API токеном и сертификатом ScanFlow.
const h = vi.hoisted(() => ({ fetch: vi.fn(), token: vi.fn() }));

vi.mock('../../src/sber/sberClient', () => ({ sberFetch: h.fetch }));
vi.mock('../../src/sber/oauth', async () => {
  const actual = await vi.importActual<typeof import('../../src/sber/oauth')>('../../src/sber/oauth');
  const { SberApiError } = await vi.importActual<typeof import('../../src/sber/payments')>('../../src/sber/payments');
  // withSberToken: как настоящий — на 401 просит свежий токен и повторяет один раз.
  return {
    ...actual,
    withSberToken: async (owner: number, fn: (t: string) => Promise<unknown>) => {
      try { return await fn(await h.token(owner, false)); } catch (err) {
        if (err instanceof SberApiError && err.status === 401) return fn(await h.token(owner, true));
        throw err;
      }
    },
  };
});

import sberRouter from '../../src/api/routes/sber';
import { checkProxyRequest, SberProxyDenied } from '../../src/sber/proxy';

function app(role: 'admin' | 'user' = 'admin') {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { (req as unknown as { user: unknown }).user = { id: 7, role }; next(); });
  a.use('/api/sber', sberRouter);
  return a;
}

const ok = (body: unknown, status = 200) => ({ status, ok: status < 300, body: JSON.stringify(body), json: () => body });

describe('POST /api/sber/proxy', () => {
  beforeEach(() => {
    h.fetch.mockReset();
    h.token.mockReset();
    h.token.mockImplementation(async (_o: number, force: boolean) => (force ? 'fresh' : 'tok'));
  });

  it('выписка: запрос токеном ScanFlow, ответ банка как есть', async () => {
    h.fetch.mockResolvedValue(ok({ transactions: [] }));
    const res = await request(app()).post('/api/sber/proxy').send({
      method: 'GET', path: '/fintech/api/v2/statement/transactions',
      query: { accountNumber: '40702810940000099835', statementDate: '2026-11-09', page: 1 },
    });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data).toEqual({ status: 200, body: '{"transactions":[]}' });
    const [url, opts] = h.fetch.mock.calls[0];
    expect(url).toBe('https://fintech.sberbank.ru:9443/fintech/api/v2/statement/transactions?accountNumber=40702810940000099835&statementDate=2026-11-09&page=1');
    expect(opts.headers.Authorization).toBe('tok');
    expect(h.token).toHaveBeenCalledWith(7, false);
  });

  it('401 от банка — свежий токен и повтор', async () => {
    h.fetch.mockResolvedValueOnce(ok({}, 401)).mockResolvedValueOnce(ok({ accounts: [] }));
    const res = await request(app()).post('/api/sber/proxy').send({ method: 'GET', path: '/fintech/api/v1/client-info' });
    expect(res.body.data.status).toBe(200);
    expect(h.fetch.mock.calls[1][1].headers.Authorization).toBe('fresh');
  });

  it('платёжка-черновик: POST с телом', async () => {
    h.fetch.mockResolvedValue(ok({ externalId: 'e1', bankStatus: 'CREATED' }, 201));
    const res = await request(app()).post('/api/sber/proxy').send({ method: 'POST', path: '/fintech/api/v1/payments', body: { amount: 10 } });
    expect(res.body.data.status).toBe(201);
    expect(h.fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', body: '{"amount":10}' });
  });

  it('вне белого списка — 400, в банк не ходим', async () => {
    const res = await request(app()).post('/api/sber/proxy').send({ method: 'POST', path: '/fintech/api/v1/payments/abc/sign' });
    expect(res.status).toBe(400);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('не админ — 403', async () => {
    const res = await request(app('user')).post('/api/sber/proxy').send({ method: 'GET', path: '/fintech/api/v1/client-info' });
    expect(res.status).toBe(403);
  });
});

describe('checkProxyRequest', () => {
  it('не пускает обход пути и чужие параметры', () => {
    expect(() => checkProxyRequest({ method: 'GET', path: '/fintech/api/v1/client-info/../x' })).toThrow(SberProxyDenied);
    expect(() => checkProxyRequest({ method: 'DELETE', path: '/fintech/api/v1/payments' })).toThrow(SberProxyDenied);
    expect(() => checkProxyRequest({ method: 'GET', path: '/fintech/api/v1/client-info', query: { 'a&b': 1 } })).toThrow(SberProxyDenied);
    expect(checkProxyRequest({ method: 'get', path: '/fintech/api/v1/payments/ab-12/state' }).method).toBe('GET');
  });
});
