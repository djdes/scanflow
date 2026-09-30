import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// БД-свободный тест роутера «Аналитика»: сервисы замоканы, проверяем область
// компании (owner = req.user.id), разбор периода и guid, коды ответов.
vi.mock('../../src/database/db', () => ({
  getDb: () => { throw new Error('роут аналитики не должен ходить в БД мимо сервисов'); },
}));
vi.mock('../../src/services/analyticsQuality', () => ({ getSupplierQuality: vi.fn() }));
vi.mock('../../src/services/analyticsPrices', () => ({
  getPriceOverview: vi.fn(),
  getPriceItemDetail: vi.fn(),
}));

import analyticsRouter from '../../src/api/routes/analytics';
import { getSupplierQuality } from '../../src/services/analyticsQuality';
import { getPriceItemDetail, getPriceOverview } from '../../src/services/analyticsPrices';

const quality = vi.mocked(getSupplierQuality);
const overview = vi.mocked(getPriceOverview);
const detail = vi.mocked(getPriceItemDetail);

function app(user: { id: number; username: string; role: string } | null = { id: 2, username: 'u', role: 'user' }) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { if (user) req.user = user; next(); });
  a.use('/api/analytics', analyticsRouter);
  a.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  quality.mockResolvedValue({ suppliers: [], totals: {} } as never);
  overview.mockResolvedValue({ items: [], totals: {} } as never);
  detail.mockResolvedValue({ item: { guid: 'g-1' } } as never);
});

describe('GET /api/analytics/suppliers', () => {
  it('по умолчанию 90 дней, только компания вызывающего', async () => {
    const res = await request(app()).get('/api/analytics/suppliers');
    expect(res.status).toBe(200);
    expect(quality).toHaveBeenCalledWith(2, 90);
    expect(res.body).toEqual({ data: { suppliers: [], totals: {} } });
  });

  it('админ видит тоже только свою компанию', async () => {
    await request(app({ id: 1, username: 'admin', role: 'admin' })).get('/api/analytics/suppliers?days=30');
    expect(quality).toHaveBeenCalledWith(1, 30);
  });

  it('недопустимый период → 400, сервис не вызывается', async () => {
    for (const q of ['?days=7', '?days=abc', '?days=30&days=90']) {
      const res = await request(app()).get(`/api/analytics/suppliers${q}`);
      expect(res.status).toBe(400);
    }
    expect(quality).not.toHaveBeenCalled();
  });

  it('без пользователя → 401', async () => {
    const res = await request(app(null)).get('/api/analytics/suppliers');
    expect(res.status).toBe(401);
    expect(quality).not.toHaveBeenCalled();
  });
});

describe('GET /api/analytics/prices', () => {
  it('сводка по позициям за выбранный период', async () => {
    const res = await request(app()).get('/api/analytics/prices?days=180');
    expect(res.status).toBe(200);
    expect(overview).toHaveBeenCalledWith(2, 180, expect.any(Date), '');
    expect(res.body.data).toEqual({ items: [], totals: {} });
  });

  it('поиск по позиции — строкой, обрезанной и не длиннее 100 символов', async () => {
    await request(app()).get(`/api/analytics/prices?q=${encodeURIComponent('  молоко  ')}`);
    expect(overview).toHaveBeenLastCalledWith(2, 90, expect.any(Date), 'молоко');
    await request(app()).get(`/api/analytics/prices?q=${'я'.repeat(150)}`);
    expect(String(overview.mock.lastCall?.[3]).length).toBe(100);
  });

  it('поиск не строкой → 400', async () => {
    const res = await request(app()).get('/api/analytics/prices?q=a&q=b');
    expect(res.status).toBe(400);
    expect(overview).not.toHaveBeenCalled();
  });

  it('недопустимый период → 400', async () => {
    expect((await request(app()).get('/api/analytics/prices?days=45')).status).toBe(400);
    expect(overview).not.toHaveBeenCalled();
  });
});

describe('GET /api/analytics/prices/:guid', () => {
  it('позиция компании вызывающего', async () => {
    const guid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    const res = await request(app()).get(`/api/analytics/prices/${guid}?days=365`);
    expect(res.status).toBe(200);
    expect(detail).toHaveBeenCalledWith(2, guid, 365);
    expect(res.body.data.item.guid).toBe('g-1');
  });

  it('закупок нет (или позиция чужая) → 404', async () => {
    detail.mockResolvedValue(null);
    const res = await request(app()).get('/api/analytics/prices/g-2');
    expect(res.status).toBe(404);
    expect(detail).toHaveBeenCalledWith(2, 'g-2', 90);
  });

  it('мусорный guid → 400', async () => {
    expect((await request(app()).get(`/api/analytics/prices/${'a'.repeat(65)}`)).status).toBe(400);
    expect((await request(app()).get('/api/analytics/prices/a%20b')).status).toBe(400);
    expect(detail).not.toHaveBeenCalled();
  });

  it('ошибка сервиса уходит в общий обработчик (500), а не роняет процесс', async () => {
    detail.mockRejectedValue(new Error('db down'));
    const res = await request(app()).get('/api/analytics/prices/g-3');
    expect(res.status).toBe(500);
  });
});
