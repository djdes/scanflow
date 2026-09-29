import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/sber/sberClient', () => ({ sberFetch: vi.fn() }));
vi.mock('../../src/database/repositories/sberAppRepo', () => ({
  sberAppRepo: { get: vi.fn(async () => null), saveSecret: vi.fn(async () => {}), setError: vi.fn(async () => {}) },
}));
vi.mock('../../src/database/repositories/sberTokenRepo', () => ({
  sberTokenRepo: {
    get: vi.fn(), updateTokens: vi.fn(async () => {}), setRefreshMeta: vi.fn(async () => {}), listOwners: vi.fn(async () => [1]),
  },
}));
vi.mock('../../src/database/repositories/sberPaymentRepo', () => ({
  sberPaymentRepo: { listToPoll: vi.fn(), updateBankStatus: vi.fn(async () => {}), markChecked: vi.fn(async () => {}) },
}));
vi.mock('../../src/services/ownerAlerts', () => ({ sendOwnerAlert: vi.fn(async () => true) }));
vi.mock('../../src/integration/integrationLog', () => ({ logIntegrationEvent: vi.fn(async () => {}) }));

import { sberFetch } from '../../src/sber/sberClient';
import { sberAppRepo } from '../../src/database/repositories/sberAppRepo';
import { sberTokenRepo } from '../../src/database/repositories/sberTokenRepo';
import { sberPaymentRepo } from '../../src/database/repositories/sberPaymentRepo';
import { sendOwnerAlert } from '../../src/services/ownerAlerts';
import { sealSecret, openSecret } from '../../src/sber/secretBox';
import { parseDbUtc, sqlUtc, makeSecretPerpetual, setClientSecretFromUser } from '../../src/sber/appCredentials';
import { withSberToken, getValidAccessToken, describeTokenError } from '../../src/sber/oauth';
import { SberApiError, bankStatusKind, isFinalBankStatus, bankStatusLabel } from '../../src/sber/payments';
import { pollSberPaymentStatuses, keepSberTokensAlive } from '../../src/services/sberMaintenance';

const ok = (body: unknown) => ({ status: 200, ok: true, body: JSON.stringify(body), json<T>() { return JSON.parse(this.body) as T; } });
const fail = (status: number, body: unknown) => ({ status, ok: false, body: JSON.stringify(body), json<T>() { return JSON.parse(this.body) as T; } });

beforeEach(() => {
  vi.mocked(sberFetch).mockReset();
  process.env.JWT_SECRET = 'test-secret-must-be-at-least-32-chars-long';
  process.env.SBER_CLIENT_ID = '40285';
  process.env.SBER_CLIENT_SECRET = 'env-secret';
});

