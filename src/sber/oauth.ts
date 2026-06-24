import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';
import { sberFetch } from './sberClient';
import { sberTokenRepo } from '../database/repositories/sberTokenRepo';

const SBER_AUTH_URL = 'https://sbi.sberbank.ru:9443/v2/oauth/authorize';
const SBER_TOKEN_URL = 'https://fintech.sberbank.ru:9443/v2/oauth/token';
const SBER_SCOPE = 'openid GET_CLIENT_ACCOUNTS PAY_DOC_RU';

export interface TokenData {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

function getJwtSecret(): Uint8Array {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) {
    throw new Error('JWT_SECRET must be set and at least 32 characters');
  }
  return new TextEncoder().encode(s);
}

export async function createOAuthState(payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(getJwtSecret());
}

export async function verifyOAuthState(state: string): Promise<Record<string, unknown> | null> {
  try {
    const { payload } = await jwtVerify(state, getJwtSecret());
    return payload;
  } catch {
    return null;
  }
}

export function buildAuthUrl(state: string): string {
  const clientId = process.env.SBER_CLIENT_ID;
  const redirectUri = process.env.SBER_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    throw new Error('SBER_CLIENT_ID or SBER_REDIRECT_URI not configured');
  }
  const params = new URLSearchParams({
    scope: SBER_SCOPE,
    response_type: 'code',
    client_id: clientId,
    state,
    nonce: randomUUID(),
    redirect_uri: redirectUri,
  });
  return `${SBER_AUTH_URL}?${params.toString()}`;
}

export async function exchangeCodeForToken(code: string): Promise<TokenData> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: process.env.SBER_CLIENT_ID!,
    client_secret: process.env.SBER_CLIENT_SECRET!,
    redirect_uri: process.env.SBER_REDIRECT_URI!,
  });
  const res = await sberFetch(SBER_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`Sber token exchange failed: ${res.status} ${res.body}`);
  }
  const data = res.json<{ access_token: string; refresh_token: string; expires_in: number }>();
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: data.expires_in };
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenData> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: process.env.SBER_CLIENT_ID!,
    client_secret: process.env.SBER_CLIENT_SECRET!,
  });
  const res = await sberFetch(SBER_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`Sber token refresh failed: ${res.status} ${res.body}`);
  }
  const data = res.json<{ access_token: string; refresh_token: string; expires_in: number }>();
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: data.expires_in };
}

// Sber rotates the refresh token on every use, so two concurrent refreshes
// would both present the same refresh_token — the second fails and can leave the
// stored token unusable until a manual reconnect. Serialize refresh within the
// process by sharing a single in-flight promise. (PM2 single-instance; a
// clustered deploy would additionally need a DB row lock — see design notes.)
let inflightRefresh: Promise<string> | null = null;

export async function getValidAccessToken(): Promise<string> {
  const row = await sberTokenRepo.get();
  if (!row) throw new Error('Sber not connected');
  const buffer = 5 * 60 * 1000;
  const expiresAt = new Date(row.expires_at).getTime();
  if (expiresAt > Date.now() + buffer) return row.access_token;
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = (async () => {
    try {
      const fresh = await refreshAccessToken(row.refresh_token);
      const newExpiresAt = new Date(Date.now() + fresh.expiresIn * 1000).toISOString();
      await sberTokenRepo.updateTokens({
        access_token: fresh.accessToken,
        refresh_token: fresh.refreshToken,
        expires_at: newExpiresAt,
      });
      return fresh.accessToken;
    } finally {
      inflightRefresh = null;
    }
  })();
  return inflightRefresh;
}
