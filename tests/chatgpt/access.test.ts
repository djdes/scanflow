import { describe, it, expect, vi, beforeEach } from 'vitest';

const repo = vi.hoisted(() => ({
  get: vi.fn(),
  getCredentials: vi.fn(),
  updateTokens: vi.fn(),
  markReauth: vi.fn(),
}));
const auth = vi.hoisted(() => ({ refreshTokens: vi.fn() }));

vi.mock('../../src/database/repositories/chatgptConnectionRepo', () => ({ chatgptConnectionRepo: repo }));
vi.mock('../../src/chatgpt/deviceAuth', async () => {
  const actual = await vi.importActual<typeof import('../../src/chatgpt/deviceAuth')>('../../src/chatgpt/deviceAuth');
  return { ...actual, refreshTokens: auth.refreshTokens };
});

import { acquireChatgptAccess, ChatgptUnavailableError } from '../../src/chatgpt/access';
import { ChatgptAuthError } from '../../src/chatgpt/deviceAuth';

const HOUR = 60 * 60 * 1000;

function connection(over: Record<string, unknown> = {}) {
  return {
    status: 'active', accountId: 'acc-1', accountEmail: 'a@b.ru', planType: 'plus',
    accessExpiresMs: Date.now() + HOUR, lastRefreshMs: null, rateLimitedUntilMs: null,
    lastUsedMs: null, lastError: null, version: 3, createdAt: '2026-10-06 12:00:00', ...over,
  };
}

const grant = (access: string, refresh: string | null) => ({
  credentials: { accessToken: access, refreshToken: refresh, idToken: null },
  account: { accountId: 'acc-1', email: null, planType: null, accessExpiresMs: Date.now() + 10 * 24 * HOUR },
});

beforeEach(() => {
  vi.resetAllMocks();
  repo.getCredentials.mockResolvedValue({ accessToken: 'AT-old', refreshToken: 'RT-old', idToken: 'ID-old' });
  repo.updateTokens.mockResolvedValue(true);
});

