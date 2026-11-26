import { sberAppRepo } from '../database/repositories/sberAppRepo';
import { sealSecret, openSecret } from './secretBox';
import { pfxValidTo, type TlsBundle, type TlsCertInfo } from './tlsCert';
import { logger } from '../utils/logger';

/**
 * TLS-сертификат Sber API, загруженный через кабинет: лежит в sber_app
 * (миграция 94) зашифрованным — файл и пароль с разными purpose, ключ из
 * JWT_SECRET (как client_secret). Сертификат действует на один client_id,
 * поэтому строка — по SBER_CLIENT_ID.
 *
 * Модуль не импортирует sberClient/appCredentials: sberClient сам читает отсюда.
 */
const PFX_PURPOSE = 'sber-tls-pfx';
const PASS_PURPOSE = 'sber-tls-pass';

/** DATETIME из БД (UTC без 'Z') → Date. */
function parseUtc(s: string | null | undefined): Date | null {
  if (!s) return null;
  const t = String(s);
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface StoredTlsMeta {
  validTo: Date | null;
  subject: string | null;
  setAt: Date | null;
}

export async function storedTlsMeta(): Promise<StoredTlsMeta | null> {
  const clientId = process.env.SBER_CLIENT_ID;
  if (!clientId) return null;
  const row = await sberAppRepo.get(clientId);
  if (!row?.tls_pfx_enc) return null;
  return { validTo: parseUtc(row.tls_valid_to), subject: row.tls_subject ?? null, setAt: parseUtc(row.tls_set_at) };
}

/** Сертификат из БД для соединения; null — не загружали или не расшифровать (сменился JWT_SECRET). */
export async function loadStoredTls(): Promise<TlsBundle | null> {
  const clientId = process.env.SBER_CLIENT_ID;
  if (!clientId) return null;
  const row = await sberAppRepo.get(clientId);
  if (!row?.tls_pfx_enc || !row.tls_pass_enc) return null;
  try {
    const pfx = Buffer.from(openSecret(row.tls_pfx_enc, PFX_PURPOSE), 'base64');
    const passphrase = openSecret(row.tls_pass_enc, PASS_PURPOSE);
    return { pfx, passphrase, source: 'db', validTo: parseUtc(row.tls_valid_to) ?? pfxValidTo(pfx, passphrase) };
  } catch (err) {
    logger.error('[sber] stored TLS certificate cannot be decrypted (JWT_SECRET changed?)', { error: (err as Error).message });
    return null;
  }
}

export async function saveStoredTls(pfx: Buffer, passphrase: string, info: TlsCertInfo): Promise<void> {
  const clientId = process.env.SBER_CLIENT_ID;
  if (!clientId) throw new Error('SBER_CLIENT_ID не задан в .env');
  await sberAppRepo.saveTls(clientId, {
    pfxEnc: sealSecret(pfx.toString('base64'), PFX_PURPOSE),
    passEnc: sealSecret(passphrase, PASS_PURPOSE),
    validTo: info.validTo.toISOString().slice(0, 19).replace('T', ' '),
    subject: info.subject ? info.subject.slice(0, 255) : null,
  });
}
