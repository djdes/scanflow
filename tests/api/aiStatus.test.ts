import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';

vi.mock('../../src/watcher/fileWatcher', () => ({ FileWatcher: class {} }));
vi.mock('../../src/mapping/nomenclatureMapper', () => ({ NomenclatureMapper: class {} }));
const h = vi.hoisted(() => ({ state: vi.fn() }));
vi.mock('../../src/ai/engine', async () => {
  const actual = await vi.importActual<typeof import('../../src/ai/engine')>('../../src/ai/engine');
  return { ...actual, aiEngineState: h.state };
});

import { createServer } from '../../src/api/server';
import { FileWatcher } from '../../src/watcher/fileWatcher';
import { NomenclatureMapper } from '../../src/mapping/nomenclatureMapper';

let app: express.Express;
beforeAll(() => { app = createServer(new FileWatcher() as never, new NomenclatureMapper() as never); });

describe.runIf((process.env.DB_NAME || '').includes('test'))('GET /api/ai/status', () => {
  beforeEach(async () => {
    await resetDb();
    await getDb().prepare(
      `INSERT INTO users (id, username, password_hash, api_key, role, notify_events) VALUES (1, 'a', 'x', 'k-a', 'admin', '[]'), (2, 'b', 'x', 'k-b', 'user', '[]')`,
    ).run();
    await getDb().prepare(
      `INSERT INTO invoices (file_name, file_path, status, owner_user_id) VALUES ('1.jpg','/1','waiting_ai',1), ('2.jpg','/2','waiting_ai',2), ('3.jpg','/3','waiting_ai',2), ('4.jpg','/4','processed',2)`,
    ).run();
    h.state.mockResolvedValue({ engine: 'gpt', model: 'gpt-6.1-sol', available: false, reason: 'rate_limited', retryAtMs: Date.UTC(2026, 9, 7, 15, 40), text: 'Лимит подписки ChatGPT до 18:40 МСК' });
  });
  afterAll(async () => { await closeTestDb(); });

  it('любому пользователю: состояние движка и сколько ждёт своей компании', async () => {
    const res = await request(app).get('/api/ai/status').set('X-API-Key', 'k-b');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      engine: 'gpt', model: 'gpt-6.1-sol', available: false, reason: 'rate_limited',
      text: 'Лимит подписки ChatGPT до 18:40 МСК', retry_at: '2026-10-07T15:40:00.000Z', waiting: 2,
    });
    const admin = await request(app).get('/api/ai/status').set('X-API-Key', 'k-a');
    expect(admin.body.data.waiting).toBe(1);
  });

  it('без ключа — 401', async () => {
    expect((await request(app).get('/api/ai/status')).status).toBe(401);
  });
});
