import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';
import { sberFetch } from './sberClient';
import { SberApiError } from './payments';
import { sberTokenRepo } from '../database/repositories/sberTokenRepo';
import { getClientSecret, parseDbUtc, sberClientId, sqlUtc } from './appCredentials';
import { logger } from '../utils/logger';

// Адреса — по документации Sber API (раздел «OAuth»): с префиксом /ic/sso/api.
// Раньше префикса не было, поэтому не работали ни вход через OAuth, ни
// автообновление токена — и пару приходилось вставлять руками раз в месяц.
// Переопределяются env (например, для песочницы fintech-test).
const authUrl = () => process.env.SBER_AUTH_URL || 'https://sbi.sberbank.ru:9443/ic/sso/api/v2/oauth/authorize';
const tokenUrl = () => process.env.SBER_TOKEN_URL || 'https://fintech.sberbank.ru:9443/ic/sso/api/v2/oauth/token';
const scope = () => process.env.SBER_SCOPE || 'openid GET_CLIENT_ACCOUNTS PAY_DOC_RU';

/** access_token, выпущенный через API, живёт 60 минут; из личного кабинета — 30 дней. */
export const LK_ACCESS_TOKEN_TTL_DAYS = 30;
/** refresh_token живёт 180 дней с последнего использования. */
export const REFRESH_TOKEN_TTL_DAYS = 180;

export interface TokenData {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export type SberAuthErrorCode = 'invalid_client' | 'invalid_grant' | 'forbidden' | 'network' | 'not_connected' | 'other';

export class SberAuthError extends Error {
  constructor(public readonly code: SberAuthErrorCode, message: string) {
    super(message);
    this.name = 'SberAuthError';
  }
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
    scope: scope(),
    response_type: 'code',
    client_id: clientId,
    state,
    nonce: randomUUID(),
    redirect_uri: redirectUri,
  });
  return `${authUrl()}?${params.toString()}`;
}

/** Ответ /oauth/token с ошибкой → понятное действие для человека. */
export function describeTokenError(status: number, body: string): SberAuthError {
  let err = '';
  let desc = '';
  try {
    const j = JSON.parse(body) as { error?: string; error_description?: string; message?: string; cause?: string };
    err = String(j.error ?? j.cause ?? '');
    desc = String(j.error_description ?? j.message ?? '');
  } catch { desc = body.slice(0, 200); }
  const tail = [err, desc].filter(Boolean).join(': ');
  if (/invalid_client|unauthorized_client/i.test(err) || (status === 401 && !/grant/i.test(err))) {
    return new SberAuthError('invalid_client',
      `Сбер не принял client_secret приложения — он истёк (живёт 40 дней) или неверен. Введите новый на странице «Сбербанк». (${tail || status})`);
  }
  if (/invalid_grant/i.test(err)) {
    return new SberAuthError('invalid_grant',
      `Токен обновления недействителен (истёк или уже использован). Переподключите Сбербанк: вход через Сбербанк или новая пара из личного кабинета. (${tail})`);
  }
  if (status === 403) {
    return new SberAuthError('forbidden', `Сбер отказал (403): проверьте TLS-сертификат приложения. ${tail}`.trim());
  }
  return new SberAuthError('other', `Сбер вернул ${status}${tail ? `: ${tail}` : ''}`);
}

async function postToken(form: Record<string, string>): Promise<TokenData> {
  const body = new URLSearchParams(form).toString();
  const call = () => sberFetch(tokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  let res;
  try {
    res = await call();
  } catch (err) {
    // Сетевой сбой: по документации запрос можно повторить с тем же
    // refresh_token в течение часа — использованный остаётся резервным 2 часа.
    logger.warn('[sber] token request network error, retrying once', { error: (err as Error).message });
    await new Promise(r => setTimeout(r, 2000));
    try {
      res = await call();
    } catch (err2) {
      throw new SberAuthError('network', `Нет связи со Сбербанком: ${(err2 as Error).message}`);
    }
  }
  if (!res.ok) throw describeTokenError(res.status, res.body);
  const data = res.json<{ access_token?: string; refresh_token?: string; expires_in?: number }>();
  if (!data.access_token || !data.refresh_token) {
    throw new SberAuthError('other', 'Сбер ответил без access_token/refresh_token');
  }
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: Number(data.expires_in) || 3600 };
}

export async function exchangeCodeForToken(code: string): Promise<TokenData> {
  return postToken({
    grant_type: 'authorization_code',
    code,
    client_id: sberClientId(),
    client_secret: await getClientSecret(),
    redirect_uri: process.env.SBER_REDIRECT_URI ?? '',
  });
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenData> {
  return postToken({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: sberClientId(),
    client_secret: await getClientSecret(),
  });
}

// Сбер меняет refresh_token при каждом обновлении, поэтому два одновременных
// обновления предъявили бы один и тот же refresh_token. Обновление
// дедуплицируется НА КОМПАНИЮ (общая переменная отдала бы чужой токен).
// PM2 — один процесс; кластеру понадобилась бы блокировка строки в БД.
const inflightRefresh = new Map<number, Promise<string>>();

/**
 * Действующий access_token компании. Обновляется за 5 минут до конца срока или
 * принудительно (`force` — после 401 от Сбера). Результат и ошибка обновления
 * записываются в подключение — их видно на странице «Сбербанк».
 */
export async function getValidAccessToken(ownerUserId: number, opts: { force?: boolean } = {}): Promise<string> {
  const row = await sberTokenRepo.get(ownerUserId);
  if (!row) throw new SberAuthError('not_connected', 'Сбербанк не подключён');
  const expiresAt = parseDbUtc(row.expires_at)?.getTime() ?? 0;
  if (!opts.force && expiresAt > Date.now() + 5 * 60 * 1000) return row.access_token;

  const existing = inflightRefresh.get(ownerUserId);
  if (existing) return existing;

  const refresh = (async () => {
    try {
      const fresh = await refreshAccessToken(row.refresh_token);
      await sberTokenRepo.updateTokens({
        access_token: fresh.accessToken,
        refresh_token: fresh.refreshToken,
        expires_at: sqlUtc(new Date(Date.now() + fresh.expiresIn * 1000)),
      }, ownerUserId);
      await sberTokenRepo.setRefreshMeta(ownerUserId, { ok: true, source: 'refresh' });
      return fresh.accessToken;
    } catch (err) {
      await sberTokenRepo.setRefreshMeta(ownerUserId, { ok: false, error: (err as Error).message }).catch(() => {});
      throw err;
    } finally {
      inflightRefresh.delete(ownerUserId);
    }
  })();
  inflightRefresh.set(ownerUserId, refresh);
  return refresh;
}

/**
 * Вызов Sber API с токеном компании. На 401 — принудительное обновление токена
 * и один повтор (рекомендация документации: обновлять «по ошибке 401»).
 */
export async function withSberToken<T>(ownerUserId: number, fn: (accessToken: string) => Promise<T>): Promise<T> {
  const token = await getValidAccessToken(ownerUserId);
  try {
    return await fn(token);
  } catch (err) {
    if (err instanceof SberApiError && err.status === 401) {
      logger.info('[sber] 401 from API — forcing token refresh and retrying once', { ownerUserId });
      const fresh = await getValidAccessToken(ownerUserId, { force: true });
      return fn(fresh);
    }
    throw err;
  }
}
