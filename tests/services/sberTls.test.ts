import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/sber/sberClient', () => ({ activeTls: vi.fn(), resetTlsCache: vi.fn(), sberFetch: vi.fn() }));
vi.mock('../../src/sber/tlsStore', () => ({ saveStoredTls: vi.fn(async () => {}), storedTlsMeta: vi.fn(async () => null) }));
vi.mock('../../src/sber/oauth', async (orig) => ({
  ...(await orig<typeof import('../../src/sber/oauth')>()),
  getValidAccessToken: vi.fn(async () => 'tok'),
}));
vi.mock('../../src/database/repositories/sberTokenRepo', () => ({
  sberTokenRepo: { get: vi.fn(async () => ({ access_token: 'stored-tok' })), listOwners: vi.fn(async () => [1, 3]) },
}));
vi.mock('../../src/services/ownerAlerts', () => ({
  sendOwnerAlert: vi.fn(async () => true),
  lastOwnerAlertMs: vi.fn(async () => null),
  markOwnerAlert: vi.fn(async () => {}),
}));
vi.mock('../../src/utils/mailer', () => ({ sendErrorEmail: vi.fn(async () => {}) }));
vi.mock('../../src/integration/integrationLog', () => ({ logIntegrationEvent: vi.fn(async () => {}) }));

import { activeTls, resetTlsCache, sberFetch } from '../../src/sber/sberClient';
import { saveStoredTls } from '../../src/sber/tlsStore';
import { getValidAccessToken } from '../../src/sber/oauth';
import { sendOwnerAlert, lastOwnerAlertMs, markOwnerAlert } from '../../src/services/ownerAlerts';
import { sendErrorEmail } from '../../src/utils/mailer';
import { installTlsCert, verifyTlsWithSber, tlsStatus } from '../../src/services/sberTls';
import { warnSberTlsExpiry, tlsReminderIntervalHours } from '../../src/services/sberMaintenance';
import { FIXTURE_P12_BASE64, FIXTURE_P12_PASSWORD, FIXTURE_P12_VALID_TO } from '../fixtures/sberTlsFixture';

const pfx = Buffer.from(FIXTURE_P12_BASE64, 'base64');
const DAY = 86_400_000;
const bundle = (validTo: Date | null, source: 'file' | 'db' = 'file') =>
  ({ pfx: Buffer.from('OLD'), passphrase: 'old', source, validTo });
const res = (status: number) => ({ status, ok: status >= 200 && status < 300, body: '{}', json: () => ({}) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(activeTls).mockResolvedValue(bundle(new Date(Date.now() + 30 * DAY)));
  vi.mocked(sberFetch).mockResolvedValue(res(200) as never);
});
afterEach(() => { vi.useRealTimers(); });

describe('installTlsCert', () => {
  it('проверяет связь этим сертификатом, сохраняет и сразу переключается', async () => {
    const r = await installTlsCert({ pfx, password: FIXTURE_P12_PASSWORD, ownerUserId: 1 });
    const call = vi.mocked(sberFetch).mock.calls[0];
    expect(String(call[0])).toMatch(/client-info$/);
    expect(call[1]?.tls?.passphrase).toBe(FIXTURE_P12_PASSWORD);
    expect(call[1]?.headers?.Authorization).toBe('tok');
    const saved = vi.mocked(saveStoredTls).mock.calls[0];
    expect(saved[1]).toBe(FIXTURE_P12_PASSWORD);
    expect(saved[2].validTo.toISOString()).toBe(FIXTURE_P12_VALID_TO.toISOString());
    expect(resetTlsCache).toHaveBeenCalled();
    expect(r.note).toBeUndefined();
  });

  it('неверный пароль — отказ без запроса в Сбер и без сохранения', async () => {
    await expect(installTlsCert({ pfx, password: 'wrong', ownerUserId: 1 })).rejects.toThrow(/Неверный пароль/);
    expect(sberFetch).not.toHaveBeenCalled();
    expect(saveStoredTls).not.toHaveBeenCalled();
  });

  it('истёкший сертификат — отказ', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(FIXTURE_P12_VALID_TO.getTime() + DAY));
    await expect(installTlsCert({ pfx, password: FIXTURE_P12_PASSWORD, ownerUserId: 1 })).rejects.toThrow(/уже истёк/);
    expect(saveStoredTls).not.toHaveBeenCalled();
  });

  it('старее текущего — отказ (иначе он бы всё равно не использовался)', async () => {
    vi.mocked(activeTls).mockResolvedValue(bundle(new Date(FIXTURE_P12_VALID_TO.getTime() + DAY)));
    await expect(installTlsCert({ pfx, password: FIXTURE_P12_PASSWORD, ownerUserId: 1 })).rejects.toThrow(/Загрузите более новый/);
    expect(saveStoredTls).not.toHaveBeenCalled();
  });

  it('Сбер не принял сертификат (403) — отказ, текущий не трогаем', async () => {
    vi.mocked(sberFetch).mockResolvedValue(res(403) as never);
    await expect(installTlsCert({ pfx, password: FIXTURE_P12_PASSWORD, ownerUserId: 1 })).rejects.toThrow(/Сбер ответил 403/);
    expect(saveStoredTls).not.toHaveBeenCalled();
    expect(resetTlsCache).not.toHaveBeenCalled();
  });

  it('обрыв соединения с новым сертификатом — отказ', async () => {
    vi.mocked(sberFetch).mockRejectedValue(new Error('Sber request failed: socket hang up'));
    await expect(installTlsCert({ pfx, password: FIXTURE_P12_PASSWORD, ownerUserId: 1 })).rejects.toThrow(/не принял соединение/);
    expect(saveStoredTls).not.toHaveBeenCalled();
  });
});

