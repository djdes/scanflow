import express from 'express';
import request from 'supertest';
import { beforeEach, expect, it, vi } from 'vitest';
import { onecUserRouter } from '../../src/api/routes/onec';
import { getOnecUsage, usageSource } from '../../src/integration/onecUsage';
import { onecNomenclatureRepo } from '../../src/database/repositories/onecNomenclatureRepo';

vi.mock('../../src/integration/onecUsage', () => ({ getOnecUsage: vi.fn(), usageSource: vi.fn(), USAGE_BATCH_SIZE: 40 }));
vi.mock('../../src/database/repositories/onecNomenclatureRepo', () => ({ onecNomenclatureRepo: { listItems: vi.fn() } }));
vi.mock('../../src/database/db', () => ({ getDb: () => { throw new Error('unexpected DB access'); } }));
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
let role = 'admin';
const app = express();
app.use((req, _res, next) => { req.user = { id: 1, username: 'test', role }; next(); });
app.use('/api/onec', onecUserRouter);
beforeEach(() => {
  vi.clearAllMocks(); role = 'admin';
  vi.mocked(usageSource).mockReturnValue({ url: 'http://private.test/mcp', token: 'never-return-this-secret' });
  vi.mocked(onecNomenclatureRepo.listItems).mockResolvedValue([{ guid: A, name: 'Бекон' }] as never);
  vi.mocked(getOnecUsage).mockResolvedValue({ available: true, checkedAt: '2026-10-16T08:00:00Z', rows: new Map([[A, { specifications: 2, receipts: 3 }]]) });
});

it('checks only the explicitly selected owner catalog and returns counts without credentials', async () => {
  const res = await request(app).get(`/api/onec/usage?guids=${A}`).expect(200);
  expect(onecNomenclatureRepo.listItems).toHaveBeenCalledWith({ ownerUserId: 1, excludeFolders: true });
  expect(getOnecUsage).toHaveBeenCalledWith(1, [A]);
  expect(res.body.data).toMatchObject({ owner_user_id: 1, configured: true, available: true, items: [{ guid: A, name: 'Бекон', specifications: 2, receipts: 3 }] });
  expect(JSON.stringify(res.body)).not.toMatch(/private.test|never-return/);
});
it('rejects a GUID from outside the selected company catalog', async () => {
  await request(app).get(`/api/onec/usage?guids=${B}`).expect(400);
  expect(getOnecUsage).not.toHaveBeenCalled();
});
it('has no default source for an unconfigured company', async () => {
  vi.mocked(usageSource).mockReturnValue(null);
  const res = await request(app).get('/api/onec/usage').expect(200);
  expect(res.body.data).toMatchObject({ configured: false, available: false });
  expect(getOnecUsage).not.toHaveBeenCalled();
});
it('does not let an ordinary user inspect another company source', async () => {
  role = 'user';
  await request(app).get(`/api/onec/usage?owner_user_id=3&guids=${A}`).expect(403);
  expect(usageSource).not.toHaveBeenCalled();
});
it('does not grant administrators a cross-company exception and rejects malformed GUIDs', async () => {
  await request(app).get('/api/onec/usage?owner_user_id=3').expect(403);
  await request(app).get('/api/onec/usage?guids=invalid').expect(400);
  expect(getOnecUsage).not.toHaveBeenCalled();
});
