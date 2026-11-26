import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';

vi.mock('../../src/watcher/fileWatcher', () => ({ FileWatcher: class {} }));
vi.mock('../../src/mapping/nomenclatureMapper', () => ({ NomenclatureMapper: class {} }));
// Проверка нового сертификата ходит в Сбер — здесь отвечаем «принят».
vi.mock('../../src/sber/sberClient', async (orig) => ({
  ...(await orig<typeof import('../../src/sber/sberClient')>()),
  sberFetch: vi.fn(async () => ({ status: 200, ok: true, body: '{}', json: () => ({}) })),
}));
vi.mock('../../src/sber/oauth', async (orig) => ({
  ...(await orig<typeof import('../../src/sber/oauth')>()),
  getValidAccessToken: vi.fn(async () => 'tok'),
}));

import { createServer } from '../../src/api/server';
import { FileWatcher } from '../../src/watcher/fileWatcher';
import { NomenclatureMapper } from '../../src/mapping/nomenclatureMapper';
import { sberTokenRepo } from '../../src/database/repositories/sberTokenRepo';
import { activeTls, resetTlsCache } from '../../src/sber/sberClient';
import { FIXTURE_P12_BASE64, FIXTURE_P12_PASSWORD, FIXTURE_P12_VALID_TO } from '../fixtures/sberTlsFixture';

let app: express.Express;
beforeAll(() => {
  app = createServer(new FileWatcher() as never, new NomenclatureMapper() as never);
});

describe.runIf((process.env.DB_NAME || '').includes('test'))('POST /api/sber/tls-cert', () => {
  const saved = { pfx: process.env.SBER_TLS_PFX, pass: process.env.SBER_TLS_PFX_PASSWORD, cid: process.env.SBER_CLIENT_ID };
  beforeEach(async () => {
    await resetDb();
    delete process.env.SBER_TLS_PFX;
    delete process.env.SBER_TLS_PFX_PASSWORD;
    process.env.SBER_CLIENT_ID = 'test-client';
    process.env.JWT_SECRET = process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32 ? process.env.JWT_SECRET : 'test-secret-must-be-at-least-32-chars-long';
    resetTlsCache();
    const db = getDb();
    await db.prepare(`INSERT INTO users (id, username, password_hash, api_key, role, notify_events) VALUES (1, 'admin', 'x', 'ka', 'admin', '[]')`).run();
    await db.prepare(`INSERT INTO users (id, username, password_hash, api_key, role, notify_events) VALUES (2, 'user', 'x', 'ku', 'user', '[]')`).run();
    await sberTokenRepo.upsert({ access_token: 'a', refresh_token: 'r', expires_at: '2099-01-01 00:00:00' }, 1);
  });
  afterAll(async () => {
    process.env.SBER_TLS_PFX = saved.pfx; process.env.SBER_TLS_PFX_PASSWORD = saved.pass; process.env.SBER_CLIENT_ID = saved.cid;
    resetTlsCache();
    await closeTestDb();
  });

  it('админ загружает .p12 — сохраняется зашифрованным, сразу в работе, срок виден в статусе', async () => {
    const res = await request(app).post('/api/sber/tls-cert').set('X-API-Key', 'ka')
      .send({ pfx_base64: FIXTURE_P12_BASE64, password: FIXTURE_P12_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.tls).toMatchObject({ source: 'db', valid_to: FIXTURE_P12_VALID_TO.toISOString(), subject: 'CI02745214-PROM-test-fixture' });

    const row = await getDb().prepare('SELECT tls_pfx_enc, tls_pass_enc, tls_valid_to FROM sber_app WHERE client_id = ?')
      .get<{ tls_pfx_enc: string; tls_pass_enc: string; tls_valid_to: string }>('test-client');
    expect(row?.tls_pfx_enc.startsWith('v1:')).toBe(true);
    expect(row?.tls_pfx_enc).not.toContain(FIXTURE_P12_BASE64.slice(0, 40));
    expect(row?.tls_pass_enc).not.toContain(FIXTURE_P12_PASSWORD);

    const active = await activeTls();
    expect(active?.source).toBe('db');
    expect(active?.passphrase).toBe(FIXTURE_P12_PASSWORD);

    const st = await request(app).get('/api/sber/status').set('X-API-Key', 'ka');
    expect(st.body.auth.tls).toMatchObject({ source: 'db', valid_to: FIXTURE_P12_VALID_TO.toISOString() });
    expect(JSON.stringify(st.body)).not.toContain(FIXTURE_P12_PASSWORD);
  });

  it('неверный пароль — 400 с причиной, ничего не сохранено', async () => {
    const res = await request(app).post('/api/sber/tls-cert').set('X-API-Key', 'ka')
      .send({ pfx_base64: FIXTURE_P12_BASE64, password: 'wrong' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Неверный пароль/);
    const row = await getDb().prepare('SELECT COUNT(*) AS c FROM sber_app WHERE tls_pfx_enc IS NOT NULL').get<{ c: number }>();
    expect(Number(row?.c)).toBe(0);
  });

  it('не админ — 403', async () => {
    const res = await request(app).post('/api/sber/tls-cert').set('X-API-Key', 'ku')
      .send({ pfx_base64: FIXTURE_P12_BASE64, password: FIXTURE_P12_PASSWORD });
    expect(res.status).toBe(403);
  });

  it('без файла или пароля — 400', async () => {
    expect((await request(app).post('/api/sber/tls-cert').set('X-API-Key', 'ka').send({ password: 'x' })).status).toBe(400);
    expect((await request(app).post('/api/sber/tls-cert').set('X-API-Key', 'ka').send({ pfx_base64: FIXTURE_P12_BASE64 })).status).toBe(400);
  });
});
