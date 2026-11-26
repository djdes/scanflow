import { readPfxInfo, daysLeft, TlsCertError } from '../sber/tlsCert';
import { saveStoredTls, storedTlsMeta } from '../sber/tlsStore';
import { activeTls, resetTlsCache, sberFetch } from '../sber/sberClient';
import { getValidAccessToken } from '../sber/oauth';
import { sberTokenRepo } from '../database/repositories/sberTokenRepo';
import { logger } from '../utils/logger';

/**
 * TLS-сертификат Sber API: срок на странице «Сбербанк» и замена из кабинета
 * (docs/superpowers/specs/2026-11-05-sber-tls-cert-design.md). Сбер выдаёт
 * сертификат на 12 месяцев и продлить его через API нельзя — только выпустить
 * новый в личном кабинете; здесь всё, чтобы это было заранее и без SSH.
 */

/** За сколько дней до конца начинать напоминать. */
export const TLS_WARN_DAYS = 60;

const FINTECH_BASE = process.env.SBER_FINTECH_BASE || 'https://fintech.sberbank.ru:9443';
const CLIENT_INFO_URL = `${FINTECH_BASE}/fintech/api/v2/client-info`;

export interface TlsStatus {
  /** file — из .env на сервере, db — загружен через кабинет, none — нет. */
  source: 'file' | 'db' | 'none';
  valid_to: string | null;
  days_left: number | null;
  subject: string | null;
  uploaded_at: string | null;
}

export function fmtRuDate(d: Date): string {
  return d.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric' });
}

export async function tlsStatus(): Promise<TlsStatus> {
  const active = await activeTls();
  if (!active) return { source: 'none', valid_to: null, days_left: null, subject: null, uploaded_at: null };
  let subject: string | null = null;
  try { subject = readPfxInfo(active.pfx, active.passphrase).subject; } catch { /* срок уже посчитан, CN — не обязателен */ }
  const meta = active.source === 'db' ? await storedTlsMeta().catch(() => null) : null;
  return {
    source: active.source,
    valid_to: active.validTo?.toISOString() ?? null,
    days_left: daysLeft(active.validTo),
    subject,
    uploaded_at: meta?.setAt?.toISOString() ?? null,
  };
}

export type VerifyResult = { ok: true; note?: string } | { ok: false; error: string };

/**
 * Проверить новый сертификат на живом Сбере до замены: client-info с токеном
 * компании через этот сертификат. 2xx — принят; 401 — TLS прошёл, истёк лишь
 * токен; 403/обрыв соединения — сертификат не принят (не тот client_id, отозван).
 */
export async function verifyTlsWithSber(
  bundle: { pfx: Buffer; passphrase: string },
  ownerUserId: number,
): Promise<VerifyResult> {
  let token: string | null = null;
  try {
    token = await getValidAccessToken(ownerUserId);
  } catch {
    // Текущий сертификат мог уже истечь — тогда обновить токен им нельзя;
    // проверяем тем токеном, что есть.
    token = (await sberTokenRepo.get(ownerUserId))?.access_token ?? null;
  }
  if (!token) return { ok: true, note: 'Сбербанк у вашей компании не подключён — связь этим сертификатом не проверена.' };
  let res;
  try {
    res = await sberFetch(CLIENT_INFO_URL, {
      headers: { Authorization: token, Accept: 'application/json' },
      tls: bundle,
      timeoutMs: 20_000,
    });
  } catch (err) {
    return { ok: false, error: `Сбер не принял соединение с этим сертификатом: ${(err as Error).message}` };
  }
  if (res.ok) return { ok: true };
  if (res.status === 401) return { ok: true, note: 'Соединение с этим сертификатом установлено; токен доступа истёк, данные не запрошены.' };
  return { ok: false, error: `Сбер ответил ${res.status} на запрос с этим сертификатом — проверьте, что он выпущен для этого сервиса (client_id) и не отозван.` };
}

/**
 * Принять .p12 из кабинета: разобрать, проверить срок и связь со Сбером,
 * сохранить в БД и сразу начать им пользоваться. Любой отказ — TlsCertError,
 * текущий сертификат при этом не трогается.
 */
export async function installTlsCert(
  input: { pfx: Buffer; password: string; ownerUserId: number },
  deps: { verify?: typeof verifyTlsWithSber } = {},
): Promise<{ status: TlsStatus; note?: string }> {
  const info = readPfxInfo(input.pfx, input.password);
  const now = Date.now();
  if (info.validTo.getTime() <= now) throw new TlsCertError(`Сертификат уже истёк (${fmtRuDate(info.validTo)}) — выпустите новый в личном кабинете Sber API.`);
  if (info.validFrom.getTime() > now + 10 * 60_000) throw new TlsCertError(`Сертификат начнёт действовать только ${fmtRuDate(info.validFrom)}.`);
  const current = await activeTls();
  if (current?.validTo && info.validTo.getTime() < current.validTo.getTime()) {
    throw new TlsCertError(`Этот сертификат действует до ${fmtRuDate(info.validTo)}, а текущий — дольше, до ${fmtRuDate(current.validTo)}. Загрузите более новый.`);
  }
  const verdict = await (deps.verify ?? verifyTlsWithSber)({ pfx: input.pfx, passphrase: input.password }, input.ownerUserId);
  if (!verdict.ok) throw new TlsCertError(verdict.error);
  await saveStoredTls(input.pfx, input.password, info);
  resetTlsCache();
  logger.info('[sber] TLS certificate uploaded', { valid_to: info.validTo.toISOString(), subject: info.subject });
  return { status: await tlsStatus(), note: verdict.note };
}