describe('acquireChatgptAccess', () => {
  it('свежий токен отдаётся без обновления', async () => {
    repo.get.mockResolvedValue(connection());
    expect(await acquireChatgptAccess()).toEqual({ accessToken: 'AT-old', accountId: 'acc-1' });
    expect(auth.refreshTokens).not.toHaveBeenCalled();
  });

  it('за 5 минут до конца — обновление; новый refresh-токен пишется с проверкой версии', async () => {
    repo.get.mockResolvedValue(connection({ accessExpiresMs: Date.now() + 2 * 60 * 1000 }));
    auth.refreshTokens.mockResolvedValue(grant('AT-new', 'RT-new'));
    expect(await acquireChatgptAccess()).toEqual({ accessToken: 'AT-new', accountId: 'acc-1' });
    expect(auth.refreshTokens).toHaveBeenCalledWith('RT-old');
    expect(repo.updateTokens).toHaveBeenCalledWith(expect.objectContaining({
      expectedVersion: 3,
      credentials: { accessToken: 'AT-new', refreshToken: 'RT-new', idToken: 'ID-old' },
    }));
  });

  it('одновременные запросы делят одно обновление: refresh-токен одноразовый', async () => {
    repo.get.mockResolvedValue(connection({ accessExpiresMs: Date.now() - 1000 }));
    let release!: () => void;
    auth.refreshTokens.mockReturnValue(new Promise(r => { release = () => r(grant('AT-new', 'RT-new')); }));
    const calls = [acquireChatgptAccess(), acquireChatgptAccess(), acquireChatgptAccess()];
    await new Promise(r => setTimeout(r, 10));
    release();
    const results = await Promise.all(calls);
    expect(results.every(r => r.accessToken === 'AT-new')).toBe(true);
    expect(auth.refreshTokens).toHaveBeenCalledTimes(1);
  });

  it('если OpenAI не прислал новый refresh-токен — остаётся прежний', async () => {
    repo.get.mockResolvedValue(connection({ accessExpiresMs: Date.now() - 1000 }));
    auth.refreshTokens.mockResolvedValue(grant('AT-new', null));
    await acquireChatgptAccess();
    expect(repo.updateTokens.mock.calls[0][0].credentials.refreshToken).toBe('RT-old');
  });

  it('401 на этот токен — обновление принудительно, даже если срок не вышел', async () => {
    repo.get.mockResolvedValue(connection());
    auth.refreshTokens.mockResolvedValue(grant('AT-new', 'RT-new'));
    expect((await acquireChatgptAccess({ rejectedAccessToken: 'AT-old' })).accessToken).toBe('AT-new');
  });

  it('401 на старый токен, а в БД уже новый — отдаём новый без обновления', async () => {
    repo.get.mockResolvedValue(connection());
    expect((await acquireChatgptAccess({ rejectedAccessToken: 'AT-older' })).accessToken).toBe('AT-old');
    expect(auth.refreshTokens).not.toHaveBeenCalled();
  });

  it('OpenAI отверг refresh-токен — подключение «нужен вход», ошибка без повторов', async () => {
    repo.get.mockResolvedValue(connection({ accessExpiresMs: Date.now() - 1000 }));
    auth.refreshTokens.mockRejectedValue(new ChatgptAuthError('Токен отклонён (400): invalid_grant', 'rejected', 400));
    await expect(acquireChatgptAccess()).rejects.toBeInstanceOf(ChatgptUnavailableError);
    expect(repo.markReauth).toHaveBeenCalledWith(expect.stringContaining('invalid_grant'));
  });

  it('проиграли гонку по версии — берём то, что записал другой', async () => {
    repo.get
      .mockResolvedValueOnce(connection({ accessExpiresMs: Date.now() - 1000 }))
      .mockResolvedValueOnce(connection({ accessExpiresMs: Date.now() - 1000 }))
      .mockResolvedValue(connection({ version: 4 }));
    repo.getCredentials
      .mockResolvedValueOnce({ accessToken: 'AT-old', refreshToken: 'RT-old', idToken: null })
      .mockResolvedValueOnce({ accessToken: 'AT-old', refreshToken: 'RT-old', idToken: null })
      .mockResolvedValue({ accessToken: 'AT-other', refreshToken: 'RT-other', idToken: null });
    auth.refreshTokens.mockResolvedValue(grant('AT-new', 'RT-new'));
    repo.updateTokens.mockResolvedValue(false);
    expect((await acquireChatgptAccess()).accessToken).toBe('AT-other');
  });

  it('нет подключения, нужен вход или исчерпан лимит — понятная ошибка, без запроса к OpenAI', async () => {
    repo.get.mockResolvedValueOnce(null);
    await expect(acquireChatgptAccess()).rejects.toThrow(/не подключён/);
    repo.get.mockResolvedValueOnce(connection({ status: 'reauth_required', lastError: 'invalid_grant' }));
    await expect(acquireChatgptAccess()).rejects.toThrow(/повторного входа/);
    repo.get.mockResolvedValueOnce(connection({ rateLimitedUntilMs: Date.now() + HOUR }));
    await expect(acquireChatgptAccess()).rejects.toThrow(/Лимит подписки/);
    expect(auth.refreshTokens).not.toHaveBeenCalled();
  });

  it('токены не расшифровать (сменился JWT_SECRET) — «нужен вход»', async () => {
    repo.get.mockResolvedValue(connection());
    repo.getCredentials.mockResolvedValue(null);
    await expect(acquireChatgptAccess()).rejects.toBeInstanceOf(ChatgptUnavailableError);
    expect(repo.markReauth).toHaveBeenCalled();
  });

  it('ошибка «нельзя пользоваться» не повторяется withRetry (status 409)', () => {
    expect(new ChatgptUnavailableError('x').status).toBe(409);
  });
});
