import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';

vi.mock('../../src/watcher/fileWatcher', () => ({ FileWatcher: class {} }));
vi.mock('../../src/mapping/nomenclatureMapper', () => ({ NomenclatureMapper: class {} }));

// Сеть к OpenAI подменена: проверяем маршруты, хранение и права, а не auth.openai.com.
const auth = vi.hoisted(() => ({ requestDeviceCode: vi.fn(), pollDeviceCode: vi.fn() }));
vi.mock('../../src/chatgpt/deviceAuth', async () => {
  const actual = await vi.importActual<typeof import('../../src/chatgpt/deviceAuth')>('../../src/chatgpt/deviceAuth');
  return { ...actual, requestDeviceCode: auth.requestDeviceCode, pollDeviceCode: auth.pollDeviceCode };
});

import { createServer } from '../../src/api/server';
import { FileWatcher } from '../../src/watcher/fileWatcher';
import { NomenclatureMapper } from '../../src/mapping/nomenclatureMapper';
import { chatgptConnectionRepo } from '../../src/database/repositories/chatgptConnectionRepo';

let app: express.Express;
beforeAll(() => {
  process.env.JWT_SECRET ??= 'test-secret-for-chatgpt-token-encryption-0123456789';
  app = createServer(new FileWatcher() as never, new NomenclatureMapper() as never);
});

async function setupUsers(): Promise<{ admin: string; user: string }> {
  await getDb().prepare(
    `INSERT INTO users (id, username, password_hash, api_key, role, notify_events) VALUES (1, 'admin', 'x', 'k-admin', 'admin', '[]'), (2, 'user', 'x', 'k-user', 'user', '[]')`,
  ).run();
  return { admin: 'k-admin', user: 'k-user' };
}

const ACCESS = `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400, 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-1', chatgpt_plan_type: 'plus' } })).toString('base64url')}.s`;

describe.runIf((process.env.DB_NAME || '').includes('test'))('/api/chatgpt: своё подключение подписки ChatGPT', () => {
  beforeEach(async () => {
    await resetDb();
    vi.resetAllMocks();
  });
  afterAll(async () => { await closeTestDb(); });

  it('только администратор: подключение — платформенный конфиг', async () => {
    const { user } = await setupUsers();
    expect((await request(app).get('/api/chatgpt').set('X-API-Key', user)).status).toBe(403);
    expect((await request(app).post('/api/chatgpt/login').set('X-API-Key', user)).status).toBe(403);
  });

  it('вход по коду: код → ожидание → подключено; токены в БД только зашифрованы', async () => {
    const { admin } = await setupUsers();
    expect((await request(app).get('/api/chatgpt').set('X-API-Key', admin)).body.data.connected).toBe(false);

    auth.requestDeviceCode.mockResolvedValue({ userCode: 'ABCD-1234', deviceAuthId: 'dev-1', verificationUrl: 'https://auth.openai.com/codex/device', intervalSec: 5 });
    const start = await request(app).post('/api/chatgpt/login').set('X-API-Key', admin);
    expect(start.status).toBe(200);
    expect(start.body.data.pending_login).toMatchObject({ user_code: 'ABCD-1234', interval_sec: 5 });

    auth.pollDeviceCode.mockResolvedValueOnce({ status: 'pending' });
    expect((await request(app).post('/api/chatgpt/login/poll').set('X-API-Key', admin)).body.data.result).toBe('pending');

    auth.pollDeviceCode.mockResolvedValueOnce({
      status: 'approved',
      credentials: { accessToken: ACCESS, refreshToken: 'RT-secret', idToken: null },
      account: { accountId: 'acc-1', email: 'owner@example.ru', planType: 'plus', accessExpiresMs: Date.now() + 86400000 },
    });
    const done = await request(app).post('/api/chatgpt/login/poll').set('X-API-Key', admin);
    expect(done.body.data).toMatchObject({ result: 'connected', connected: true, status: 'active', account_email: 'owner@example.ru', pending_login: null });
    expect(JSON.stringify(done.body)).not.toContain('RT-secret');

    const row = await getDb().prepare('SELECT access_token, refresh_token FROM chatgpt_connection WHERE id = 1')
      .get<{ access_token: string; refresh_token: string }>();
    expect(row?.access_token.startsWith('v1:')).toBe(true);
    expect(row?.refresh_token).not.toContain('RT-secret');
    expect((await chatgptConnectionRepo.getCredentials())?.refreshToken).toBe('RT-secret');
    expect(await getDb().prepare('SELECT 1 FROM chatgpt_device_login').get()).toBeUndefined();
  });

  it('режим gpt нельзя включить без подключения; с подключением — можно, модель сохраняется', async () => {
    const { admin } = await setupUsers();
    const denied = await request(app).put('/api/settings/analyzer').set('X-API-Key', admin).send({ mode: 'gpt' });
    expect(denied.status).toBe(400);
    expect(denied.body.error).toMatch(/подключите ChatGPT/);

    await chatgptConnectionRepo.replace({
      credentials: { accessToken: ACCESS, refreshToken: 'RT', idToken: null },
      account: { accountId: 'acc-1', email: null, planType: null, accessExpiresMs: null },
      createdBy: 1, nowMs: Date.now(),
    });
    const ok = await request(app).put('/api/settings/analyzer').set('X-API-Key', admin).send({ mode: 'gpt', gpt_model: 'gpt-6-luna' });
    expect(ok.status).toBe(200);
    const cfg = await request(app).get('/api/settings/analyzer').set('X-API-Key', admin);
    expect(cfg.body.data).toMatchObject({ mode: 'gpt', gpt_model: 'gpt-6-luna' });

    const bad = await request(app).put('/api/settings/analyzer').set('X-API-Key', admin).send({ mode: 'gpt', gpt_model: 'claude; drop' });
    expect(bad.status).toBe(400);
  });

  it('отключение удаляет токены', async () => {
    const { admin } = await setupUsers();
    await chatgptConnectionRepo.replace({
      credentials: { accessToken: ACCESS, refreshToken: 'RT', idToken: null },
      account: { accountId: 'acc-1', email: null, planType: null, accessExpiresMs: null },
      createdBy: 1, nowMs: Date.now(),
    });
    expect((await request(app).delete('/api/chatgpt').set('X-API-Key', admin)).status).toBe(200);
    expect(await chatgptConnectionRepo.get()).toBeNull();
  });
});
