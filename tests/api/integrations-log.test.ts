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
import { logIntegrationEvent } from '../../src/integration/integrationLog';

let app: express.Express;
beforeAll(() => { app = createServer(new FileWatcher() as never, new NomenclatureMapper() as never); });

async function seed(): Promise<void> {
  const db = getDb();
  await db.prepare(`INSERT INTO users (id, username, password_hash, api_key, role, notify_events) VALUES
    (1, 'admin', 'x', 'k-admin', 'admin', '[]'), (3, 'zakupki', 'x', 'k-user', 'user', '[]'), (4, 'other', 'x', 'k-other', 'user', '[]')`).run();
  await db.prepare(`INSERT INTO invoices (id, file_name, file_path, status, invoice_number, owner_user_id) VALUES
    (787, 'a', '/a', 'sent_to_1c', '17-0605773', 3), (900, 'b', '/b', 'processed', 'X-1', 4)`).run();
  await db.prepare(`INSERT INTO onec_connections (owner_user_id, name, token_hash, token_prefix, active, last_used_at)
    VALUES (3, 'Подключение 1С', 'h', 'p', 1, '2026-10-09 14:36:48')`).run();
  await logIntegrationEvent({ integration: '1c', event_type: 'document_posted', invoice_id: 787, summary: '1С: posted' });
  await logIntegrationEvent({ integration: '1c', event_type: 'approved', invoice_id: 900, summary: 'чужая' });
  await logIntegrationEvent({ integration: 'sber', event_type: 'token_refreshed', summary: 'платформа' });
}

describe.runIf((process.env.DB_NAME || '').includes('test'))('GET /api/integrations/log — журнал своей компании', () => {
  beforeEach(async () => { await resetDb(); await seed(); });
  afterAll(async () => { await closeTestDb(); });

  it('пользователь видит только события своей компании и связь своей 1С (раньше — 403)', async () => {
    const res = await request(app).get('/api/integrations/log').set('X-API-Key', 'k-user');
    expect(res.status).toBe(200);
    expect(res.body.data.map((e: { summary: string }) => e.summary)).toEqual(['1С: posted']);
    expect(res.body.onec_last_poll_at).toBe('2026-10-09 14:36:48');
  });

  it('у компании без подключения 1С связи нет; чужих событий не видно', async () => {
    const res = await request(app).get('/api/integrations/log').set('X-API-Key', 'k-other');
    expect(res.body.data.map((e: { summary: string }) => e.summary)).toEqual(['чужая']);
    expect(res.body.onec_last_poll_at).toBeNull();
  });

  it('админ видит всю платформу', async () => {
    const res = await request(app).get('/api/integrations/log').set('X-API-Key', 'k-admin');
    expect(res.body.data).toHaveLength(3);
  });
});
