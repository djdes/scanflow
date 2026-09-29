import { sberFetch } from './sberClient';
import { sealSecret, openSecret } from './secretBox';
import { sberAppRepo } from '../database/repositories/sberAppRepo';
import { logger } from '../utils/logger';

/**
 * client_secret приложения Sber API.
 *
 * По документации (developers.sber.ru/docs/ru/sber-api) секрет живёт 40 дней;
 * бессрочный выдаёт `POST /fintech/api/applications/secrets/v1/refresh-client-secret`
 * по текущему секрету и клиентскому TLS-сертификату. Секрет хранится в БД
 * зашифрованным (sber_app, миграция 74); переменная SBER_CLIENT_SECRET — только
 * стартовое значение, пока в БД ничего нет.
 */
const FINTECH_BASE = process.env.SBER_FINTECH_BASE || 'https://fintech.sberbank.ru:9443';
const REFRESH_CLIENT_SECRET_URL = `${FINTECH_BASE}/fintech/api/applications/secrets/v1/refresh-client-secret`;
export const CLIENT_SECRET_TTL_DAYS = 40;

/** 'YYYY-MM-DD HH:MM:SS' в UTC — формат DATETIME, который принимают и MySQL 9, и MariaDB. */
export function sqlUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** DATETIME из БД (dateStrings, UTC без 'Z') → Date. Без 'Z' JS прочёл бы как местное время. */
export function parseDbUtc(s: string | null | undefined): Date | null {
  if (!s) return null;
  const t = String(s);
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function sberClientId(): string {
  const id = process.env.SBER_CLIENT_ID;
  if (!id) throw new Error('SBER_CLIENT_ID не задан в .env');
  return id;
}

export async function getClientSecret(): Promise<string> {
  const clientId = sberClientId();
  const row = await sberAppRepo.get(clientId);
  if (row?.client_secret_enc) {
    try {
      return openSecret(row.client_secret_enc);
    } catch (err) {
      logger.error('[sber] stored client_secret cannot be decrypted (JWT_SECRET changed?)', { error: (err as Error).message });
    }
  }
  const env = process.env.SBER_CLIENT_SECRET;
  if (!env) throw new Error('client_secret Сбера не задан — введите его на странице «Сбербанк»');
  return env;
}

export interface SecretStatus {
  source: 'db' | 'env' | 'none';
  perpetual: boolean;
  set_at: string | null;
  expires_at: string | null;
  days_left: number | null;
  last_error: string | null;
}

export async function secretStatus(): Promise<SecretStatus> {
  let clientId: string;
  try { clientId = sberClientId(); } catch { return { source: 'none', perpetual: false, set_at: null, expires_at: null, days_left: null, last_error: 'SBER_CLIENT_ID не задан' }; }
  const row = await sberAppRepo.get(clientId);
  if (row?.client_secret_enc) {
    const exp = parseDbUtc(row.secret_expires_at);
    return {
      source: 'db',
      perpetual: row.secret_perpetual === 1,
      set_at: row.secret_set_at,
      expires_at: row.secret_perpetual === 1 ? null : row.secret_expires_at,
      days_left: row.secret_perpetual === 1 || !exp ? null : Math.floor((exp.getTime() - Date.now()) / 86_400_000),
      last_error: row.last_error,
    };
  }
  return {
    source: process.env.SBER_CLIENT_SECRET ? 'env' : 'none',
    perpetual: false, set_at: null, expires_at: null, days_left: null,
    last_error: row?.last_error ?? null,
  };
}

function describeSecretError(status: number, body: string): string {
  let cause = '';
  try {
    const j = JSON.parse(body) as { cause?: string; message?: string; error?: string };
    cause = [j.cause, j.message ?? j.error].filter(Boolean).join(': ');
  } catch { cause = body.slice(0, 200); }
  if (status === 403) return `Сбер отказал (403): проверьте TLS-сертификат приложения. ${cause}`.trim();
  if (status === 400 || status === 401) return `Сбер не принял текущий client_secret (${status}) — возьмите новый в личном кабинете Sber API. ${cause}`.trim();
  return `Сбер вернул ${status}. ${cause}`.trim();
}

/**
 * Обменять секрет на бессрочный. Новый секрет сохраняется в БД сразу после
 * ответа — до любых других действий: старый после обмена может перестать
 * действовать, и потеря ответа означала бы поход в личный кабинет.
 */
export async function makeSecretPerpetual(current?: string): Promise<void> {
  const clientId = sberClientId();
  const secret = current ?? await getClientSecret();
  const res = await sberFetch(REFRESH_CLIENT_SECRET_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ clientId, clientSecret: secret }),
  });
  if (!res.ok) {
    const msg = describeSecretError(res.status, res.body);
    await sberAppRepo.setError(clientId, msg);
    throw new Error(msg);
  }
  let fresh: string | undefined;
  try { fresh = res.json<{ clientSecret?: string }>().clientSecret; } catch { /* разберём ниже */ }
  if (!fresh) {
    const msg = 'Сбер ответил без нового client_secret';
    await sberAppRepo.setError(clientId, msg);
    throw new Error(msg);
  }
  await sberAppRepo.saveSecret(clientId, sealSecret(fresh), { perpetual: true, expiresAt: null });
  logger.info('[sber] client_secret exchanged for a perpetual one', { clientId });
}

/**
 * Секрет, введённый человеком (из личного кабинета): сохранить как 40-дневный и
 * сразу попробовать сделать бессрочным. Не удалось — секрет остаётся рабочим
 * 40 дней, причина возвращается для показа.
 */
export async function setClientSecretFromUser(
  secret: string,
  opts: { makePerpetual?: boolean } = {},
): Promise<{ perpetual: boolean; warning?: string }> {
  const clientId = sberClientId();
  const clean = secret.trim();
  if (clean.length < 8 || clean.length > 256) throw new Error('client_secret должен быть от 8 до 256 символов');
  const expiresAt = sqlUtc(new Date(Date.now() + CLIENT_SECRET_TTL_DAYS * 86_400_000));
  await sberAppRepo.saveSecret(clientId, sealSecret(clean), { perpetual: false, expiresAt });
  if (opts.makePerpetual === false) return { perpetual: false };
  try {
    await makeSecretPerpetual(clean);
    return { perpetual: true };
  } catch (err) {
    return { perpetual: false, warning: (err as Error).message };
  }
}
