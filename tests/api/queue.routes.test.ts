import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// БД-свободный тест роутера «Очередь в 1С»: сборка страницы, запуск задач и
// замена строк замоканы, аутентификация — подставной мидлвар с нужным req.user.

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/database/db', () => ({
  getDb: () => { throw new Error('роут очереди не должен ходить в БД мимо репозиториев'); },
}));
vi.mock('../../src/database/repositories/userRepo', () => ({ userRepo: {} }));
vi.mock('../../src/database/repositories/invoiceRepo', () => ({
  invoiceRepo: { getById: vi.fn(), setRead: vi.fn() },
}));
vi.mock('../../src/database/repositories/queueRepo', () => ({
  queueRepo: { invoiceLines: vi.fn(), latestReocr: vi.fn() },
}));
vi.mock('../../src/services/queueList', () => ({
  loadQueueList: vi.fn(),
  loadQueueCard: vi.fn(),
}));
vi.mock('../../src/services/queueReocr', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/services/queueReocr')>();
  return {
    ...orig,
    startQueueReocr: vi.fn(),
    applyQueueReocr: vi.fn(),
    revertQueueReocr: vi.fn(),
    reconcileInterruptedReocr: vi.fn(async () => 0),
  };
});
vi.mock('../../src/services/queueLlmMap', () => ({ startQueueLlmMap: vi.fn() }));

import queueRouter, { setMapper } from '../../src/api/routes/queue';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';
import { queueRepo } from '../../src/database/repositories/queueRepo';
import { loadQueueList, loadQueueCard } from '../../src/services/queueList';
import {
  startQueueReocr, applyQueueReocr, revertQueueReocr, reconcileInterruptedReocr, ReocrApplyError, linesFingerprint,
} from '../../src/services/queueReocr';
import { startQueueLlmMap } from '../../src/services/queueLlmMap';
import { QueueJobBusyError, QueueStartError, resetQueueJobsForTests } from '../../src/services/queueJobs';

const repo = vi.mocked(invoiceRepo);
const qrepo = vi.mocked(queueRepo);

const USER = { id: 2, username: 'user', role: 'user' };

function appAs(user: { id: number; username: string; role: string } | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  app.use('/api/queue', queueRouter);
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

function inv(p: Record<string, unknown> = {}) {
  return {
    id: 10, owner_user_id: 2, status: 'processed', approved_for_1c: 0, sent_at: null, duplicate_of: null,
    invoice_number: '12', invoice_date: '2026-09-15', supplier: 'ООО Ромашка', supplier_inn: '7724357632',
    total_sum: 1200, vat_sum: 109.09, items_total_mismatch: 0, created_at: '2026-09-16 10:00:00',
    file_name: 'photo-10.jpg', file_path: null, read_at: null,
    ...p,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetQueueJobsForTests();
  setMapper({ map: vi.fn(), mapSupplierOverride: vi.fn() } as never);
  qrepo.latestReocr.mockResolvedValue(undefined);
});

describe('GET /api/queue', () => {
  it('очередь только своей компании; оборванные перезапуском прогоны закрываются до показа', async () => {
    vi.mocked(loadQueueList).mockResolvedValue({ data: [], summary: { count: 0 }, jobs: {} } as never);
    const res = await request(appAs(USER)).get('/api/queue');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], summary: { count: 0 }, jobs: {} });
    expect(loadQueueList).toHaveBeenCalledWith(2);
    expect(reconcileInterruptedReocr).toHaveBeenCalledWith(2);
  });

  it('без пользователя → 401', async () => {
    expect((await request(appAs(null)).get('/api/queue')).status).toBe(401);
    expect(loadQueueList).not.toHaveBeenCalled();
  });
});

