import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { automationRepo } from '../../src/database/repositories/automationRepo';

vi.mock('../../src/watcher/fileWatcher', () => ({ FileWatcher: class {} }));
vi.mock('../../src/mapping/nomenclatureMapper', () => ({ NomenclatureMapper: class {} }));

import { createServer } from '../../src/api/server';
import { FileWatcher } from '../../src/watcher/fileWatcher';
import { NomenclatureMapper } from '../../src/mapping/nomenclatureMapper';

let app: express.Express;
beforeAll(() => {
  app = createServer(new FileWatcher() as never, new NomenclatureMapper() as never);
});

async function mkUser(id: number, key: string): Promise<void> {
  await getDb().prepare(
    `INSERT INTO users (id, username, password_hash, api_key, role, notify_events)
     VALUES (?, ?, 'x', ?, 'user', '[]')`
  ).run(id, `u${id}`, key);
}

async function mkInvoice(
  owner: number,
  opts: { status?: string; inn?: string | null; total?: number; approved?: number } = {},
): Promise<number> {
  const { status = 'processed', inn = '7830002293', total = 1000, approved = 0 } = opts;
  const r = await getDb().prepare(
    `INSERT INTO invoices (file_name, file_path, status, supplier_inn, total_sum, approved_for_1c, owner_user_id, created_at)
     VALUES ('f','/f', ?, ?, ?, ?, ?, NOW())`
  ).run(status, inn, total, approved, owner);
  return Number(r.lastInsertRowid);
}

// Mock the loopback fetch → canned single-route response per invoice id.
function mockLoopback(byId: Record<number, { status: number; json: unknown }>): void {
  global.fetch = vi.fn(async (url: string) => {
    const m = String(url).match(/\/invoices\/(\d+)\//);
    const id = m ? Number(m[1]) : 0;
    const r = byId[id] ?? { status: 200, json: { success: true } };
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.json };
  }) as never;
}

describe.runIf((process.env.DB_NAME || '').includes('test'))('bulk send 1C/Sber', () => {
  beforeEach(async () => {
    await resetDb();
    await mkUser(1, 'k1');
    await mkUser(2, 'k2');
    global.fetch = vi.fn(async () => ({ status: 200, ok: true, json: async () => ({ success: true }) })) as never;
  });
  afterAll(async () => { await closeTestDb(); });

  it('rejects an empty or malformed ids array', async () => {
    const empty = await request(app).post('/api/invoices/send-1c-batch').set('X-API-Key', 'k1').send({ ids: [] });
    expect(empty.status).toBe(400);
    const bad = await request(app).post('/api/invoices/send-1c-batch').set('X-API-Key', 'k1').send({ ids: [1, -2] });
    expect(bad.status).toBe(400);
  });

  it('404 when any id belongs to another tenant — nothing sent', async () => {
    const mine = await mkInvoice(1);
    const foreign = await mkInvoice(2);
    const res = await request(app).post('/api/invoices/send-1c-batch').set('X-API-Key', 'k1').send({ ids: [mine, foreign] });
    expect(res.status).toBe(404);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('1C pre-checks skip without loopback (not_processed / already_approved)', async () => {
    const errored = await mkInvoice(1, { status: 'error' });
    const approved = await mkInvoice(1, { approved: 1 });
    const res = await request(app).post('/api/invoices/send-1c-batch').set('X-API-Key', 'k1').send({ ids: [errored, approved] });
    expect(res.status).toBe(200);
    expect(res.body.data.sent).toBe(0);
    const reasons = Object.fromEntries(res.body.data.skipped.map((s: { id: number; reason: string }) => [s.id, s.reason]));
    expect(reasons[errored]).toBe('not_processed');
    expect(reasons[approved]).toBe('already_approved');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('1C sends a processed invoice via loopback', async () => {
    const inv = await mkInvoice(1);
    mockLoopback({ [inv]: { status: 200, json: {} } });
    const res = await request(app).post('/api/invoices/send-1c-batch').set('X-API-Key', 'k1').send({ ids: [inv] });
    expect(res.body.data.sent).toBe(1);
    expect(res.body.data.skipped).toEqual([]);
  });

  it('over-threshold is skipped WITHOUT creating an approval request', async () => {
    await automationRepo.update({ payment_approval_threshold: 100 });
    const inv = await mkInvoice(1, { total: 5000 });
    const res = await request(app).post('/api/invoices/send-1c-batch').set('X-API-Key', 'k1').send({ ids: [inv] });
    expect(res.body.data.skipped).toEqual([{ id: inv, reason: 'over_threshold' }]);
    expect(global.fetch).not.toHaveBeenCalled();
    const appr = await getDb().prepare('SELECT COUNT(*) c FROM approval_requests WHERE invoice_id = ?').get<{ c: number }>(inv);
    expect(Number(appr?.c)).toBe(0);
  });

  it('Sber loopback maps outcomes: sent / supplier_unverified / already_paid', async () => {
    const a = await mkInvoice(1);
    const b = await mkInvoice(1);
    const c = await mkInvoice(1);
    mockLoopback({
      [a]: { status: 200, json: { success: true } },
      [b]: { status: 409, json: { needs_supplier_confirmation: true } },
      [c]: { status: 409, json: { error: 'Payment already created for this invoice' } },
    });
    const res = await request(app).post('/api/invoices/send-sber-batch').set('X-API-Key', 'k1').send({ ids: [a, b, c] });
    expect(res.body.data.sent).toBe(1);
    const reasons = Object.fromEntries(res.body.data.skipped.map((s: { id: number; reason: string }) => [s.id, s.reason]));
    expect(reasons[b]).toBe('supplier_unverified');
    expect(reasons[c]).toBe('already_paid');
  });

  it('Sber maps a 400 no-INN response to no_inn', async () => {
    const inv = await mkInvoice(1);
    mockLoopback({ [inv]: { status: 400, json: { error: 'invoice has no supplier_inn' } } });
    const res = await request(app).post('/api/invoices/send-sber-batch').set('X-API-Key', 'k1').send({ ids: [inv] });
    expect(res.body.data.sent).toBe(0);
    expect(res.body.data.skipped).toEqual([{ id: inv, reason: 'no_inn' }]);
  });
});
