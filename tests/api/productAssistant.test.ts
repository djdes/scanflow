import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ assistant: vi.fn(), saveConfig: vi.fn(), getConfig: vi.fn(), removeConfig: vi.fn(),
  invoice: vi.fn(), item: vi.fn(), catalog: vi.fn(), rejected: vi.fn(), user: vi.fn() }));
vi.mock('../../src/database/repositories/productAssistantRepo', () => ({ productAssistantRepo: { get: mocks.getConfig, remove: mocks.removeConfig } }));
vi.mock('../../src/database/repositories/invoiceRepo', () => ({ invoiceRepo: { getById: mocks.invoice, getItemById: mocks.item } }));
vi.mock('../../src/database/repositories/onecNomenclatureRepo', () => ({ onecNomenclatureRepo: { getByGuid: mocks.catalog } }));
vi.mock('../../src/database/repositories/rejectionRepo', () => ({ rejectionRepo: { guidsFor: mocks.rejected } }));
vi.mock('../../src/database/repositories/userRepo', () => ({ userRepo: { findByApiKey: mocks.user } }));
vi.mock('../../src/utils/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../src/integration/productAssistant', async importOriginal => ({ ...await importOriginal<object>(), assistantRequest: mocks.assistant, saveAssistantConfig: mocks.saveConfig }));
import router from '../../src/api/routes/productAssistant';
import { apiKeyAuth } from '../../src/api/middleware/auth';

const app = express(); app.use(express.json()); app.use('/api/product-assistant', apiKeyAuth, router);
const guid = '492b0be3-9b24-11ee-bc6f-00155d647d01';
const blocked = '492b0be3-9b24-11ee-bc6f-00155d647d02';
const folder = '492b0be3-9b24-11ee-bc6f-00155d647d03';
const foreign = '492b0be3-9b24-11ee-bc6f-00155d647d04';
const rid = '0123456789abcdef0123456789abcdef';
const endpoint = '/api/product-assistant';
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockImplementation(async key => key === 'user-3' ? { id: 3, role: 'admin', username: 'other-company' } : key === 'user-1' ? { id: 1, role: 'admin', username: 'MAG' } : null);
  mocks.getConfig.mockResolvedValue(null);
  mocks.invoice.mockResolvedValue({ id: 7, owner_user_id: 3, supplier: 'Хлеб & сыр' });
  mocks.item.mockResolvedValue({ id: 2, invoice_id: 7, original_name: 'Батон 0.4кг', onec_guid: guid, quantity: 32, unit: 'кг', raw_quantity: 80, raw_unit: 'шт', row_no: 3 });
  mocks.catalog.mockImplementation(async id => id === guid ? { guid, name: 'Батон из своей 1С', unit: 'кг', code: '123', is_folder: 0 } : id === folder ? { guid: folder, is_folder: 1 } : null);
  mocks.rejected.mockResolvedValue(new Set([blocked]));
  mocks.assistant.mockResolvedValue({ ok: true, request_id: rid, session_id: rid, status: 'queued', result: null });
});
const get = (path: string, key = 'user-3') => request(app).get(endpoint + path).set('X-API-Key', key);
const post = (path: string, body: object) => request(app).post(endpoint + path).set('X-API-Key', 'user-3').set('Idempotency-Key', 'selection-or-question-1').send(body);

