import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// БД-свободный тест роутера: репозитории и раннер замоканы, аутентификация —
// подставной мидлвар с нужным req.user (apiKeyAuth проверяется в своих тестах).
const runner = vi.hoisted(() => {
  class GoldenRunBusyError extends Error {
    constructor(public runId: number) { super('Прогон эталонов уже идёт'); }
  }
  class GoldenRunConfigError extends Error {}
  return {
    startGoldenRun: vi.fn(),
    activeGoldenRunId: vi.fn(),
    reconcileInterruptedGoldenRuns: vi.fn(),
    GoldenRunBusyError,
    GoldenRunConfigError,
  };
});

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/database/db', () => ({
  getDb: () => { throw new Error('роут эталонов не должен ходить в БД мимо репозиториев'); },
}));
vi.mock('../../src/database/repositories/userRepo', () => ({ userRepo: {} }));
vi.mock('../../src/database/repositories/invoiceRepo', () => ({
  invoiceRepo: { getById: vi.fn() },
}));
vi.mock('../../src/database/repositories/goldenRepo', () => ({
  GOLDEN_RUN_MAX_INVOICES: 50,
  goldenRepo: {
    setGolden: vi.fn(),
    getGoldenState: vi.fn(),
    listGoldenInvoiceIds: vi.fn(),
    countGolden: vi.fn(),
    listRuns: vi.fn(),
    getRun: vi.fn(),
  },
}));
vi.mock('../../src/golden/goldenRunner', () => runner);

import goldenRouter from '../../src/api/routes/golden';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';
import { goldenRepo } from '../../src/database/repositories/goldenRepo';

const repo = vi.mocked(invoiceRepo);
const golden = vi.mocked(goldenRepo);

const ADMIN = { id: 1, username: 'admin', role: 'admin' };
const USER = { id: 2, username: 'user', role: 'user' };

function appAs(user: { id: number; username: string; role: string }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use('/api/golden', goldenRouter);
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  runner.activeGoldenRunId.mockReturnValue(null);
  runner.reconcileInterruptedGoldenRuns.mockResolvedValue(0);
  runner.startGoldenRun.mockResolvedValue({ runId: 77, model: 'claude-sonnet-5' });
  golden.setGolden.mockResolvedValue();
  golden.getGoldenState.mockResolvedValue({ golden: true, golden_at: '2026-09-29 10:00:00' });
  golden.listGoldenInvoiceIds.mockResolvedValue([10, 11]);
  golden.countGolden.mockResolvedValue(2);
  golden.listRuns.mockResolvedValue([]);
});

