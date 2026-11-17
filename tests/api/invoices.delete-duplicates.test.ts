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

let app: express.Express;

describe.runIf((process.env.DB_NAME || '').includes('test'))('POST /api/invoices/delete-duplicates', () => {
  beforeAll(() => {
    app = createServer(
      new FileWatcher(undefined as never, undefined as never),
      new NomenclatureMapper(),
    );
  });
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  async function insert(fields: Record<string, unknown>): Promise<number> {
    const row = {
      file_name: `f-${Math.random()}.jpg`, file_path: '/missing/x', status: 'processed', owner_user_id: 1,
      invoice_number: '77', invoice_date: '2026-11-10', supplier: 'ООО Ромашка', supplier_inn: '7700000000',
      total_sum: 1000, ...fields,
    };
    const keys = Object.keys(row);
    const result = await getDb().prepare(
      `INSERT INTO invoices (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
    ).run(...Object.values(row));
    return Number(result.lastInsertRowid);
  }

  async function seed() {
    await getDb().prepare(
      `INSERT INTO users (id, username, password_hash, api_key, role, notify_events)
       VALUES (1, 'tenant_a', 'x', 'ka', 'user', '[]'), (2, 'tenant_b', 'x', 'kb', 'user', '[]')`
    ).run();
    const original = await insert({});
    const copy = await insert({});
    const marked = await insert({ status: 'duplicate', duplicate_of: original });
    const approved = await insert({ approved_for_1c: 1 });
    const old = await insert({ status: 'duplicate', duplicate_of: original, created_at: '2020-01-01 10:00:00' });
    const otherOriginal = await insert({ owner_user_id: 2 });
    const otherCopy = await insert({ owner_user_id: 2 });
    const unrelated = await insert({ invoice_number: '78' });
    return { original, copy, marked, approved, old, otherOriginal, otherCopy, unrelated };
  }

  const exists = async (id: number) => !!(await getDb().prepare('SELECT id FROM invoices WHERE id = ?').get(id));

  it('previews only own recent duplicates and never the original', async () => {
    const ids = await seed();
    const response = await request(app).post('/api/invoices/delete-duplicates').set('X-API-Key', 'ka').send({ dry_run: true });
    expect(response.status).toBe(200);
    expect(response.body.data.invoices.map((row: { id: number }) => row.id)).toEqual([ids.copy, ids.marked]);
  });

  it('deletes only the previewed duplicates, keeping originals and other tenants intact', async () => {
    const ids = await seed();
    const response = await request(app).post('/api/invoices/delete-duplicates').set('X-API-Key', 'ka')
      .send({ ids: [ids.copy, ids.marked, ids.original, ids.otherCopy] });
    expect(response.status).toBe(200);
    expect(response.body.data.deleted).toBe(2);
    expect(await exists(ids.copy)).toBe(false);
    expect(await exists(ids.marked)).toBe(false);
    for (const id of [ids.original, ids.approved, ids.old, ids.otherOriginal, ids.otherCopy, ids.unrelated]) {
      expect(await exists(id)).toBe(true);
    }
  });

  it('rejects a malformed id list', async () => {
    await seed();
    const response = await request(app).post('/api/invoices/delete-duplicates').set('X-API-Key', 'ka').send({ ids: ['x'] });
    expect(response.status).toBe(400);
  });
});
