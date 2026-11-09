import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

// POST /api/sber/access-token — выдача действующего токена Сбера для SUBEX.
// Роутер монтируется без БД: репозиторий и OAuth подменены.
const h = vi.hoisted(() => ({ getValid: vi.fn(), getRow: vi.fn() }));

vi.mock('../../src/sber/oauth', async () => {
  const actual = await vi.importActual<typeof import('../../src/sber/oauth')>('../../src/sber/oauth');
  return { ...actual, getValidAccessToken: h.getValid };
});
vi.mock('../../src/database/repositories/sberTokenRepo', () => ({ sberTokenRepo: { get: h.getRow } }));
vi.mock('../../src/sber/appCredentials', async () => {
  const actual = await vi.importActual<typeof import('../../src/sber/appCredentials')>('../../src/sber/appCredentials');
  return { ...actual, sberClientId: () => 'client-1' };
});

import sberRouter from '../../src/api/routes/sber';
import { SberAuthError } from '../../src/sber/oauth';

function app(role: 'admin' | 'user' = 'admin') {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { (req as unknown as { user: unknown }).user = { id: 7, role }; next(); });
  a.use('/api/sber', sberRouter);
  return a;
}

describe('POST /api/sber/access-token', () => {
  beforeEach(() => {
    h.getValid.mockReset();
    h.getRow.mockReset();
    h.getRow.mockResolvedValue({
      expires_at: '2026-11-09 12:00:00', account_number: '40702810940000099835', org_name: 'ООО "БФС"',
      payer_inn: '7700000000', last_refresh_at: '2026-11-09 11:00:00', refresh_obtained_at: '2026-11-09 11:00:00',
    });
  });

  it('отдаёт токен компании текущего ключа, без кэширования', async () => {
    h.getValid.mockResolvedValue('acc-token');
    const res = await request(app()).post('/api/sber/access-token').send({});
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(h.getValid).toHaveBeenCalledWith(7, { force: false });
    expect(res.body.data).toMatchObject({
      access_token: 'acc-token', client_id: 'client-1', expires_at: '2026-11-09T12:00:00.000Z',
      account_number: '40702810940000099835', org_name: 'ООО "БФС"',
    });
    expect(res.body.data.refresh_expires_at).toMatch(/^2027-05-08/);
  });

  it('force=true — принудительное обновление (после 401 у SUBEX)', async () => {
    h.getValid.mockResolvedValue('fresh');
    await request(app()).post('/api/sber/access-token').send({ force: true });
    expect(h.getValid).toHaveBeenCalledWith(7, { force: true });
  });

  it('не подключено — 404 с кодом', async () => {
    h.getValid.mockRejectedValue(new SberAuthError('not_connected', 'Сбербанк не подключён'));
    const res = await request(app()).post('/api/sber/access-token').send({});
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Сбербанк не подключён', code: 'not_connected' });
  });

  it('Сбер отверг обновление — 502 с понятной причиной', async () => {
    h.getValid.mockRejectedValue(new SberAuthError('invalid_grant', 'Токен обновления недействителен'));
    const res = await request(app()).post('/api/sber/access-token').send({});
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('invalid_grant');
  });

  it('не админ — 403, токен не выдаётся', async () => {
    const res = await request(app('user')).post('/api/sber/access-token').send({});
    expect(res.status).toBe(403);
    expect(h.getValid).not.toHaveBeenCalled();
  });
});
