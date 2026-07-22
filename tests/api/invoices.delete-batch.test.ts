import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { config } from '../../src/config';

vi.mock('../../src/watcher/fileWatcher', () => ({ FileWatcher: class {} }));
vi.mock('../../src/mapping/nomenclatureMapper', () => ({ NomenclatureMapper: class {} }));

import { createServer } from '../../src/api/server';
import { FileWatcher } from '../../src/watcher/fileWatcher';
import { NomenclatureMapper } from '../../src/mapping/nomenclatureMapper';

let app: express.Express;

describe.runIf((process.env.DB_NAME || '').includes('test'))('POST /api/invoices/delete-batch ownership', () => {
  beforeAll(() => {
    app = createServer(
      new FileWatcher(undefined as never, undefined as never),
      new NomenclatureMapper(),
    );
  });
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => {
    await closeTestDb();
  });

  async function seed(): Promise<{ own: number; other: number }> {
    await getDb().prepare(
      `INSERT INTO users (id, username, password_hash, api_key, role, notify_events)
       VALUES (1, 'tenant_a', 'x', 'ka', 'user', '[]'),
              (2, 'tenant_b', 'x', 'kb', 'user', '[]'),
              (3, 'admin', 'x', 'admin-key', 'admin', '[]')`
    ).run();
    const own = await getDb().prepare(
      `INSERT INTO invoices (file_name, file_path, status, owner_user_id)
       VALUES ('missing-a.jpg', '/missing/a', 'processed', 1)`
    ).run();
    const other = await getDb().prepare(
      `INSERT INTO invoices (file_name, file_path, status, owner_user_id)
       VALUES ('missing-b.jpg', '/missing/b', 'processed', 2)`
    ).run();
    return { own: Number(own.lastInsertRowid), other: Number(other.lastInsertRowid) };
  }

  it('rejects a mixed-owner batch before deleting any invoice', async () => {
    const ids = await seed();
    const response = await request(app)
      .post('/api/invoices/delete-batch')
      .set('X-API-Key', 'ka')
      .send({ ids: [ids.own, ids.other] });

    expect(response.status).toBe(404);
    expect(await getDb().prepare('SELECT id FROM invoices WHERE id = ?').get(ids.own)).toBeDefined();
    expect(await getDb().prepare('SELECT id FROM invoices WHERE id = ?').get(ids.other)).toBeDefined();
  });

  it('allows an owner to delete their own invoice', async () => {
    const ids = await seed();
    const response = await request(app)
      .post('/api/invoices/delete-batch')
      .set('X-API-Key', 'ka')
      .send({ ids: [ids.own] });

    expect(response.status).toBe(200);
    expect(response.body.data.deleted).toBe(1);
    expect(await getDb().prepare('SELECT id FROM invoices WHERE id = ?').get(ids.own)).toBeUndefined();
    expect(await getDb().prepare('SELECT id FROM invoices WHERE id = ?').get(ids.other)).toBeDefined();
  });
});
