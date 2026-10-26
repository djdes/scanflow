import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { resetDb, closeTestDb } from '../helpers/db';
import { userRepo } from '../../src/database/repositories/userRepo';
import { consentRepo } from '../../src/database/repositories/consentRepo';
import { PD_CONSENT_VERSION } from '../../src/legal/documents';

vi.mock('../../src/watcher/fileWatcher', () => ({ FileWatcher: class {} }));
vi.mock('../../src/mapping/nomenclatureMapper', () => ({ NomenclatureMapper: class {} }));
vi.mock('../../src/utils/mailer', () => ({ sendAuthEmail: vi.fn().mockResolvedValue(undefined) }));

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

// 152-ФЗ: согласие на обработку ПДн — отдельная галочка; без неё аккаунт не создаётся,
// а данное согласие записывается в pd_consents (кто, когда, какая редакция, откуда).
describe.runIf((process.env.DB_NAME || '').includes('test'))('registration requires PD consent', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  it('register-email without consent is rejected and creates nothing', async () => {
    for (const body of [{ email: 'no@example.test' }, { email: 'no@example.test', pd_consent: 'true' }]) {
      const res = await request(app).post('/api/auth/register-email').send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('pd_consent_required');
    }
    expect(await userRepo.findByEmail('no@example.test')).toBeFalsy();
    expect(await consentRepo.listByEmail('no@example.test')).toHaveLength(0);
  });

  it('register-email with consent creates the account and records the consent', async () => {
    const res = await request(app)
      .post('/api/auth/register-email')
      .set('User-Agent', 'consent-test/1.0')
      .send({ email: 'Yes@Example.test', pd_consent: true });
    expect(res.status).toBe(201);
    const user = await userRepo.findByEmail('yes@example.test');
    expect(user).toBeTruthy();
    const rows = await consentRepo.listByEmail('yes@example.test');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: user!.id,
      document: 'pd_consent',
      version: PD_CONSENT_VERSION,
      user_agent: 'consent-test/1.0',
    });
    expect(rows[0].ip).toBeTruthy();
  });

  it('a repeated registration for a known email records the consent again', async () => {
    await request(app).post('/api/auth/register-email').send({ email: 'twice@example.test', pd_consent: true });
    const again = await request(app).post('/api/auth/register-email').send({ email: 'twice@example.test', pd_consent: true });
    expect(again.status).toBe(200);
    expect(await consentRepo.listByEmail('twice@example.test')).toHaveLength(2);
  });

  it('API /register also needs consent', async () => {
    const body = { username: 'api_user', password: 'secret123', email: 'api@example.test' };
    const denied = await request(app).post('/api/auth/register').send(body);
    expect(denied.status).toBe(400);
    expect(denied.body.code).toBe('pd_consent_required');
    const ok = await request(app).post('/api/auth/register').send({ ...body, pd_consent: true });
    expect(ok.status).toBe(201);
    expect(await consentRepo.listByEmail('api@example.test')).toHaveLength(1);
  });
});
