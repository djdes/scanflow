import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/sber/sberClient', () => ({
  sberFetch: vi.fn(),
}));

import { sberFetch } from '../../src/sber/sberClient';
import {
  createOAuthState,
  verifyOAuthState,
  buildAuthUrl,
  exchangeCodeForToken,
  refreshAccessToken,
} from '../../src/sber/oauth';

describe('OAuth state JWT', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret-must-be-at-least-32-chars-long';
  });

  it('createOAuthState + verifyOAuthState roundtrip', async () => {
    const state = await createOAuthState({ purpose: 'connect' });
    const payload = await verifyOAuthState(state);
    expect(payload).toMatchObject({ purpose: 'connect' });
  });

  it('verifyOAuthState returns null for invalid state', async () => {
    expect(await verifyOAuthState('not-a-jwt')).toBeNull();
  });

  it('verifyOAuthState rejects expired tokens', async () => {
    process.env.JWT_SECRET = 'test-secret-must-be-at-least-32-chars-long';
    const { SignJWT } = await import('jose');
    const secret = new TextEncoder().encode(process.env.JWT_SECRET);
    const expired = await new SignJWT({ purpose: 'connect' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(secret);
    expect(await verifyOAuthState(expired)).toBeNull();
  });
});

describe('buildAuthUrl', () => {
  beforeEach(() => {
    process.env.SBER_CLIENT_ID = '40285';
    process.env.SBER_REDIRECT_URI = 'https://scanflow.ru/api/sber/callback';
  });

  it('includes required params', () => {
    const url = buildAuthUrl('STATE-X');
    expect(url).toMatch(/^https:\/\/sbi\.sberbank\.ru:9443\/v2\/oauth\/authorize\?/);
    expect(url).toContain('client_id=40285');
    expect(url).toContain(`state=STATE-X`);
    expect(url).toContain('scope=openid+GET_CLIENT_ACCOUNTS+PAY_DOC_RU');
    expect(url).toContain('response_type=code');
    expect(url).toContain('redirect_uri=' + encodeURIComponent('https://scanflow.ru/api/sber/callback'));
  });
});

describe('exchangeCodeForToken', () => {
  beforeEach(() => {
    vi.mocked(sberFetch).mockReset();
    process.env.SBER_CLIENT_ID = '40285';
    process.env.SBER_CLIENT_SECRET = 'secret';
    process.env.SBER_REDIRECT_URI = 'https://scanflow.ru/api/sber/callback';
  });

  it('posts to token endpoint with form body', async () => {
    vi.mocked(sberFetch).mockResolvedValue({
      status: 200, ok: true,
      body: '{"access_token":"a","refresh_token":"r","expires_in":3600}',
      json<T>() { return JSON.parse(this.body) as T; },
    });
    const out = await exchangeCodeForToken('CODE');
    expect(out).toEqual({ accessToken: 'a', refreshToken: 'r', expiresIn: 3600 });
    expect(sberFetch).toHaveBeenCalledWith(
      'https://fintech.sberbank.ru:9443/v2/oauth/token',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: expect.stringContaining('grant_type=authorization_code'),
      }),
    );
  });

  it('throws on non-2xx', async () => {
    vi.mocked(sberFetch).mockResolvedValue({
      status: 400, ok: false, body: '{"error":"invalid_grant"}',
      json<T>() { return JSON.parse(this.body) as T; },
    });
    await expect(exchangeCodeForToken('BAD')).rejects.toThrow(/Sber token exchange/);
  });
});

describe('refreshAccessToken', () => {
  beforeEach(() => {
    vi.mocked(sberFetch).mockReset();
    process.env.SBER_CLIENT_ID = '40285';
    process.env.SBER_CLIENT_SECRET = 'secret';
  });

  it('posts grant_type=refresh_token', async () => {
    vi.mocked(sberFetch).mockResolvedValue({
      status: 200, ok: true,
      body: '{"access_token":"new","refresh_token":"newr","expires_in":7200}',
      json<T>() { return JSON.parse(this.body) as T; },
    });
    const out = await refreshAccessToken('OLD-REFRESH');
    expect(out.accessToken).toBe('new');
    const call = vi.mocked(sberFetch).mock.calls[0][1] as { body: string };
    expect(call.body).toContain('grant_type=refresh_token');
    expect(call.body).toContain('refresh_token=OLD-REFRESH');
  });
});
