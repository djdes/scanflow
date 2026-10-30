import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const repo = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), remove: vi.fn() }));
vi.mock('../../src/database/repositories/productAssistantRepo', () => ({ productAssistantRepo: repo }));
import { assistantBaseUrl, assistantPublicConfig, assistantReadiness, assistantRequest, saveAssistantConfig } from '../../src/integration/productAssistant';
import { openSecret, sealSecret } from '../../src/sber/secretBox';

const base = 'https://chef.example/api/chef/scanflow';
const connection = (owner = 1, token = 'private-test-token') => ({ owner_user_id: owner, enabled: 1, label: 'Шеф', api_base_url: base,
  api_token_enc: sealSecret(token, `product-assistant-${owner}`) });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('JWT_SECRET', 'test-product-assistant-key-with-more-than-32-characters');
  vi.stubEnv('PRODUCT_ASSISTANT_ALLOWED_ORIGINS', 'https://chef.example,https://other.example');
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url, options) => new Response(JSON.stringify({ ok: true,
    protocol_version: 1, company_id: Number(options.headers['X-ScanFlow-Company-Id']) }))));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('per-company assistant transport and credentials', () => {
  it('distinguishes the running SUB API from a ready catalog and worker', () => {
    expect(assistantReadiness({ upstream_configured: false, last_synced_at: null, worker_online: true })).toMatchObject({ ready: false, message: expect.stringContaining('ключ') });
    expect(assistantReadiness({ upstream_configured: true, last_synced_at: null })).toMatchObject({ ready: false, message: expect.stringContaining('синхронизация') });
    expect(assistantReadiness({ worker_online: false })).toMatchObject({ ready: false, message: expect.stringContaining('обработчик') });
    expect(assistantReadiness({ company_id: 3, upstream_configured: true, last_synced_at: 1793352000, worker_online: true }).ready).toBe(true);
  });
  it('reports missing SUB upstream credentials before sending product data, while permitting status checks', async () => {
    repo.get.mockResolvedValue({ ...connection(3), api_base_url: 'http://127.0.0.1:18092/api/chef/scanflow' });
    vi.stubEnv('PRODUCT_ASSISTANT_ALLOWED_ORIGINS', 'http://127.0.0.1:18092');
    vi.mocked(fetch).mockImplementation(async () => new Response('{"ok":true,"company_id":3,"upstream_configured":false,"last_synced_at":null,"worker_online":true}'));
    expect((await assistantRequest(3, '/status')).company_id).toBe(3);
    await expect(assistantRequest(3, '/products/search?q=private-product')).rejects.toMatchObject({ status: 503, message: expect.stringContaining('ключ') });
    expect(vi.mocked(fetch).mock.calls.every(([url]) => url === 'http://127.0.0.1:18092/api/chef/scanflow/status')).toBe(true);
  });
  it('encrypts tokens separately for each owner and never returns them to settings', async () => {
    repo.get.mockResolvedValue(null);
    await saveAssistantConfig(3, { label: 'Другой бот', enabled: true, api_base_url: 'https://other.example/api/v1/', api_token: 'test-token-for-company-3' });
    const saved = repo.save.mock.calls[0][0];
    expect(saved).toMatchObject({ owner_user_id: 3, api_base_url: 'https://other.example/api/v1', enabled: 1 });
    expect(saved.api_token_enc).not.toContain('test-token-for-company-3');
    expect(openSecret(saved.api_token_enc, 'product-assistant-3')).toBe('test-token-for-company-3');
    expect(() => openSecret(saved.api_token_enc, 'product-assistant-1')).toThrow();
    expect(assistantPublicConfig(saved)).toEqual({ label: 'Другой бот', enabled: true, api_base_url: 'https://other.example/api/v1', token_set: true, protocol_version: 1 });
    expect(JSON.stringify(assistantPublicConfig(saved))).not.toContain(saved.api_token_enc);
  });
  it('retains an unchanged token but requires explicit credentials after changing the API address', async () => {
    const row = connection(); repo.get.mockResolvedValue(row);
    await saveAssistantConfig(1, { label: 'Шеф новый', enabled: false, api_base_url: base });
    expect(repo.save.mock.calls[0][0].api_token_enc).toBe(row.api_token_enc);
    await expect(saveAssistantConfig(1, { label: 'Другой', enabled: true, api_base_url: 'https://other.example/api' })).rejects.toThrow('Введите токен');
  });
  it('rejects unapproved destinations, URL credentials, parameters and non-HTTP protocols', () => {
    for (const url of ['http://127.0.0.1:3000', 'https://evil.example', 'file:///etc/passwd', 'https://user:password@chef.example/api', base + '?token=leak', base + '#fragment']) {
      expect(() => assistantBaseUrl(url)).toThrow();
    }
    expect(assistantBaseUrl(base + '/')).toBe(base);
  });
  it('keeps an absent/disabled integration offline instead of falling back to MAG', async () => {
    repo.get.mockResolvedValue(null);
    await expect(assistantRequest(3, '/status')).rejects.toMatchObject({ status: 503 });
    repo.get.mockResolvedValue({ ...connection(3), enabled: 0 });
    await expect(assistantRequest(3, '/status')).rejects.toMatchObject({ status: 503 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses only the selected company token, bounded requests and no redirects', async () => {
    repo.get.mockResolvedValue(connection(3, 'company-3-secret'));
    const body = { actor_id: 'scanflow-user-3', company_id: 3, message: 'Какой товар?' };
    await assistantRequest(3, '/chat', { body, key: 'question-1' });
    expect(repo.get).toHaveBeenCalledWith(3);
    expect(fetch).toHaveBeenCalledWith(base + '/chat', expect.objectContaining({ method: 'POST', redirect: 'error',
      headers: expect.objectContaining({ Authorization: 'Bearer company-3-secret', 'Idempotency-Key': 'question-1' }), body: JSON.stringify(body) }));
  });
  it('refuses a MAG token configured for another company before sending search or invoice data', async () => {
    repo.get.mockResolvedValue(connection(3));
    vi.mocked(fetch).mockImplementation(async () => new Response('{"ok":true,"company_id":1}'));
    await expect(assistantRequest(3, '/products/search?q=private-product')).rejects.toMatchObject({ status: 409 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(base + '/status');
    expect(vi.mocked(fetch).mock.calls[0][1]?.body).toBeUndefined();
    await expect(saveAssistantConfig(3, { label: 'Чужой шеф', enabled: true, api_base_url: base, api_token: 'mag-token' })).rejects.toMatchObject({ status: 409 });
    expect(repo.save).not.toHaveBeenCalled();
  });
  it('hides upstream authorization errors without logging a user out or echoing credentials', async () => {
    repo.get.mockResolvedValue(connection());
    vi.mocked(fetch).mockResolvedValue(new Response('private-test-token', { status: 401 }));
    await expect(assistantRequest(1, '/status')).rejects.toMatchObject({ status: 502 });
    await expect(assistantRequest(1, '/status')).rejects.not.toThrow('private-test-token');
  });
  it('accepts legacy v1 and rejects explicit unsupported versions and malformed responses', async () => {
    repo.get.mockResolvedValue(connection());
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{"ok":true,"company_id":1}'));
    expect(await assistantRequest(1, '/status')).toEqual({ ok: true, company_id: 1 });
    for (const body of ['{"ok":true,"protocol_version":2}', '[]', 'not-json']) {
      vi.mocked(fetch).mockResolvedValueOnce(new Response(body));
      await expect(assistantRequest(1, '/status')).rejects.toMatchObject({ status: 502 });
    }
  });
});
