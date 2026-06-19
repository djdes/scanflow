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
beforeAll(() => { app = createServer(new FileWatcher() as never, new NomenclatureMapper() as never); });

async function setupUser(): Promise<string> {
  await getDb().prepare(
    `INSERT INTO users (id, username, password_hash, api_key, role, notify_events) VALUES (1,'admin','x','k','admin','[]')`
  ).run();
  return 'k';
}
async function mk(supplier: string, inn: string | null, n = 1): Promise<void> {
  for (let i = 0; i < n; i++) {
    await getDb().prepare(
      `INSERT INTO invoices (file_name, file_path, status, supplier, supplier_inn) VALUES ('f','/f','processed', ?, ?)`
    ).run(supplier, inn);
  }
}

describe.runIf((process.env.DB_NAME || '').includes('test'))('POST /api/invoices/merge-suppliers', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  it('dry-run reports the group without writing; apply merges to the most-used spelling', async () => {
    const key = await setupUser();
    await mk('ООО "ВЕСЕЛОФФ и ГКОМПАНИЙ"', '5018202085', 3); // dominant
    await mk('ООО "ВЕСЕЛОФФ и ГКОМПАНИ"', '5018202085', 1);  // drift
    await mk('ИП Кнутова Александра Сергеевна', '7701234567', 2); // unrelated

    const dry = await request(app).post('/api/invoices/merge-suppliers?dry_run=true').set('X-API-Key', key);
    expect(dry.status).toBe(200);
    expect(dry.body.data.dry_run).toBe(true);
    expect(dry.body.data.groups_found).toBe(1);
    expect(dry.body.data.invoices_updated).toBe(0);
    expect(dry.body.data.groups[0].canonical).toBe('ООО "ВЕСЕЛОФФ и ГКОМПАНИЙ"');

    const apply = await request(app).post('/api/invoices/merge-suppliers?dry_run=false').set('X-API-Key', key);
    expect(apply.body.data.invoices_updated).toBe(1);

    const after = await getDb().prepare(
      `SELECT supplier, COUNT(*) c FROM invoices GROUP BY supplier`
    ).all<{ supplier: string; c: number }>();
    const map = Object.fromEntries(after.map(r => [r.supplier, Number(r.c)]));
    expect(map['ООО "ВЕСЕЛОФФ и ГКОМПАНИЙ"']).toBe(4);
    expect(map['ООО "ВЕСЕЛОФФ и ГКОМПАНИ"']).toBeUndefined();
    expect(map['ИП Кнутова Александра Сергеевна']).toBe(2);
  });
});
