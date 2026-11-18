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

describe.runIf((process.env.DB_NAME || '').includes('test'))('invoice comments', () => {
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

  async function seed(): Promise<number> {
    const r = await getDb().prepare(
      `INSERT INTO invoices (file_name, file_path, status, owner_user_id, invoice_number) VALUES ('c.jpg', '/x', 'processed', 1, 'К-1')`
    ).run();
    return Number(r.lastInsertRowid);
  }

  it('adds, lists and deletes own notes; another company cannot see them', async () => {
    const id = await seed();
    const add = await request(app).post(`/api/invoices/${id}/comments`).set('X-API-Key', 'ka').send({ body: '  Ждём УКД от поставщика  ' });
    expect(add.status).toBe(200);
    expect(add.body.data).toMatchObject({ author: 'tenant_a', body: 'Ждём УКД от поставщика', mine: true });
    expect((await request(app).post(`/api/invoices/${id}/comments`).set('X-API-Key', 'ka').send({ body: '   ' })).status).toBe(400);
    expect((await request(app).get(`/api/invoices/${id}/comments`).set('X-API-Key', 'kb')).status).toBe(404);
    const list = await request(app).get(`/api/invoices/${id}/comments`).set('X-API-Key', 'ka');
    expect(list.body.data).toHaveLength(1);
    const del = await request(app).delete(`/api/invoices/${id}/comments/${add.body.data.id}`).set('X-API-Key', 'ka');
    expect(del.status).toBe(200);
    expect((await request(app).get(`/api/invoices/${id}/comments`).set('X-API-Key', 'ka')).body.data).toHaveLength(0);
  });

  it('keeps notes through the trash and back', async () => {
    const id = await seed();
    await request(app).post(`/api/invoices/${id}/comments`).set('X-API-Key', 'ka').send({ body: 'Пауза до сверки' });
    const trashId = await trashRepo.moveToTrash(id, 1, 'manual');
    expect((await getDb().prepare('SELECT COUNT(*) AS n FROM invoice_comments').get<{ n: number }>())!.n).toBe(0);
    await trashRepo.restore(trashId!, 1);
    const list = await request(app).get(`/api/invoices/${id}/comments`).set('X-API-Key', 'ka');
    expect(list.body.data.map((n: { body: string }) => n.body)).toEqual(['Пауза до сверки']);
  });
});
