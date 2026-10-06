import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici';
import { config } from '../config';
import type { ChatgptAccount, ChatgptCredentials } from '../database/repositories/chatgptConnectionRepo';
import { accountFromTokens } from './claims';

/**
 * Вход в ChatGPT по коду — тот же поток, что у `codex login --device-auth`: сервер просит у
 * auth.openai.com одноразовый код, админ вводит его на auth.openai.com/codex/device, сервер
 * опрашивает подтверждение и меняет его на OAuth-токены. API-ключ OpenAI не нужен.
 *
 * OpenAI не обслуживает Россию: запросы идут через OPENAI_PROXY_URL (если не задан —
 * через ANTHROPIC_PROXY_URL, тот же внешний прокси, что у Claude).
 */
const ISSUER = 'https://auth.openai.com';
/** Публичный client id официального Codex CLI — не секрет. */
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const REQUEST_TIMEOUT_MS = 30_000;
const MIN_INTERVAL_SEC = 3;
const DEFAULT_INTERVAL_SEC = 5;
/** Провайдер не сообщает срок кода; по документации Codex он живёт 15 минут. */
export const DEVICE_CODE_TTL_SEC = 15 * 60;

export class ChatgptAuthError extends Error {
  constructor(message: string, readonly code: 'unavailable' | 'rate_limited' | 'rejected' | 'upstream', readonly status = 0) {
    super(message);
    this.name = 'ChatgptAuthError';
  }
}

let cachedDispatcher: { url: string; dispatcher: Dispatcher } | null = null;
/** Прокси для OpenAI (auth.openai.com и chatgpt.com); undefined — прямой канал. */
export function openaiDispatcher(): Dispatcher | undefined {
  const url = (config.openaiProxyUrl || config.anthropicProxyUrl || '').trim();
  if (!url) return undefined;
  if (cachedDispatcher?.url !== url) cachedDispatcher = { url, dispatcher: new ProxyAgent(url) };
  return cachedDispatcher.dispatcher;
}

export interface DeviceCode {
  userCode: string;
  deviceAuthId: string;
  verificationUrl: string;
  intervalSec: number;
}

export type DevicePollResult =
  | { status: 'pending' }
  | { status: 'approved'; credentials: ChatgptCredentials; account: ChatgptAccount };

export interface TokenGrant {
  credentials: ChatgptCredentials;
  account: ChatgptAccount;
}

async function post(path: string, body: { json: Record<string, unknown> } | { form: Record<string, string> }) {
  const isJson = 'json' in body;
  const dispatcher = openaiDispatcher();
  try {
    return await undiciFetch(`${ISSUER}${path}`, {
      method: 'POST',
      headers: {
        'content-type': isJson ? 'application/json' : 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: isJson ? JSON.stringify(body.json) : new URLSearchParams(body.form).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(dispatcher ? { dispatcher } : {}),
    });
  } catch (e) {
    throw new ChatgptAuthError(`auth.openai.com недоступен: ${(e as Error).message}. Проверьте OPENAI_PROXY_URL`, 'upstream');
  }
}

async function snippet(res: { text(): Promise<string> }): Promise<string> {
  const text = await res.text().catch(() => '');
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

export async function requestDeviceCode(): Promise<DeviceCode> {
  const res = await post('/api/accounts/deviceauth/usercode', { json: { client_id: CODEX_CLIENT_ID } });
  if (res.status === 404) throw new ChatgptAuthError('Вход по коду для этого аккаунта ChatGPT не включён', 'unavailable', 404);
  if (res.status === 429) throw new ChatgptAuthError('OpenAI временно ограничивает попытки входа — повторите через минуту', 'rate_limited', 429);
  if (!res.ok) throw new ChatgptAuthError(`Не удалось получить код: ${res.status} ${await snippet(res)}`, 'upstream', res.status);
  const data = (await res.json()) as { user_code?: unknown; device_auth_id?: unknown; interval?: unknown };
  if (typeof data.user_code !== 'string' || typeof data.device_auth_id !== 'string') {
    throw new ChatgptAuthError('Ответ на запрос кода пришёл неполным', 'upstream', res.status);
  }
  const interval = Number(data.interval ?? DEFAULT_INTERVAL_SEC);
  return {
    userCode: data.user_code,
    deviceAuthId: data.device_auth_id,
    verificationUrl: `${ISSUER}/codex/device`,
    intervalSec: Math.max(MIN_INTERVAL_SEC, Number.isFinite(interval) ? Math.round(interval) : DEFAULT_INTERVAL_SEC),
  };
}

/** Один шаг проверки подтверждения. 403/404 — «ещё не подтвердили», это не ошибка. */
export async function pollDeviceCode(input: { deviceAuthId: string; userCode: string }): Promise<DevicePollResult> {
  const res = await post('/api/accounts/deviceauth/token', {
    json: { device_auth_id: input.deviceAuthId, user_code: input.userCode },
  });
  if (res.status === 403 || res.status === 404) return { status: 'pending' };
  if (!res.ok) throw new ChatgptAuthError(`Проверка входа: ${res.status} ${await snippet(res)}`, 'upstream', res.status);
  const data = (await res.json()) as { authorization_code?: unknown; code_verifier?: unknown };
  if (typeof data.authorization_code !== 'string' || typeof data.code_verifier !== 'string') {
    throw new ChatgptAuthError('Подтверждение входа пришло без кода авторизации', 'upstream', res.status);
  }
  const grant = await tokenRequest({
    grant_type: 'authorization_code',
    code: data.authorization_code,
    redirect_uri: `${ISSUER}/deviceauth/callback`,
    client_id: CODEX_CLIENT_ID,
    code_verifier: data.code_verifier,
  });
  return { status: 'approved', ...grant };
}

/** Обмен refresh-токена (одноразового!) на новую пару. Отказ — ChatgptAuthError 'rejected'. */
export async function refreshTokens(refreshToken: string): Promise<TokenGrant> {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CODEX_CLIENT_ID });
}

async function tokenRequest(form: Record<string, string>): Promise<TokenGrant> {
  const res = await post('/oauth/token', { form });
  if (res.status === 429) throw new ChatgptAuthError('OpenAI ограничивает выдачу токенов — повторите позже', 'rate_limited', 429);
  if (res.status === 400 || res.status === 401) {
    // Refresh-токен истёк, отозван или уже использован — нужен новый вход по коду.
    throw new ChatgptAuthError(`Токен отклонён (${res.status}): ${await snippet(res)}`, 'rejected', res.status);
  }
  if (!res.ok) throw new ChatgptAuthError(`Выдача токенов: ${res.status} ${await snippet(res)}`, 'upstream', res.status);
  const data = (await res.json()) as { access_token?: unknown; refresh_token?: unknown; id_token?: unknown };
  if (typeof data.access_token !== 'string' || !data.access_token) {
    throw new ChatgptAuthError('Ответ пришёл без access_token', 'upstream', res.status);
  }
  const idToken = typeof data.id_token === 'string' && data.id_token ? data.id_token : null;
  return {
    credentials: {
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : null,
      idToken,
    },
    account: accountFromTokens(data.access_token, idToken),
  };
}
