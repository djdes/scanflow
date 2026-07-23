import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { createServer } from '../../src/api/server';
import { onecPairingRepo } from '../../src/database/repositories/onecPairingRepo';
import { FileWatcher } from '../../src/watcher/fileWatcher';
import { NomenclatureMapper } from '../../src/mapping/nomenclatureMapper';

const app = createServer(new FileWatcher() as never, new NomenclatureMapper() as never);

async function mkUser(): Promise<number> {
  const r = await getDb().prepare(
    `INSERT INTO users (username, password_hash, api_key, role, notify_events) VALUES ('c','x','ck','user','[]')`
  ).run();
  return Number(r.lastInsertRowid);
}

describe.runIf((process.env.DB_NAME || '').includes('test'))('POST /api/onec/pair', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  it('valid code → creates a connection token owned by the user', async () => {
    const owner = await mkUser();
    const { code } = await onecPairingRepo.create(owner, 'База');

    const res = await request(app).post('/api/onec/pair').send({ code });
    expect(res.status).toBe(201);
    expect(res.body.data.token).toMatch(/^sf1c_/);
    expect(res.body.data.header).toBe('X-1C-Token');
    expect(res.body.data.exchange_url).toContain('/api/onec/exchange');

    // токен привязан к владельцу кода
    const conn = await getDb().prepare(
      `SELECT owner_user_id FROM onec_connections WHERE token_prefix = ?`
    ).get<{ owner_user_id: number }>(res.body.data.token.slice(0, 12));
    expect(conn?.owner_user_id).toBe(owner);
  });

  it('invalid or already-used code → 400', async () => {
    const owner = await mkUser();
    const { code } = await onecPairingRepo.create(owner, 'X');
    await onecPairingRepo.redeem(code); // погасили

    expect((await request(app).post('/api/onec/pair').send({ code })).status).toBe(400);
    expect((await request(app).post('/api/onec/pair').send({ code: '1C-AAAA-BBBB' })).status).toBe(400);
  });
});
