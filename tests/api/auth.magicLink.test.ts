import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { userRepo } from '../../src/database/repositories/userRepo';

vi.mock('../../src/watcher/fileWatcher', () => ({ FileWatcher: class {} }));
vi.mock('../../src/mapping/nomenclatureMapper', () => ({ NomenclatureMapper: class {} }));

import { createServer } from '../../src/api/server';
import { FileWatcher } from '../../src/watcher/fileWatcher';
import { NomenclatureMapper } from '../../src/mapping/nomenclatureMapper';

let app: express.Express;
beforeAll(() => {
  app = createServer(
    new FileWatcher(undefined as never, undefined as never),
    new NomenclatureMapper(),
  );
});

describe.runIf((process.env.DB_NAME || '').includes('test'))('magic-link HTTP exchange', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  it('does not consume on GET and consumes exactly once on POST', async () => {
    const token = '0123456789abcdef0123456789abcdef';
    const created = await getDb().prepare(
      `INSERT INTO users (username, password_hash, api_key, role, notify_events)
       VALUES ('magic_http', 'x', 'magic-http-key', 'user', '[]')`
    ).run();
    await userRepo.setMagicToken(Number(created.lastInsertRowid), token, new Date(Date.now() + 60_000));

    const page = await request(app).get(`/magic/${token}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain(`/magic/${token}/consume`);
    expect(await userRepo.findByMagicToken(token)).toBeDefined();

    const first = await request(app).post(`/magic/${token}/consume`);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ apiKey: 'magic-http-key', username: 'magic_http', role: 'user' });

    const second = await request(app).post(`/magic/${token}/consume`);
    expect(second.status).toBe(404);
  });
});
