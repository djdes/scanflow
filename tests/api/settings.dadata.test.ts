import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';

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
    `INSERT INTO users (id, username, password_hash, api_key, role, notify_events) VALUES (1, 'admin', 'x', 'k', 'admin', '[]')`
  ).run();
  return 'k';
}

describe.runIf((process.env.DB_NAME || '').includes('test'))('settings: DaData API key', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  it('persists dadata_api_key via PUT and reports has_dadata_key via GET', async () => {
    const key = await setupUser();

    const before = await request(app).get('/api/settings/analyzer').set('X-API-Key', key);
    expect(before.status).toBe(200);
    expect(before.body.data.has_dadata_key).toBe(false);

    const put = await request(app).put('/api/settings/analyzer').set('X-API-Key', key)
      .send({ mode: 'hybrid', dadata_api_key: 'my-dadata-key-xyz' });
    expect(put.status).toBe(200);

    const after = await request(app).get('/api/settings/analyzer').set('X-API-Key', key);
    expect(after.body.data.has_dadata_key).toBe(true);

    // stored value is the one we sent
    const row = await getDb().prepare('SELECT dadata_api_key FROM analyzer_config WHERE id = 1').get<{ dadata_api_key: string | null }>();
    expect(row?.dadata_api_key).toBe('my-dadata-key-xyz');
  });

  it('GET returns the stored key values so the admin can view/verify them', async () => {
    const key = await setupUser();
    await request(app).put('/api/settings/analyzer').set('X-API-Key', key)
      .send({ mode: 'claude_api', anthropic_api_key: 'sk-ant-test-123', dadata_api_key: 'dd-test-456' });

    const res = await request(app).get('/api/settings/analyzer').set('X-API-Key', key);
    expect(res.status).toBe(200);
    expect(res.body.data.anthropic_api_key).toBe('sk-ant-test-123');
    expect(res.body.data.dadata_api_key).toBe('dd-test-456');
  });

  it('does not wipe an existing dadata_api_key when PUT omits it', async () => {
    const key = await setupUser();
    await request(app).put('/api/settings/analyzer').set('X-API-Key', key)
      .send({ mode: 'hybrid', dadata_api_key: 'keep-me' });

    // A later save that changes only the mode must not clear the key.
    await request(app).put('/api/settings/analyzer').set('X-API-Key', key)
      .send({ mode: 'hybrid' });

    const row = await getDb().prepare('SELECT dadata_api_key FROM analyzer_config WHERE id = 1').get<{ dadata_api_key: string | null }>();
    expect(row?.dadata_api_key).toBe('keep-me');
  });
});