describe('GET /api/queue/:id', () => {
  it('чужая, несуществующая, кривой id → 404 без утечки', async () => {
    repo.getById.mockResolvedValueOnce(inv({ owner_user_id: 3 }) as never);
    expect((await request(appAs(USER)).get('/api/queue/10')).status).toBe(404);
    repo.getById.mockResolvedValueOnce(undefined as never);
    expect((await request(appAs(USER)).get('/api/queue/10')).status).toBe(404);
    expect((await request(appAs(USER)).get('/api/queue/abc')).status).toBe(404);
    expect((await request(appAs(USER)).get('/api/queue/1e3')).status).toBe(404);
    expect(loadQueueCard).not.toHaveBeenCalled();
    expect(repo.setRead).not.toHaveBeenCalled();
  });

  it('своя: карточка очереди; открытие = прочитано', async () => {
    repo.getById.mockResolvedValue(inv() as never);
    vi.mocked(loadQueueCard).mockResolvedValue({ workable: true } as never);
    const res = await request(appAs(USER)).get('/api/queue/10');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { workable: true } });
    expect(repo.setRead).toHaveBeenCalledWith(10, true);
    expect(vi.mocked(loadQueueCard).mock.calls[0][0]).toBe(2);
    expect(vi.mocked(loadQueueCard).mock.calls[0][1]).toMatchObject({ id: 10 });
  });

  it('GET /:id/reocr — сравнение с текущими строками; одобренную применить нельзя', async () => {
    const lines = [{ id: 1, original_name: 'Батон', mapped_name: 'Батон', onec_guid: null, quantity: 1, unit: 'шт', price: 10, total: 10, vat_rate: 10 }];
    repo.getById.mockResolvedValue(inv({ approved_for_1c: 1 }) as never);
    qrepo.invoiceLines.mockResolvedValue(lines as never);
    qrepo.latestReocr.mockResolvedValue({
      id: 5, owner_user_id: 2, invoice_id: 10, status: 'done', model: 'm', pages: 1, lines_fingerprint: linesFingerprint(lines as never),
      summary: null, header_diff: '[]', proposed: JSON.stringify([{ ...lines[0], quantity: 2, total: 20, conversion: {} }]),
      replaced: null, error: null, started_by: 2, started_at: '', finished_at: '', applied_at: null, applied_by: null,
    } as never);
    const res = await request(appAs(USER)).get('/api/queue/10/reocr');
    expect(res.status).toBe(200);
    expect(qrepo.invoiceLines).toHaveBeenCalledWith(2, 10);
    expect(res.body.data).toMatchObject({ id: 5, can_apply: false, fingerprint: linesFingerprint(lines as never) });
    expect(res.body.data.diff.rows[0].fields).toEqual(['quantity', 'total']);
  });
});

describe('POST /api/queue/:id/reocr/apply и /revert', () => {
  const FP = 'a'.repeat(64);

  for (const [path, action] of [['apply', applyQueueReocr], ['revert', revertQueueReocr]] as const) {
    it(`${path}: без отпечатка строк → 400; чужая → 404, действие не зовётся`, async () => {
      repo.getById.mockResolvedValue(inv() as never);
      expect((await request(appAs(USER)).post(`/api/queue/10/reocr/${path}`).send({})).status).toBe(400);
      expect((await request(appAs(USER)).post(`/api/queue/10/reocr/${path}`).send({ fingerprint: 'XYZ' })).status).toBe(400);
      repo.getById.mockResolvedValue(inv({ owner_user_id: 3 }) as never);
      expect((await request(appAs(USER)).post(`/api/queue/10/reocr/${path}`).send({ fingerprint: FP })).status).toBe(404);
      expect(action).not.toHaveBeenCalled();
    });

    it(`${path}: конфликт сервиса → его статус и код; успех — владелец и автор из сессии`, async () => {
      repo.getById.mockResolvedValue(inv() as never);
      vi.mocked(action).mockRejectedValueOnce(new ReocrApplyError(409, 'stale', 'Строки изменились'));
      const conflict = await request(appAs(USER)).post(`/api/queue/10/reocr/${path}`).send({ fingerprint: FP });
      expect(conflict.status).toBe(409);
      expect(conflict.body).toEqual({ error: 'Строки изменились', code: 'stale' });

      vi.mocked(action).mockResolvedValueOnce({ deleted: 3, inserted: 4, invoice: inv({ items_total_mismatch: 0 }) as never });
      const ok = await request(appAs(USER)).post(`/api/queue/10/reocr/${path}`).send({ fingerprint: FP });
      expect(ok.status).toBe(200);
      expect(ok.body.data).toEqual({ deleted: 3, inserted: 4, total_sum: 1200, items_total_mismatch: 0 });
      expect(action).toHaveBeenLastCalledWith({ ownerUserId: 2, invoiceId: 10, userId: 2, fingerprint: FP });
    });
  }
});

