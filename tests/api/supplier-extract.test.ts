import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { supplierExtractJobRepo } from '../../src/database/repositories/supplierExtractJobRepo';

vi.mock('../../src/watcher/fileWatcher', () => ({ FileWatcher: class {} }));
vi.mock('../../src/mapping/nomenclatureMapper', () => ({ NomenclatureMapper: class {} }));

import { createServer } from '../../src/api/server';
import { FileWatcher } from '../../src/watcher/fileWatcher';
import { NomenclatureMapper } from '../../src/mapping/nomenclatureMapper';

let app: express.Express;
beforeAll(() => {
  app = createServer(new FileWatcher() as never, new NomenclatureMapper() as never);
});

async function setupUser(): Promise<string> {
  await getDb().prepare(
    `INSERT INTO users (id, username, password_hash, api_key, role, notify_events)
     VALUES (1, 'admin', 'x', 'k', 'admin', '[]')`
  ).run();
  return 'k';
}

const TOKEN = 'a'.repeat(64);

async function makeJob(): Promise<number> {
  return supplierExtractJobRepo.create({
    token: TOKEN, file_name: 'pay.pdf', file_path: '/tmp/none-pay.pdf', content_type: 'application/pdf',
  });
}

describe.runIf((process.env.DB_NAME || '').includes('test'))('supplier requisite extraction', () => {
  beforeEach(async () => { await resetDb(); await setupUser(); });
  afterAll(async () => { await closeTestDb(); });

  it('repo: create → setResult → done; setError → error', async () => {
    const id = await makeJob();
    expect((await supplierExtractJobRepo.getById(id))?.status).toBe('processing');

    await supplierExtractJobRepo.setResult(id, JSON.stringify({ inn: '7707083893' }));
    const done = await supplierExtractJobRepo.getById(id);
    expect(done?.status).toBe('done');
    expect(JSON.parse(done!.result_json!).inn).toBe('7707083893');

    const id2 = await makeJob();
    await supplierExtractJobRepo.setError(id2, 'boom');
    expect((await supplierExtractJobRepo.getById(id2))?.status).toBe('error');
  });

  it('repo: markStaleAsFailed flips old processing jobs to error', async () => {
    const id = await makeJob();
    await getDb().prepare(`UPDATE supplier_extract_jobs SET created_at = NOW() - INTERVAL 20 MINUTE WHERE id = ?`).run(id);
    const fresh = await makeJob(); // recent — must NOT be swept

    const n = await supplierExtractJobRepo.markStaleAsFailed(15);
    expect(n).toBe(1);
    expect((await supplierExtractJobRepo.getById(id))?.status).toBe('error');
    expect((await supplierExtractJobRepo.getById(fresh))?.status).toBe('processing');
  });

  it('callback stores requisites; extract-status returns them', async () => {
    const id = await makeJob();
    const res = await request(app).post(`/api/dispatcher/supplier-result/${id}`).send({
      token: TOKEN,
      success: true,
      data: { inn: '7707083893', kpp: '770701001', name: 'ООО "Ромашка"', bank_bic: '044525225', account: '40702810400000000001' },
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('done');

    const st = await request(app).get(`/api/suppliers/extract-status/${id}`).set('X-API-Key', 'k');
    expect(st.status).toBe(200);
    expect(st.body.status).toBe('done');
    expect(st.body.extracted.inn).toBe('7707083893');
    expect(st.body.extracted.name).toBe('ООО "Ромашка"');
    expect(st.body.extracted.bank_bic).toBe('044525225');
  });

  it('callback rejects an invalid token (401)', async () => {
    const id = await makeJob();
    const res = await request(app).post(`/api/dispatcher/supplier-result/${id}`).send({
      token: 'b'.repeat(64), success: true, data: { inn: '7707083893' },
    });
    expect(res.status).toBe(401);
    expect((await supplierExtractJobRepo.getById(id))?.status).toBe('processing');
  });

  it('callback error path sets status=error and extract-status reports it', async () => {
    const id = await makeJob();
    const res = await request(app).post(`/api/dispatcher/supplier-result/${id}`).send({
      token: TOKEN, success: false, error: 'реквизиты не найдены',
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('error');

    const st = await request(app).get(`/api/suppliers/extract-status/${id}`).set('X-API-Key', 'k');
    expect(st.body.status).toBe('error');
    expect(st.body.error).toContain('реквизиты');
  });

  it('callback is single-use: a second call with the same token is 401 (job no longer processing)', async () => {
    const id = await makeJob();
    await request(app).post(`/api/dispatcher/supplier-result/${id}`).send({ token: TOKEN, success: true, data: { inn: '7707083893' } });
    const again = await request(app).post(`/api/dispatcher/supplier-result/${id}`).send({ token: TOKEN, success: true, data: { inn: '0000000000' } });
    expect(again.status).toBe(401);
  });

  it('photo-job rejects bad token (401), accepts valid token but 404 when file missing', async () => {
    const id = await makeJob();
    const bad = await request(app).get(`/api/dispatcher/photo-job/${id}?token=${'c'.repeat(64)}`);
    expect(bad.status).toBe(401);
    const ok = await request(app).get(`/api/dispatcher/photo-job/${id}?token=${TOKEN}`);
    expect(ok.status).toBe(404); // token valid, but the fixture file isn't on disk
  });

  it('prompt-supplier serves a non-empty plain-text prompt', async () => {
    const res = await request(app).get('/api/dispatcher/prompt-supplier');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain('ПОЛУЧАТЕЛ'); // payee-focused
  });
});
