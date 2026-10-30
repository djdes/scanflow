import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestDb, resetDb } from '../helpers/db';
import { productAssistantRepo } from '../../src/database/repositories/productAssistantRepo';
import { assistantPublicConfig, saveAssistantConfig } from '../../src/integration/productAssistant';
import { openSecret } from '../../src/sber/secretBox';

describe.runIf((process.env.DB_NAME || '').includes('test'))('assistant connection persistence (migration 93)', () => {
  beforeEach(async () => {
    await resetDb();
    vi.stubEnv('JWT_SECRET', 'test-only-product-assistant-database-encryption-key');
    vi.stubEnv('PRODUCT_ASSISTANT_ALLOWED_ORIGINS', 'https://chef.test,https://other.test');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url, options) => new Response(JSON.stringify({ ok: true,
      company_id: Number(options.headers['X-ScanFlow-Company-Id']) }))));
  });
  afterAll(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await closeTestDb(); });
  it('persists independent encrypted connections, preserves tokens on edits and deletes only the selected company', async () => {
    await saveAssistantConfig(1, { label: 'Шеф MAG', api_base_url: 'https://chef.test/api/chef/scanflow', api_token: 'test-mag-secret', enabled: true });
    await saveAssistantConfig(3, { label: 'Другой бот', api_base_url: 'https://other.test/api', api_token: 'test-other-secret', enabled: false });
    const a = (await productAssistantRepo.get(1))!;
    const b = (await productAssistantRepo.get(3))!;
    expect(openSecret(a.api_token_enc, 'product-assistant-1')).toBe('test-mag-secret');
    expect(openSecret(b.api_token_enc, 'product-assistant-3')).toBe('test-other-secret');
    expect(assistantPublicConfig(a)).toMatchObject({ enabled: true, token_set: true, label: 'Шеф MAG' });
    expect(assistantPublicConfig(b)).toMatchObject({ enabled: false, token_set: true, label: 'Другой бот' });
    await saveAssistantConfig(1, { label: 'Переименованный шеф', api_base_url: a.api_base_url, enabled: false });
    expect(await productAssistantRepo.get(1)).toMatchObject({ label: 'Переименованный шеф', api_token_enc: a.api_token_enc, enabled: 0 });
    await productAssistantRepo.remove(1);
    expect(await productAssistantRepo.get(1)).toBe(null);
    expect(await productAssistantRepo.get(3)).toMatchObject(b);
    expect(await productAssistantRepo.get(99)).toBe(null);
  });
});