describe('фоновые задачи', () => {
  it('POST /reocr: кривые ids → 400; занято → 409; нельзя начать → 400; иначе 202', async () => {
    const app = appAs(USER);
    expect((await request(app).post('/api/queue/reocr').send({ ids: [1, 'x'] })).status).toBe(400);
    expect((await request(app).post('/api/queue/reocr').send({ ids: [] })).status).toBe(400);
    expect((await request(app).post('/api/queue/reocr').send({ ids: [1.5] })).status).toBe(400);
    expect(startQueueReocr).not.toHaveBeenCalled();

    vi.mocked(startQueueReocr).mockRejectedValueOnce(new QueueJobBusyError('llm_map', false));
    const busy = await request(app).post('/api/queue/reocr').send({});
    expect(busy.status).toBe(409);
    expect(busy.body.busy).toEqual({ kind: 'llm_map', own: false });

    vi.mocked(startQueueReocr).mockRejectedValueOnce(new QueueStartError(400, 'Перераспознавать нечего'));
    expect((await request(app).post('/api/queue/reocr').send({})).body).toEqual({ error: 'Перераспознавать нечего' });

    vi.mocked(startQueueReocr).mockResolvedValueOnce({ job: { id: 1 } as never, planned: 2 });
    const ok = await request(app).post('/api/queue/reocr').send({ ids: [10, 11] });
    expect(ok.status).toBe(202);
    expect(vi.mocked(startQueueReocr).mock.calls.at(-1)?.[0]).toMatchObject({ ownerUserId: 2, startedBy: 2, invoiceIds: [10, 11], redo: false });

    vi.mocked(startQueueReocr).mockResolvedValueOnce({ job: { id: 2 } as never, planned: 70 });
    await request(app).post('/api/queue/reocr').send({ redo: true });
    expect(vi.mocked(startQueueReocr).mock.calls.at(-1)?.[0]).toMatchObject({ invoiceIds: null, redo: true });
  });

  it('POST /llm-map → 202, вся очередь компании или выбранные', async () => {
    vi.mocked(startQueueLlmMap).mockResolvedValueOnce({ job: { id: 2 } as never, planned: 12 });
    const res = await request(appAs(USER)).post('/api/queue/llm-map').send({});
    expect(res.status).toBe(202);
    expect(startQueueLlmMap).toHaveBeenCalledWith({ ownerUserId: 2, startedBy: 2, invoiceIds: null });
    vi.mocked(startQueueLlmMap).mockResolvedValueOnce({ job: { id: 3 } as never, planned: 1 });
    await request(appAs(USER)).post('/api/queue/llm-map').send({ ids: [10] });
    expect(startQueueLlmMap).toHaveBeenLastCalledWith({ ownerUserId: 2, startedBy: 2, invoiceIds: [10] });
  });

  it('status и cancel без своей задачи', async () => {
    const app = appAs(USER);
    expect((await request(app).get('/api/queue/reocr/status')).body).toEqual({ data: { job: null, busy: null } });
    expect((await request(app).get('/api/queue/llm-map/status')).body).toEqual({ data: { job: null, busy: null } });
    expect((await request(app).post('/api/queue/reocr/cancel')).body).toEqual({ data: { cancelled: false } });
    expect((await request(app).post('/api/queue/llm-map/cancel')).body).toEqual({ data: { cancelled: false } });
  });
});