describe('secretBox', () => {
  it('seals and opens; ciphertext does not contain the secret', () => {
    const sealed = sealSecret('my-client-secret-123');
    expect(sealed.startsWith('v1:')).toBe(true);
    expect(sealed).not.toContain('my-client-secret');
    expect(openSecret(sealed)).toBe('my-client-secret-123');
  });

  it('refuses a tampered value', () => {
    const sealed = sealSecret('abc12345');
    const broken = sealed.slice(0, -4) + (sealed.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(() => openSecret(broken)).toThrow();
  });
});

describe('UTC dates from the DB', () => {
  it('reads DATETIME without Z as UTC (server runs in MSK)', () => {
    expect(parseDbUtc('2026-10-29 06:05:22')!.toISOString()).toBe('2026-10-29T06:05:22.000Z');
    expect(parseDbUtc('2026-10-29T06:05:22.000Z')!.toISOString()).toBe('2026-10-29T06:05:22.000Z');
    expect(parseDbUtc(null)).toBeNull();
    expect(sqlUtc(new Date('2026-10-29T06:05:22.123Z'))).toBe('2026-10-29 06:05:22');
  });
});

describe('client_secret → perpetual', () => {
  it('stores the new perpetual secret right after the bank answers', async () => {
    vi.mocked(sberFetch).mockResolvedValue(ok({ clientSecret: 'PERPETUAL-NEW' }));
    await makeSecretPerpetual('old-secret');
    const [url, init] = vi.mocked(sberFetch).mock.calls[0];
    expect(url).toBe('https://fintech.sberbank.ru:9443/fintech/api/applications/secrets/v1/refresh-client-secret');
    expect(JSON.parse(String((init as { body: string }).body))).toEqual({ clientId: '40285', clientSecret: 'old-secret' });
    const saved = vi.mocked(sberAppRepo.saveSecret).mock.calls.at(-1)!;
    expect(openSecret(saved[1])).toBe('PERPETUAL-NEW');
    expect(saved[2]).toEqual({ perpetual: true, expiresAt: null });
  });

  it('a user secret is kept for 40 days when the exchange fails, with the reason', async () => {
    vi.mocked(sberFetch).mockResolvedValue(fail(403, { cause: 'CERTIFICATE_ACCESS_EXCEPTION', message: 'нет в белом списке' }));
    const r = await setClientSecretFromUser('fresh-from-cabinet');
    expect(r.perpetual).toBe(false);
    expect(r.warning).toMatch(/TLS-сертификат/);
    const firstSave = vi.mocked(sberAppRepo.saveSecret).mock.calls.at(-1)!;
    expect(firstSave[2].perpetual).toBe(false);
    expect(firstSave[2].expiresAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('can be saved as a 40-day secret without exchanging (another program uses it)', async () => {
    const r = await setClientSecretFromUser('keep-as-is-secret', { makePerpetual: false });
    expect(r).toEqual({ perpetual: false });
    expect(sberFetch).not.toHaveBeenCalled();
  });
});

describe('token errors → actions', () => {
  it('maps invalid_client and invalid_grant to clear Russian actions', () => {
    expect(describeTokenError(401, '{"error":"invalid_client"}').code).toBe('invalid_client');
    expect(describeTokenError(400, '{"error":"invalid_grant","error_description":"expired"}').message).toMatch(/Переподключите/);
    expect(describeTokenError(403, 'nope').code).toBe('forbidden');
  });
});

describe('withSberToken', () => {
  const row = (expiresInMs: number) => ({
    owner_user_id: 1, access_token: 'OLD', refresh_token: 'R1',
    expires_at: sqlUtc(new Date(Date.now() + expiresInMs)),
  });

  it('uses a valid token as is (UTC expiry, no needless refresh)', async () => {
    vi.mocked(sberTokenRepo.get).mockResolvedValue(row(50 * 60_000) as never);
    expect(await getValidAccessToken(1)).toBe('OLD');
    expect(sberFetch).not.toHaveBeenCalled();
  });

  it('on 401 refreshes once and retries with the new token', async () => {
    vi.mocked(sberTokenRepo.get).mockResolvedValue(row(50 * 60_000) as never);
    vi.mocked(sberFetch).mockResolvedValue(ok({ access_token: 'NEW', refresh_token: 'R2', expires_in: 3600 }));
    const calls: string[] = [];
    const out = await withSberToken(1, async (t) => {
      calls.push(t);
      if (t === 'OLD') throw new SberApiError(401, 'expired');
      return 'done';
    });
    expect(out).toBe('done');
    expect(calls).toEqual(['OLD', 'NEW']);
    expect(sberTokenRepo.updateTokens).toHaveBeenCalledWith(expect.objectContaining({ access_token: 'NEW', refresh_token: 'R2' }), 1);
    expect(sberTokenRepo.setRefreshMeta).toHaveBeenCalledWith(1, { ok: true, source: 'refresh' });
  });

  it('a failed refresh is recorded on the connection and rethrown', async () => {
    vi.mocked(sberTokenRepo.get).mockResolvedValue(row(-60_000) as never);
    vi.mocked(sberFetch).mockResolvedValue(fail(401, { error: 'invalid_client' }));
    await expect(getValidAccessToken(1)).rejects.toThrow(/client_secret/);
    expect(sberTokenRepo.setRefreshMeta).toHaveBeenCalledWith(1, expect.objectContaining({ ok: false }));
  });
});

describe('bank statuses', () => {
  it('classifies final and intermediate statuses', () => {
    expect(bankStatusKind('IMPLEMENTED')).toBe('paid');
    expect(bankStatusKind('REFUSEDBYBANK')).toBe('failed');
    expect(bankStatusKind('CREATED')).toBe('draft');
    expect(bankStatusKind('DELIVERED')).toBe('in_progress');
    expect(isFinalBankStatus('CARD2')).toBe(false);
    expect(isFinalBankStatus('NOT_FOUND')).toBe(true);
    expect(bankStatusLabel('IMPLEMENTED')).toBe('Исполнен');
  });
});

describe('pollSberPaymentStatuses', () => {
  beforeEach(() => {
    vi.mocked(sberTokenRepo.get).mockResolvedValue({ owner_user_id: 1, access_token: 'T', refresh_token: 'R', expires_at: sqlUtc(new Date(Date.now() + 3_600_000)) } as never);
    vi.mocked(sendOwnerAlert).mockClear();
    vi.mocked(sberPaymentRepo.updateBankStatus).mockClear();
  });

  it('stores statuses and alerts the owner once on a bank refusal', async () => {
    vi.mocked(sberPaymentRepo.listToPoll).mockResolvedValue([
      { invoice_id: 10, external_id: 'e-10', bank_status: 'CREATED', owner_user_id: 1, invoice_number: '1', supplier: 'А', amount: 100 },
      { invoice_id: 11, external_id: 'e-11', bank_status: 'CREATED', owner_user_id: 1, invoice_number: '2', supplier: 'Б', amount: 200 },
      { invoice_id: 12, external_id: 'e-12', bank_status: null, owner_user_id: 1, invoice_number: '3', supplier: 'В', amount: 300 },
    ]);
    vi.mocked(sberFetch)
      .mockResolvedValueOnce(ok({ bankStatus: 'IMPLEMENTED' }))
      .mockResolvedValueOnce(ok({ bankStatus: 'REFUSEDBYBANK', bankComment: 'Неверный счёт' }))
      .mockResolvedValueOnce(fail(404, { cause: 'WORKFLOW_FAULT' }));
    const r = await pollSberPaymentStatuses({ minAgeMinutes: 0 });
    expect(r).toMatchObject({ checked: 2, changed: 3, errors: 0 });
    expect(sberPaymentRepo.updateBankStatus).toHaveBeenCalledWith(10, 'IMPLEMENTED', null);
    expect(sberPaymentRepo.updateBankStatus).toHaveBeenCalledWith(11, 'REFUSEDBYBANK', 'Неверный счёт');
    expect(sberPaymentRepo.updateBankStatus).toHaveBeenCalledWith(12, 'NOT_FOUND', null);
    expect(sendOwnerAlert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendOwnerAlert).mock.calls[0][1]).toBe('pay_fail:11');
  }, 10_000);
});

describe('keepSberTokensAlive', () => {
  it('without a perpetual key keeps the long cabinet token and does not refresh early', async () => {
    vi.mocked(sberAppRepo.get).mockResolvedValue(null);
    vi.mocked(sberTokenRepo.listOwners).mockResolvedValue([1]);
    vi.mocked(sberTokenRepo.get).mockResolvedValue({
      owner_user_id: 1, access_token: 'T', refresh_token: 'R', expires_at: sqlUtc(new Date(Date.now() + 20 * 86_400_000)),
      last_refresh_at: sqlUtc(new Date(Date.now() - 2 * 86_400_000)),
    } as never);
    const r = await keepSberTokensAlive();
    expect(r).toEqual({ refreshed: 0, failed: 0 });
    expect(sberFetch).not.toHaveBeenCalled();
  });

  it('refreshes a cabinet token 3 days before it ends and alerts the owner when that fails', async () => {
    vi.mocked(sberAppRepo.get).mockResolvedValue(null);
    vi.mocked(sberTokenRepo.listOwners).mockResolvedValue([1]);
    vi.mocked(sberTokenRepo.get).mockResolvedValue({
      owner_user_id: 1, access_token: 'T', refresh_token: 'R', expires_at: sqlUtc(new Date(Date.now() + 2 * 86_400_000)),
    } as never);
    vi.mocked(sberFetch).mockResolvedValue(fail(401, { error: 'invalid_client' }));
    vi.mocked(sendOwnerAlert).mockClear();
    const r = await keepSberTokensAlive();
    expect(r).toEqual({ refreshed: 0, failed: 1 });
    expect(vi.mocked(sendOwnerAlert).mock.calls[0][1]).toBe('sber_auth');
  });

  it('with a perpetual key refreshes daily and alerts the owner when it fails', async () => {
    vi.mocked(sberAppRepo.get).mockResolvedValue({
      id: 1, client_id: '40285', client_secret_enc: sealSecret('perpetual-secret'), secret_set_at: null,
      secret_expires_at: null, secret_perpetual: 1, last_error: null, updated_at: '',
    });
    vi.mocked(sberTokenRepo.listOwners).mockResolvedValue([1]);
    vi.mocked(sberTokenRepo.get).mockResolvedValue({
      owner_user_id: 1, access_token: 'T', refresh_token: 'R', expires_at: sqlUtc(new Date(Date.now() + 20 * 86_400_000)),
      last_refresh_at: sqlUtc(new Date(Date.now() - 2 * 86_400_000)),
    } as never);
    vi.mocked(sberFetch).mockResolvedValue(fail(401, { error: 'invalid_client' }));
    vi.mocked(sendOwnerAlert).mockClear();
    const r = await keepSberTokensAlive();
    expect(r).toEqual({ refreshed: 0, failed: 1 });
    expect(vi.mocked(sendOwnerAlert).mock.calls[0][1]).toBe('sber_auth');
  });
});
