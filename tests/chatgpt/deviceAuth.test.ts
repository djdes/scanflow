import { describe, it, expect, vi, beforeEach } from 'vitest';

const net = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');
  return { ...actual, fetch: net.fetch };
});

import { CODEX_CLIENT_ID, ChatgptAuthError, pollDeviceCode, refreshTokens, requestDeviceCode } from '../../src/chatgpt/deviceAuth';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const jwt = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;

beforeEach(() => vi.resetAllMocks());

describe('вход по коду', () => {
  it('код: user_code, адрес ввода, интервал не меньше 3 с', async () => {
    net.fetch.mockResolvedValue(json(200, { user_code: 'ABCD-1234', device_auth_id: 'dev-1', interval: 1 }));
    expect(await requestDeviceCode()).toEqual({
      userCode: 'ABCD-1234', deviceAuthId: 'dev-1', verificationUrl: 'https://auth.openai.com/codex/device', intervalSec: 3,
    });
    const [url, init] = net.fetch.mock.calls[0];
    expect(url).toBe('https://auth.openai.com/api/accounts/deviceauth/usercode');
    expect(JSON.parse(init.body)).toEqual({ client_id: CODEX_CLIENT_ID });
  });

  it('вход по коду не включён для аккаунта (404) — понятная ошибка', async () => {
    net.fetch.mockResolvedValue(json(404, {}));
    await expect(requestDeviceCode()).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('ещё не подтвердили (403/404) — pending, не ошибка', async () => {
    net.fetch.mockResolvedValue(json(403, {}));
    expect(await pollDeviceCode({ deviceAuthId: 'dev-1', userCode: 'ABCD-1234' })).toEqual({ status: 'pending' });
  });

  it('подтвердили — обмен кода на токены, аккаунт из токенов', async () => {
    const access = jwt({ exp: 1800000000, 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-1', chatgpt_plan_type: 'pro' } });
    net.fetch
      .mockResolvedValueOnce(json(200, { authorization_code: 'code-1', code_verifier: 'ver-1' }))
      .mockResolvedValueOnce(json(200, { access_token: access, refresh_token: 'RT-1', id_token: jwt({ email: 'a@b.ru' }) }));
    const result = await pollDeviceCode({ deviceAuthId: 'dev-1', userCode: 'ABCD-1234' });
    expect(result).toMatchObject({
      status: 'approved',
      credentials: { accessToken: access, refreshToken: 'RT-1' },
      account: { accountId: 'acc-1', email: 'a@b.ru', planType: 'pro', accessExpiresMs: 1800000000 * 1000 },
    });
    const form = new URLSearchParams(net.fetch.mock.calls[1][1].body);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code_verifier')).toBe('ver-1');
    expect(form.get('redirect_uri')).toBe('https://auth.openai.com/deviceauth/callback');
  });
});

describe('refresh', () => {
  it('отказ (400/401) — ChatgptAuthError rejected: нужен новый вход', async () => {
    net.fetch.mockResolvedValue(json(400, { error: 'invalid_grant' }));
    const err = await refreshTokens('RT-1').catch(e => e);
    expect(err).toBeInstanceOf(ChatgptAuthError);
    expect(err.code).toBe('rejected');
  });

  it('сеть недоступна — подсказка про прокси', async () => {
    net.fetch.mockRejectedValue(new Error('connect ETIMEDOUT'));
    await expect(refreshTokens('RT-1')).rejects.toThrow(/OPENAI_PROXY_URL/);
  });
});
