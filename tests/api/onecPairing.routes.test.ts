import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { createServer } from '../../src/api/server';
import { FileWatcher } from '../../src/watcher/fileWatcher';
import { NomenclatureMapper } from '../../src/mapping/nomenclatureMapper';

const app = createServer(new FileWatcher() as never, new NomenclatureMapper() as never);

async function mkUser(username: string, role: string, key: string): Promise<number> {
  const r = await getDb().prepare(
    `INSERT INTO users (username, password_hash, api_key, role, notify_events) VALUES (?, 'x', ?, ?, '[]')`
  ).run(username, key, role);
  return Number(r.lastInsertRowid);
}

describe.runIf((process.env.DB_NAME || '').includes('test'))('POST /api/onec/pairing-code', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  it('role=user can generate a pairing code (not admin-gated)', async () => {
    await mkUser('client', 'user', 'client-key');
    const res = await request(app)
      .post('/api/onec/pairing-code')
      .set('X-API-Key', 'client-key')
      .send({ base_name: 'База клиента' });
    expect(res.status).toBe(201);
    expect(res.body.data.code).toMatch(/^1C-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(res.body.data.expires_at).toBeTruthy();
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).post('/api/onec/pairing-code').send({});
    expect(res.status).toBe(401);
  });
});
