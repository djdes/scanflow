import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import express from 'express';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import jsQR from 'jsqr';
import request from 'supertest';
import authRouter from '../../src/api/routes/auth';
import { getDb } from '../../src/database/db';
import { userRepo } from '../../src/database/repositories/userRepo';
import { closeTestDb, resetDb } from '../helpers/db';

const app = express().use(express.json()).use('/api/auth', authRouter);
const issue = () => request(app).post('/api/auth/phone-qr').set('X-API-Key', 'phone-test-key');
const consume = (token: string) => request(app).post('/api/auth/phone-qr/consume').send({ token });

async function issueAndDecode(): Promise<string> {
  const response = await issue();
  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body.expiresIn).toBe(120);
  const image = await loadImage(response.body.image);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, image.width, image.height);
  const qr = jsQR(pixels.data, pixels.width, pixels.height);
  expect(qr).toBeTruthy();
  const url = new URL(qr!.data);
  expect(url.pathname).toBe('/m/');
  expect(url.search).toBe('');
  expect(url.hash).toMatch(/^#\/qr-login\/[a-f0-9]{64}$/);
  return url.hash.split('/').pop()!;
}

describe.runIf((process.env.DB_NAME || '').includes('test'))('phone QR login', () => {
  beforeEach(async () => {
    await resetDb();
    await getDb().prepare(
      `INSERT INTO users (username, password_hash, api_key, role, notify_events)
       VALUES ('phone_test', 'x', 'phone-test-key', 'user', '[]')`,
    ).run();
  });
  afterAll(closeTestDb);

  it('requires authentication to issue a QR', async () => {
    expect((await request(app).post('/api/auth/phone-qr')).status).toBe(401);
  });

  it('stores only the hash and exchanges the decoded token once under concurrent requests', async () => {
    const token = await issueAndDecode();
    const row = await getDb().prepare(
      `SELECT HEX(phone_login_hash) AS hash FROM users WHERE username = 'phone_test'`,
    ).get<{ hash: string }>();
    expect(row?.hash.toLowerCase()).toBe(createHash('sha256').update(token).digest('hex'));

    const responses = await Promise.all([consume(token), consume(token)]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 404]);
    const success = responses.find(r => r.status === 200);
    expect(success?.headers['cache-control']).toBe('no-store');
    expect(success?.body).toMatchObject({ apiKey: 'phone-test-key', username: 'phone_test', role: 'user' });
  });

  it('rejects replaced, expired and blocked codes', async () => {
    const replaced = await issueAndDecode();
    const expired = await issueAndDecode();
    expect((await consume(replaced)).status).toBe(404);
    await getDb().prepare(`UPDATE users SET phone_login_expires_at = NOW() WHERE username = 'phone_test'`).run();
    expect((await consume(expired)).status).toBe(404);

    const blocked = await issueAndDecode();
    await getDb().prepare(`UPDATE users SET is_blocked = 1 WHERE username = 'phone_test'`).run();
    expect((await consume(blocked)).status).toBe(404);
    expect((await issue()).status).toBe(403);
  });

  it('invalidates issued codes when credentials are changed', async () => {
    const user = await userRepo.findByUsername('phone_test');
    const beforePasswordChange = await issueAndDecode();
    await userRepo.updatePasswordHash(user!.id, 'changed');
    expect((await consume(beforePasswordChange)).status).toBe(404);

    const beforeKeyChange = await issueAndDecode();
    await userRepo.updateApiKey(user!.id, 'phone-test-rotated-key');
    expect((await consume(beforeKeyChange)).status).toBe(404);
  });
});