describe('PATCH /api/golden/invoices/:id', () => {
  it('владелец отмечает свою накладную', async () => {
    repo.getById.mockResolvedValue({ id: 10, owner_user_id: 2 } as never);
    const res = await request(appAs(USER)).patch('/api/golden/invoices/10').send({ golden: true });
    expect(res.status).toBe(200);
    expect(golden.setGolden).toHaveBeenCalledWith(10, true);
    expect(res.body.data).toEqual({ id: 10, golden: true, golden_at: '2026-09-29 10:00:00' });
  });

  it('снятие отметки', async () => {
    repo.getById.mockResolvedValue({ id: 10, owner_user_id: 2 } as never);
    golden.getGoldenState.mockResolvedValue({ golden: false, golden_at: null });
    const res = await request(appAs(USER)).patch('/api/golden/invoices/10').send({ golden: false });
    expect(res.status).toBe(200);
    expect(golden.setGolden).toHaveBeenCalledWith(10, false);
    expect(res.body.data.golden).toBe(false);
  });

  it('чужая накладная → 404 (и для админа тоже), флаг не меняется', async () => {
    repo.getById.mockResolvedValue({ id: 10, owner_user_id: 3 } as never);
    for (const who of [USER, ADMIN]) {
      const res = await request(appAs(who)).patch('/api/golden/invoices/10').send({ golden: true });
      expect(res.status).toBe(404);
    }
    expect(golden.setGolden).not.toHaveBeenCalled();
  });

  it('нет такой накладной → 404', async () => {
    repo.getById.mockResolvedValue(undefined as never);
    const res = await request(appAs(USER)).patch('/api/golden/invoices/999').send({ golden: true });
    expect(res.status).toBe(404);
  });

  it('накладная из XML эталоном не отмечается (распознавания нет) → 409; снять можно', async () => {
    repo.getById.mockResolvedValue({ id: 10, owner_user_id: 2, ocr_engine: 'xml_upd', file_name: 'upload-1.xml' } as never);
    const res = await request(appAs(USER)).patch('/api/golden/invoices/10').send({ golden: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('XML');
    expect(golden.setGolden).not.toHaveBeenCalled();
    golden.getGoldenState.mockResolvedValue({ golden: false, golden_at: null });
    const off = await request(appAs(USER)).patch('/api/golden/invoices/10').send({ golden: false });
    expect(off.status).toBe(200);
    expect(golden.setGolden).toHaveBeenCalledWith(10, false);
  });

  it('golden не boolean или кривой id → 400', async () => {
    repo.getById.mockResolvedValue({ id: 10, owner_user_id: 2 } as never);
    expect((await request(appAs(USER)).patch('/api/golden/invoices/10').send({ golden: 'yes' })).status).toBe(400);
    expect((await request(appAs(USER)).patch('/api/golden/invoices/10').send({})).status).toBe(400);
    expect((await request(appAs(USER)).patch('/api/golden/invoices/abc').send({ golden: true })).status).toBe(400);
    expect(golden.setGolden).not.toHaveBeenCalled();
  });
});

describe('POST /api/golden/run', () => {
  it('не админ → 403, прогон не запускается', async () => {
    const res = await request(appAs(USER)).post('/api/golden/run').send({});
    expect(res.status).toBe(403);
    expect(runner.startGoldenRun).not.toHaveBeenCalled();
  });

  it('админ → 202 {run_id}, только свои эталоны, лимит по умолчанию 10', async () => {
    const res = await request(appAs(ADMIN)).post('/api/golden/run').send({});
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ run_id: 77, invoice_count: 2, model: 'claude-sonnet-5' });
    expect(golden.listGoldenInvoiceIds).toHaveBeenCalledWith(1, { limit: 10, invoiceIds: null });
    expect(runner.startGoldenRun).toHaveBeenCalledWith({ ownerUserId: 1, startedBy: 1, invoiceIds: [10, 11] });
    expect(runner.reconcileInterruptedGoldenRuns).toHaveBeenCalled();
  });

  it('limit больше 50 прижимается к 50, invoice_ids передаются на фильтр владельца', async () => {
    await request(appAs(ADMIN)).post('/api/golden/run').send({ limit: 999, invoice_ids: [10, 12] });
    expect(golden.listGoldenInvoiceIds).toHaveBeenCalledWith(1, { limit: 50, invoiceIds: [10, 12] });
  });

  it('кривые limit / invoice_ids → 400', async () => {
    const app = appAs(ADMIN);
    expect((await request(app).post('/api/golden/run').send({ limit: 'abc' })).status).toBe(400);
    expect((await request(app).post('/api/golden/run').send({ limit: 0 })).status).toBe(400);
    expect((await request(app).post('/api/golden/run').send({ invoice_ids: 'all' })).status).toBe(400);
    expect((await request(app).post('/api/golden/run').send({ invoice_ids: [1, -2] })).status).toBe(400);
    expect((await request(app).post('/api/golden/run').send({ invoice_ids: [1.5] })).status).toBe(400);
    expect(runner.startGoldenRun).not.toHaveBeenCalled();
  });

  it('эталонов нет → 400 с подсказкой', async () => {
    golden.listGoldenInvoiceIds.mockResolvedValue([]);
    const res = await request(appAs(ADMIN)).post('/api/golden/run').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('В эталоны');
    expect(runner.startGoldenRun).not.toHaveBeenCalled();
  });

  it('прогон уже идёт → 409 с его id', async () => {
    runner.activeGoldenRunId.mockReturnValue(5);
    const res = await request(appAs(ADMIN)).post('/api/golden/run').send({});
    expect(res.status).toBe(409);
    expect(res.body.run_id).toBe(5);
    expect(runner.startGoldenRun).not.toHaveBeenCalled();
  });

  it('гонка двух кликов: раннер отказал → 409; нет ключа → 400', async () => {
    runner.startGoldenRun.mockRejectedValueOnce(new runner.GoldenRunBusyError(8));
    const busy = await request(appAs(ADMIN)).post('/api/golden/run').send({});
    expect(busy.status).toBe(409);
    expect(busy.body.run_id).toBe(8);

    runner.startGoldenRun.mockRejectedValueOnce(new runner.GoldenRunConfigError('Не задан API-ключ Anthropic'));
    const noKey = await request(appAs(ADMIN)).post('/api/golden/run').send({});
    expect(noKey.status).toBe(400);
    expect(noKey.body.error).toContain('API-ключ');
  });
});

describe('GET /api/golden/runs и /runs/:id', () => {
  it('не админ → 403 (карточка в настройках не рисуется)', async () => {
    expect((await request(appAs(USER)).get('/api/golden/runs')).status).toBe(403);
    expect((await request(appAs(USER)).get('/api/golden/runs/1')).status).toBe(403);
  });

  it('список — только свои прогоны, summary разобран из JSON', async () => {
    golden.listRuns.mockResolvedValue([{
      id: 3, owner_user_id: 1, started_by: 1, started_at: '2026-09-29 10:00:00', finished_at: null,
      status: 'running', model: 'claude-sonnet-5', summary: '{"planned":2,"processed":1}',
    }]);
    runner.activeGoldenRunId.mockReturnValue(3);
    const res = await request(appAs(ADMIN)).get('/api/golden/runs');
    expect(res.status).toBe(200);
    expect(golden.listRuns).toHaveBeenCalledWith(1, 20);
    expect(res.body).toEqual({
      data: [{
        id: 3, started_at: '2026-09-29 10:00:00', finished_at: null, status: 'running',
        model: 'claude-sonnet-5', summary: { planned: 2, processed: 1 },
      }],
      golden_count: 2,
      active_run_id: 3,
    });
  });

  it('детали: свой прогон — с результатами; чужой или несуществующий → 404', async () => {
    golden.getRun.mockResolvedValue({
      id: 3, owner_user_id: 1, started_by: 1, started_at: 's', finished_at: 'f', status: 'done',
      model: 'm', summary: '{"ok":1}', results: '[{"invoice_id":10,"status":"ok"}]',
    });
    const own = await request(appAs(ADMIN)).get('/api/golden/runs/3');
    expect(own.status).toBe(200);
    expect(own.body.data.results).toEqual([{ invoice_id: 10, status: 'ok' }]);
    expect(own.body.data.summary).toEqual({ ok: 1 });

    const otherAdmin = { id: 9, username: 'a2', role: 'admin' };
    expect((await request(appAs(otherAdmin)).get('/api/golden/runs/3')).status).toBe(404);

    golden.getRun.mockResolvedValue(undefined);
    expect((await request(appAs(ADMIN)).get('/api/golden/runs/4')).status).toBe(404);
    expect((await request(appAs(ADMIN)).get('/api/golden/runs/x')).status).toBe(400);
  });
});