describe('product assistant API: trusted company scope', () => {
  it('requires authentication and leaves accounts without bots disabled', async () => {
    expect((await request(app).get(endpoint + '/config')).status).toBe(401);
    const result = await get('/config');
    expect(result.body.data).toMatchObject({ enabled: false, token_set: false });
    expect(mocks.getConfig).toHaveBeenCalledWith(3);
    expect(mocks.assistant).not.toHaveBeenCalled();
  });
  it('returns only public own config and scopes updates/deletion to the authenticated account', async () => {
    mocks.getConfig.mockResolvedValue({ enabled: 1, label: 'Другой бот', api_base_url: 'https://example.test/api', api_token_enc: 'encrypted-private-token' });
    const result = await get('/config'); expect(JSON.stringify(result.body)).not.toContain('encrypted-private-token');
    const body = { owner_user_id: 1, enabled: true, label: 'Свой', api_base_url: 'https://example.test/api', api_token: 'private' };
    expect((await request(app).put(endpoint + '/config').set('X-API-Key', 'user-3').send(body)).status).toBe(200);
    expect(mocks.saveConfig).toHaveBeenCalledWith(3, body);
    await request(app).delete(endpoint + '/config').set('X-API-Key', 'user-3');
    expect(mocks.removeConfig).toHaveBeenCalledWith(3);
  });
  it('refuses other-company invoices even for administrators and rejects mismatched row/invoice pairs', async () => {
    expect((await get('/products/search?q=батон&invoice_id=7&item_id=2', 'user-1')).status).toBe(404);
    mocks.item.mockResolvedValueOnce({ id: 2, invoice_id: 8 });
    expect((await get('/products/search?q=батон&invoice_id=7&item_id=2')).status).toBe(404);
    expect(mocks.assistant).not.toHaveBeenCalled();
  });
  it('encodes search parameters and excludes forbidden, folder and unknown catalog products', async () => {
    mocks.assistant.mockResolvedValue({ ok: true, products: [guid, blocked, folder, foreign].map(id => ({ onec_guid: id, name: 'remote-name', times_selected: 80 })) });
    const result = await get('/products/search?q=' + encodeURIComponent('батон & сыр') + '&invoice_id=7&item_id=2&supplier=forged');
    expect(result.status).toBe(200);
    expect(result.body.data.products).toEqual([expect.objectContaining({ onec_guid: guid, name: 'Батон из своей 1С', times_selected: 80 })]);
    const [company, path] = mocks.assistant.mock.calls[0];
    expect(company).toBe(3);
    const params = new URL('https://example.test' + path).searchParams;
    expect(params.get('q')).toBe('батон & сыр'); expect(params.get('scanned_name')).toBe('Батон 0.4кг'); expect(params.get('supplier')).toBe('Хлеб & сыр');
    expect(mocks.catalog).toHaveBeenCalledWith(guid, 3);
  });
  it('constructs actor, company, raw quantity and context on the server, keeping the caller idempotency key', async () => {
    const result = await post('/chat', { invoice_id: 7, item_id: 2, message: 'Как пересчитать?', actor_id: 'scanflow-user-1', company_id: 1,
      context: { scanned_name: 'forged' }, candidate_guids: [guid, blocked, foreign], session_id: rid });
    expect(result.status).toBe(202);
    expect(mocks.assistant).toHaveBeenCalledWith(3, '/chat', expect.objectContaining({ key: 'selection-or-question-1', body: {
      actor_id: 'scanflow-user-3', company_id: 3, message: 'Как пересчитать?', auto_learn: false, session_id: rid,
      context: { scanned_name: 'Батон 0.4кг', supplier: 'Хлеб & сыр', invoice_id: 7, row_no: 3, quantity: 80, unit: 'шт', candidate_guids: [guid] },
    } }));
  });
  it('rejects invalid input and missing idempotency instead of enqueueing a question', async () => {
    expect((await post('/chat', { invoice_id: 7, item_id: 2, message: 'x', candidate_guids: ['not-uuid'] })).status).toBe(400);
    expect((await post('/chat', { invoice_id: 7, item_id: 2, message: 'x'.repeat(8001) })).status).toBe(400);
    expect((await request(app).post(endpoint + '/chat').set('X-API-Key', 'user-3').send({ invoice_id: 7, item_id: 2, message: 'x' })).status).toBe(400);
    expect((await get('/products/search?q=x&invoice_id=7junk&item_id=2')).status).toBe(400);
    expect(mocks.assistant).not.toHaveBeenCalled();
  });
  it('omits unknown optional values to satisfy the strict SUB OpenAPI context schema', async () => {
    mocks.item.mockResolvedValue({ id: 2, invoice_id: 7, original_name: 'Товар SUB', quantity: null, unit: null, row_no: null });
    expect((await post('/chat', { invoice_id: 7, item_id: 2, message: 'Какой товар выбрать?' })).status).toBe(202);
    const context = mocks.assistant.mock.calls[0][2].body.context;
    expect(context).toMatchObject({ scanned_name: 'Товар SUB', invoice_id: 7, candidate_guids: [] });
    expect(context).not.toHaveProperty('quantity'); expect(context).not.toHaveProperty('unit'); expect(context).not.toHaveProperty('row_no');
  });
  it('scopes polling to the authenticated actor, ignoring browser actor and external poll_url', async () => {
    mocks.assistant.mockResolvedValue({ ok: true, status: 'completed', result: { answer: 'ответ', match: { onec_guid: foreign } }, poll_url: 'http://evil.example' });
    const result = await get(`/requests/${rid}?actor_id=scanflow-user-1&invoice_id=7&item_id=2`);
    expect(result.body.data.result.match).toBe(null);
    expect(mocks.assistant).toHaveBeenCalledWith(3, `/requests/${rid}?actor_id=scanflow-user-3`);
  });
  it('requires a saved human selection before sending a confirmed mapping to knowledge', async () => {
    mocks.item.mockResolvedValueOnce({ id: 2, invoice_id: 7, original_name: 'Батон', onec_guid: null });
    expect((await post('/mappings', { invoice_id: 7, item_id: 2, onec_guid: guid })).status).toBe(409);
    expect(mocks.assistant).not.toHaveBeenCalled();
    expect((await post('/mappings', { invoice_id: 7, item_id: 2, onec_guid: guid })).status).toBe(202);
    expect(mocks.assistant).toHaveBeenCalledWith(3, '/mappings', expect.objectContaining({ body: { actor_id: 'scanflow-user-3', company_id: 3,
      scanned_name: 'Батон 0.4кг', onec_guid: guid, supplier: 'Хлеб & сыр' } }));
  });
  it('does not send a rejected mapping and does not expose unexpected internal errors', async () => {
    expect((await post('/mappings', { invoice_id: 7, item_id: 2, onec_guid: blocked })).status).toBe(409);
    mocks.assistant.mockRejectedValueOnce(new Error('private-token-in-internal-error'));
    const result = await get('/status');
    expect(result.status).toBe(500); expect(JSON.stringify(result.body)).not.toContain('private-token');
  });
});
