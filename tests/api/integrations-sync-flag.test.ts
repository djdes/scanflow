import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';

vi.mock('../../src/watcher/fileWatcher', () => ({ FileWatcher: class {} }));
vi.mock('../../src/mapping/nomenclatureMapper', () => ({ NomenclatureMapper: class {} }));

import { createServer } from '../../src/api/server';
import { FileWatcher } from '../../src/watcher/fileWatcher';
import { NomenclatureMapper } from '../../src/mapping/nomenclatureMapper';
import { syncStateRepo } from '../../src/database/repositories/syncStateRepo';

let app: express.Express;
beforeAll(() => { app = createServer(new FileWatcher() as never, new NomenclatureMapper() as never); });

async function setupUser(): Promise<string> {
  await getDb().prepare(
    `INSERT INTO users (id, username, password_hash, api_key, role, notify_events) VALUES (1, 'admin', 'x', 'k', 'admin', '[]')`
  ).run();
  return 'k';
}

async function createProcessedInvoice(): Promise<number> {
  const r = await getDb().prepare(
    `INSERT INTO invoices (file_name, file_path, status, invoice_number) VALUES ('f','/f','processed','N-1')`
  ).run();
  return Number(r.lastInsertRowid);
}

async function addItem(invoiceId: number, guid: string | null): Promise<void> {
  await getDb().prepare(
    `INSERT INTO invoice_items (invoice_id, original_name, quantity, unit, price, total, mapping_confidence, onec_guid)
     VALUES (?, 'x', 1, 'шт', 10, 10, 1, ?)`
  ).run(invoiceId, guid);
}

describe.runIf((process.env.DB_NAME || '').includes('test'))('GET/POST /api/integrations/sync-flag', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  it('GET returns false when unset', async () => {
    const key = await setupUser();
    const res = await request(app).get('/api/integrations/sync-flag').set('X-API-Key', key);
    expect(res.status).toBe(200);
    expect(res.body.data.nomenclature_sync_requested).toBe(false);
    expect(res.body.data.since).toBeNull();
  });

  it('GET returns true + since after mark; clear with that since resets it', async () => {
    const key = await setupUser();
    await syncStateRepo.markNomenclatureSyncRequested();

    const got = await request(app).get('/api/integrations/sync-flag').set('X-API-Key', key);
    expect(got.body.data.nomenclature_sync_requested).toBe(true);
    const since = got.body.data.since as string;

    const cleared = await request(app)
      .post('/api/integrations/sync-flag/clear')
      .set('X-API-Key', key)
      .send({ since });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.cleared).toBe(true);

    const after = await request(app).get('/api/integrations/sync-flag').set('X-API-Key', key);
    expect(after.body.data.nomenclature_sync_requested).toBe(false);
  });

  it('clear without since → 400', async () => {
    const key = await setupUser();
    const res = await request(app).post('/api/integrations/sync-flag/clear').set('X-API-Key', key).send({});
    expect(res.status).toBe(400);
  });

  it('requires auth', async () => {
    const res = await request(app).get('/api/integrations/sync-flag');
    expect(res.status).toBe(401);
  });

  it('sets the flag when an approved invoice has an unmatched item', async () => {
    const key = await setupUser();
    const inv = await createProcessedInvoice();
    await addItem(inv, null); // unmatched
    const send = await request(app).post(`/api/invoices/${inv}/send`).set('X-API-Key', key);
    expect(send.status).toBe(200);
    const flag = await request(app).get('/api/integrations/sync-flag').set('X-API-Key', key);
    expect(flag.body.data.nomenclature_sync_requested).toBe(true);
  });

  it('does NOT set the flag when all items are matched', async () => {
    const key = await setupUser();
    const inv = await createProcessedInvoice();
    await addItem(inv, 'guid-1'); // matched
    await request(app).post(`/api/invoices/${inv}/send`).set('X-API-Key', key);
    const flag = await request(app).get('/api/integrations/sync-flag').set('X-API-Key', key);
    expect(flag.body.data.nomenclature_sync_requested).toBe(false);
  });
});
