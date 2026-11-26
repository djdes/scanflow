import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';

/**
 * Клиентский TLS-сертификат Sber API (.p12). Сбер выдаёт его на 12 месяцев,
 * продлить через API нельзя — только выпустить новый в личном кабинете
 * (docs/superpowers/specs/2026-11-05-sber-tls-cert-design.md). Здесь — разбор
 * файла и выбор того, что действует дольше; хранение — tlsStore.ts.
 */

export interface TlsBundle {
  pfx: Buffer;
  passphrase: string;
  ca?: Buffer;
  /** Откуда взят: файл из .env или загружен через кабинет (БД). */
  source: 'file' | 'db';
  /** Срок сертификата; null — разобрать не удалось. */
  validTo: Date | null;
}

export interface TlsCertInfo {
  validFrom: Date;
  validTo: Date;
  subject: string | null;
}

export class TlsCertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TlsCertError';
  }
}

/** Срок и CN сертификата из .p12. Неверный пароль или не .p12 — TlsCertError с понятной причиной. */
export function readPfxInfo(pfx: Buffer, passphrase: string): TlsCertInfo {
  let der: Buffer | null | undefined;
  try {
    const ctx = tls.createSecureContext({ pfx, passphrase });
    // Публичного API «сертификат из SecureContext» нет; нативный метод есть с
    // давних версий (проверено на Node 20.10 и 25 — прод на 20, локально 25).
    der = (ctx.context as { getCertificate?: () => Buffer | null }).getCertificate?.();
  } catch (err) {
    const msg = (err as Error).message || '';
    if (/mac verify|bad decrypt|password|pkcs12 cipherfinal/i.test(msg)) {
      throw new TlsCertError('Неверный пароль от сертификата');
    }
    throw new TlsCertError('Файл не похож на сертификат .p12 (PKCS#12)');
  }
  if (!der) throw new TlsCertError('В файле .p12 нет сертификата');
  const x = new X509Certificate(der);
  const cn = x.subject.split('\n').find(l => l.startsWith('CN='))?.slice(3) ?? null;
  return { validFrom: new Date(x.validFrom), validTo: new Date(x.validTo), subject: cn };
}

/** Срок сертификата или null, если файл/пароль не разбираются. */
export function pfxValidTo(pfx: Buffer, passphrase: string): Date | null {
  try { return readPfxInfo(pfx, passphrase).validTo; } catch { return null; }
}

/**
 * Какой сертификат ставить в соединение: действующий дольше всех. Сертификат с
 * неизвестным сроком проигрывает любому с известным, но если других нет — берём
 * его (так было до хранения в БД: файл из .env без проверки срока).
 */
export function pickFreshest(candidates: Array<TlsBundle | null | undefined>): TlsBundle | null {
  const list = candidates.filter((c): c is TlsBundle => !!c);
  if (!list.length) return null;
  return list.reduce((best, c) => {
    const b = best.validTo?.getTime() ?? -Infinity;
    const n = c.validTo?.getTime() ?? -Infinity;
    return n > b ? c : best;
  });
}

export function daysLeft(validTo: Date | null, now = Date.now()): number | null {
  if (!validTo) return null;
  return Math.floor((validTo.getTime() - now) / 86_400_000);
}
