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
import { trashRepo } from '../../src/database/repositories/trashRepo';

let app: express.Express;

describe.runIf((process.env.DB_NAME || '').includes('test'))('invoice trash', () => {
  beforeAll(() => {
    app = createServer(new FileWatcher(undefined as never, undefined as never), new NomenclatureMapper());
  });
  beforeEach(async () => {
    await resetDb();
    await getDb().prepare(
      `INSERT INTO users (id, username, password_hash, api_key, role, notify_events)
       VALUES (1, 'tenant_a', 'x', 'ka', 'user', '[]'), (2, 'tenant_b', 'x', 'kb', 'user', '[]')`
    ).run();
  });
  afterAll(async () => { await closeTestDb(); });

  async function seedInvoice(): Promise<number> {
    const res = await getDb().prepare(
      `INSERT INTO invoices (file_name, file_path, status, owner_user_id, invoice_number, invoice_date, supplier, total_sum, file_hash)
       VALUES ('trash-a.jpg', '/missing/a', 'processed', 1, 'Т-1', '2026-11-10', 'ООО Ромашка', 1500, 'hash-a')`
    ).run();
    const id = Number(res.lastInsertRowid);
    await getDb().prepare(
      `INSERT INTO invoice_items (invoice_id, original_name, quantity, unit, price, total)
       VALUES (?, 'Молоко', 10, 'шт', 100, 1000), (?, 'Кефир', 5, 'шт', 100, 500)`
    ).run(id, id);
    return id;
  }

  it('moves a deleted invoice to the trash and restores it with the same id and items', async () => {
    const id = await seedInvoice();
    const del = await request(app).delete(`/api/invoices/${id}`).set('X-API-Key', 'ka');
    expect(del.status).toBe(200);
    expect(await getDb().prepare('SELECT id FROM invoices WHERE id = ?').get(id)).toBeUndefined();

    const list = await request(app).get('/api/invoices/trash').set('X-API-Key', 'ka');
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ invoice_id: id, invoice_number: 'Т-1', days_left: 30 });

    const other = await request(app).get('/api/invoices/trash').set('X-API-Key', 'kb');
    expect(other.body.data).toHaveLength(0);
    const foreign = await request(app).post(`/api/invoices/trash/${list.body.data[0].id}/restore`).set('X-API-Key', 'kb');
    expect(foreign.status).toBe(404);

    const restore = await request(app).post(`/api/invoices/trash/${list.body.data[0].id}/restore`).set('X-API-Key', 'ka');
    expect(restore.status).toBe(200);
    expect(restore.body.data.invoice_id).toBe(id);
    const back = await getDb().prepare('SELECT invoice_number, total_sum, owner_user_id FROM invoices WHERE id = ?').get<{ invoice_number: string; total_sum: number; owner_user_id: number }>(id);
    expect(back).toMatchObject({ invoice_number: 'Т-1', owner_user_id: 1 });
    expect(Number(back!.total_sum)).toBe(1500);
    const items = await getDb().prepare('SELECT original_name FROM invoice_items WHERE invoice_id = ? ORDER BY id').all<{ original_name: string }>(id);
    expect(items.map(i => i.original_name)).toEqual(['Молоко', 'Кефир']);
    expect((await request(app).get('/api/invoices/trash').set('X-API-Key', 'ka')).body.data).toHaveLength(0);
  });

  it('refuses to restore when the same photo was uploaded again', async () => {
    const id = await seedInvoice();
    const trashId = await trashRepo.moveToTrash(id, 1, 'manual');
    await getDb().prepare(
      `INSERT INTO invoices (file_name, file_path, status, owner_user_id, file_hash) VALUES ('again.jpg', '/x', 'processed', 1, 'hash-a')`
    ).run();
    const res = await request(app).post(`/api/invoices/trash/${trashId}/restore`).set('X-API-Key', 'ka');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('duplicate_file');
  });

  it('deletes forever and purges entries older than 30 days', async () => {
    const id = await seedInvoice();
    const trashId = await trashRepo.moveToTrash(id, 1, 'manual');
    expect((await request(app).delete(`/api/invoices/trash/${trashId}`).set('X-API-Key', 'kb')).status).toBe(404);
    expect((await request(app).delete(`/api/invoices/trash/${trashId}`).set('X-API-Key', 'ka')).status).toBe(200);
    expect(await trashRepo.count(1)).toBe(0);

    const id2 = await seedInvoice();
    const old = await trashRepo.moveToTrash(id2, 1, 'manual');
    await getDb().prepare('UPDATE deleted_invoices SET deleted_at = NOW() - INTERVAL 31 DAY WHERE id = ?').run(old);
    expect(await trashRepo.purgeExpired()).toBe(1);
    expect(await getDb().prepare('SELECT id FROM deleted_invoices WHERE id = ?').get(old)).toBeUndefined();
  });
});