describe('verifyTlsWithSber', () => {
  it('401 — TLS прошёл, истёк только токен: принимаем с пометкой', async () => {
    vi.mocked(sberFetch).mockResolvedValue(res(401) as never);
    const v = await verifyTlsWithSber({ pfx, passphrase: 'p' }, 1);
    expect(v).toMatchObject({ ok: true });
    expect(v.ok && v.note).toMatch(/токен доступа истёк/);
  });

  it('не удалось обновить токен (старый сертификат истёк) — проверяет сохранённым токеном', async () => {
    vi.mocked(getValidAccessToken).mockRejectedValueOnce(new Error('TLS expired'));
    await verifyTlsWithSber({ pfx, passphrase: 'p' }, 1);
    expect(vi.mocked(sberFetch).mock.calls[0][1]?.headers?.Authorization).toBe('stored-tok');
  });
});

describe('tlsStatus', () => {
  it('срок и дни до конца текущего сертификата', async () => {
    vi.mocked(activeTls).mockResolvedValue(bundle(new Date(Date.now() + 45 * DAY + 3_600_000)));
    const st = await tlsStatus();
    expect(st.source).toBe('file');
    expect(st.days_left).toBe(45);
  });

  it('сертификата нет — none', async () => {
    vi.mocked(activeTls).mockResolvedValue(null);
    expect((await tlsStatus()).source).toBe('none');
  });
});

describe('warnSberTlsExpiry', () => {
  it('больше 60 дней — молчит', async () => {
    vi.mocked(activeTls).mockResolvedValue(bundle(new Date(Date.now() + 90 * DAY)));
    await warnSberTlsExpiry();
    expect(sendOwnerAlert).not.toHaveBeenCalled();
    expect(sendErrorEmail).not.toHaveBeenCalled();
  });

  it('за 20 дней — Telegram каждой компании со Сбером раз в неделю и письмо админу', async () => {
    vi.mocked(activeTls).mockResolvedValue(bundle(new Date(Date.now() + 20 * DAY + 3_600_000)));
    await warnSberTlsExpiry();
    expect(sendOwnerAlert).toHaveBeenCalledTimes(2);
    const [owner, kind, text, interval] = vi.mocked(sendOwnerAlert).mock.calls[0];
    expect([owner, kind, interval]).toEqual([1, 'sber_tls', 24 * 7]);
    expect(text).toMatch(/истекает через 20 дн\./);
    expect(text).toMatch(/Сгенерировать сертификат/);
    expect(sendErrorEmail).toHaveBeenCalledTimes(1);
    expect(markOwnerAlert).toHaveBeenCalledWith(0, 'sber_tls_mail', expect.any(String));
  });

  it('письмо не чаще интервала', async () => {
    vi.mocked(activeTls).mockResolvedValue(bundle(new Date(Date.now() + 5 * DAY + 3_600_000)));
    vi.mocked(lastOwnerAlertMs).mockResolvedValue(Date.now() - 3_600_000);
    await warnSberTlsExpiry();
    expect(sendOwnerAlert).toHaveBeenCalled();
    expect(sendErrorEmail).not.toHaveBeenCalled();
  });

  it('уже истёк — сообщает, что истёк', async () => {
    vi.mocked(activeTls).mockResolvedValue(bundle(new Date(Date.now() - 2 * DAY)));
    await warnSberTlsExpiry();
    expect(vi.mocked(sendOwnerAlert).mock.calls[0][2]).toMatch(/истёк \d\d\.\d\d\.\d{4}/);
  });

  it('интервалы: ≤7 — сутки, ≤30 — неделя, иначе две недели', () => {
    expect(tlsReminderIntervalHours(3)).toBe(24);
    expect(tlsReminderIntervalHours(30)).toBe(24 * 7);
    expect(tlsReminderIntervalHours(59)).toBe(24 * 14);
  });
});
