import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';

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

async function mkInvoice(ownerId: number): Promise<number> {
  const r = await getDb().prepare(
    `INSERT INTO invoices (file_name, file_path, status, supplier_inn, total_sum, owner_user_id, created_at)
     VALUES ('f','/f','processed','7830002293', 1000, ?, NOW())`
  ).run(ownerId);
  return Number(r.lastInsertRowid);
}

describe.runIf((process.env.DB_NAME || '').includes('test'))('invoice flags — read + paid_externally', () => {
  beforeEach(async () => {
    await resetDb();
    await mkUser(1, 'k1');
    await mkUser(2, 'k2');
  });
  afterAll(async () => { await closeTestDb(); });

  it('opening the detail as owner marks the invoice read (idempotently)', async () => {
    const id = await mkInvoice(1);
    expect((await invoiceRepo.getById(id))?.read_at).toBeNull();

    const res = await request(app).get(`/api/invoices/${id}`).set('X-API-Key', 'k1');
    expect(res.status).toBe(200);
    const readAt = (await invoiceRepo.getById(id))?.read_at;
    expect(readAt).not.toBeNull();

    // Second open must not overwrite the original read moment.
    await request(app).get(`/api/invoices/${id}`).set('X-API-Key', 'k1');
    expect((await invoiceRepo.getById(id))?.read_at).toBe(readAt);
  });

  it('POST /:id/read toggles read_at both ways', async () => {
    const id = await mkInvoice(1);
    await invoiceRepo.setRead(id, true); // start read

    const off = await request(app).post(`/api/invoices/${id}/read`).set('X-API-Key', 'k1').send({ read: false });
    expect(off.status).toBe(200);
    expect((await invoiceRepo.getById(id))?.read_at).toBeNull();

    const on = await request(app).post(`/api/invoices/${id}/read`).set('X-API-Key', 'k1').send({ read: true });
    expect(on.status).toBe(200);
    expect((await invoiceRepo.getById(id))?.read_at).not.toBeNull();
  });

  it('POST /:id/paid-externally toggles the flag', async () => {
    const id = await mkInvoice(1);

    const on = await request(app).post(`/api/invoices/${id}/paid-externally`).set('X-API-Key', 'k1').send({ value: true });
    expect(on.status).toBe(200);
    expect((await invoiceRepo.getById(id))?.paid_externally).toBe(1);

    const off = await request(app).post(`/api/invoices/${id}/paid-externally`).set('X-API-Key', 'k1').send({ value: false });
    expect(off.status).toBe(200);
    expect((await invoiceRepo.getById(id))?.paid_externally).toBe(0);
  });

  it('owner isolation: cannot flag another tenant’s invoice (404)', async () => {
    const foreign = await mkInvoice(2); // owned by user 2
    const res = await request(app).post(`/api/invoices/${foreign}/paid-externally`).set('X-API-Key', 'k1').send({ value: true });
    expect(res.status).toBe(404);
    expect((await invoiceRepo.getById(foreign))?.paid_externally).toBe(0); // untouched
  });

  it('sberUnsent stat excludes paid_externally invoices', async () => {
    const a = await mkInvoice(1);
    const b = await mkInvoice(1);
    const before = await request(app).get('/api/invoices/stats').set('X-API-Key', 'k1');
    expect(before.body.data.sberUnsent.count).toBe(2);

    await invoiceRepo.setPaidExternally(a, true);
    const after = await request(app).get('/api/invoices/stats').set('X-API-Key', 'k1');
    expect(after.body.data.sberUnsent.count).toBe(1); // a dropped out
    expect(after.body.data.sberUnsent.totalSum).toBe(1000); // only b remains
    void b;
  });
});
