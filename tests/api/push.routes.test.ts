import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';

// Службы уведомлений браузеров в тестах не трогаем (правило: внешние сервисы — только моки).
const sendNotification = vi.fn();
vi.mock('web-push', async () => {
  const real = await vi.importActual<typeof import('web-push')>('web-push');
  return { default: { ...real.default, sendNotification: (...args: unknown[]) => sendNotification(...args) } };
});
vi.mock('../../src/watcher/fileWatcher', () => ({ FileWatcher: class {} }));
vi.mock('../../src/mapping/nomenclatureMapper', () => ({ NomenclatureMapper: class {} }));

import { createServer } from '../../src/api/server';
import { FileWatcher } from '../../src/watcher/fileWatcher';
import { NomenclatureMapper } from '../../src/mapping/nomenclatureMapper';
import { sendPushToUser, resetVapidCache } from '../../src/notifications/push';

const FCM = 'https://fcm.googleapis.com/fcm/send/device-1';
const sub = (endpoint = FCM) => ({ endpoint, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } });

let app: express.Express;
beforeAll(() => {
  process.env.JWT_SECRET ??= 'test-secret-for-web-push-vapid-encryption-0123456789';
  app = createServer(new FileWatcher() as never, new NomenclatureMapper() as never);
});

async function user(id: number, key: string) {
  await getDb().prepare(
    `INSERT INTO users (id, username, password_hash, api_key, role, notify_events) VALUES (?, ?, 'x', ?, 'user', '[]')`,
  ).run(id, `u${id}`, key);
}

describe.runIf((process.env.DB_NAME || '').includes('test'))('уведомления на телефон (Web Push)', () => {
  beforeEach(async () => {
    await resetDb();
    resetVapidCache();
    sendNotification.mockReset();
    await user(1, 'key-a');
    await user(2, 'key-b');
  });
  afterAll(async () => { await closeTestDb(); });

  it('отдаёт открытый ключ VAPID, один и тот же', async () => {
    const a = await request(app).get('/api/push/key').set('X-API-Key', 'key-a');
    resetVapidCache();
    const b = await request(app).get('/api/push/key').set('X-API-Key', 'key-b');
    expect(a.status).toBe(200);
    expect(a.body.data.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect(b.body.data.publicKey).toBe(a.body.data.publicKey);
  });

  it('принимает подписку только от службы уведомлений браузера', async () => {
    const ok = await request(app).post('/api/push/subscribe').set('X-API-Key', 'key-a').send(sub());
    expect(ok.status).toBe(201);
    const bad = await request(app).post('/api/push/subscribe').set('X-API-Key', 'key-a').send(sub('https://192.168.33.3/x'));
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('endpoint_not_allowed');
    const noKeys = await request(app).post('/api/push/subscribe').set('X-API-Key', 'key-a').send({ endpoint: FCM, keys: { p256dh: 'x', auth: '' } });
    expect(noKeys.status).toBe(400);
  });

  it('телефон после входа в другую компанию получает только её уведомления', async () => {
    await request(app).post('/api/push/subscribe').set('X-API-Key', 'key-a').send(sub());
    await request(app).post('/api/push/subscribe').set('X-API-Key', 'key-b').send(sub());
    sendNotification.mockResolvedValue({ statusCode: 201 });
    expect(await sendPushToUser(1, { title: 't', body: 'b', url: '/m/', tag: 'x', badge: 0 })).toBe(0);
    expect(await sendPushToUser(2, { title: 't', body: 'b', url: '/m/', tag: 'x', badge: 0 })).toBe(1);
  });

  it('отписаться можно только от своей подписки', async () => {
    await request(app).post('/api/push/subscribe').set('X-API-Key', 'key-a').send(sub());
    const foreign = await request(app).post('/api/push/unsubscribe').set('X-API-Key', 'key-b').send({ endpoint: FCM });
    expect(foreign.body.data.removed).toBe(false);
    const own = await request(app).post('/api/push/unsubscribe').set('X-API-Key', 'key-a').send({ endpoint: FCM });
    expect(own.body.data.removed).toBe(true);
  });

  it('шлёт зашифрованное уведомление со ссылкой и числом «Проверить»; ушедшее устройство забывает', async () => {
    await request(app).post('/api/push/subscribe').set('X-API-Key', 'key-a').send(sub());
    await request(app).post('/api/push/subscribe').set('X-API-Key', 'key-a').send(sub('https://web.push.apple.com/device-2'));
    sendNotification
      .mockResolvedValueOnce({ statusCode: 201 })
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 410 }));
    const sent = await sendPushToUser(1, { title: 'Накладная прочитана', body: 'ООО Тест', url: '/m/#/inv/5', tag: 'inv-5' });
    expect(sent).toBe(1);
    const [target, payload, options] = sendNotification.mock.calls[0];
    expect(target.endpoint).toBe(FCM);
    expect(JSON.parse(payload)).toMatchObject({ title: 'Накладная прочитана', url: '/m/#/inv/5', badge: 0 });
    expect(options.vapidDetails.publicKey).toBeTruthy();
    const left = await getDb().prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get<{ n: number }>();
    expect(Number(left?.n)).toBe(1);
  });

  it('сбой службы уведомлений не роняет вызывающего', async () => {
    await request(app).post('/api/push/subscribe').set('X-API-Key', 'key-a').send(sub());
    sendNotification.mockRejectedValue(Object.assign(new Error('boom'), { statusCode: 500 }));
    await expect(sendPushToUser(1, { title: 't', body: 'b', url: '/m/', tag: 'x' })).resolves.toBe(0);
  });
});
