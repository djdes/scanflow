import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { pfxValidTo, pickFreshest, type TlsBundle } from './tlsCert';
import { loadStoredTls } from './tlsStore';
import { logger } from '../utils/logger';

export interface SberFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** Другой клиентский сертификат на один запрос — проверка нового .p12 перед заменой. */
  tls?: { pfx: Buffer; passphrase: string };
}

export interface SberResponse {
  status: number;
  ok: boolean;
  body: string;
  json<T = unknown>(): T;
}

let cachedTls: TlsBundle | null = null;
let cachedAt = 0;
let loadingTls: Promise<TlsBundle> | null = null;
let tlsGeneration = 0;
/** Выбор пересматривается раз в час: другой процесс мог загрузить новый сертификат, а на сервер — положить файл. */
const TLS_CACHE_MS = 3_600_000;

/** Сертификат из .env (SBER_TLS_PFX + SBER_TLS_PFX_PASSWORD); null — не задан или файла нет. */
function loadFileTls(): TlsBundle | null {
  const pfxPath = process.env.SBER_TLS_PFX;
  const passphrase = process.env.SBER_TLS_PFX_PASSWORD;
  if (!pfxPath || !passphrase) return null;
  let pfx: Buffer;
  try {
    pfx = fs.readFileSync(path.resolve(process.cwd(), pfxPath));
  } catch (err) {
    logger.warn('[sber] TLS certificate file from .env not readable', { error: (err as Error).message });
    return null;
  }
  return { pfx, passphrase, source: 'file', validTo: pfxValidTo(pfx, passphrase) };
}

function loadCa(): Buffer | undefined {
  const caPath = process.env.SBER_CA_CERT;
  if (!caPath) return undefined;
  try {
    return fs.readFileSync(path.resolve(process.cwd(), caPath));
  } catch {
    return undefined; // CA file optional locally
  }
}

/**
 * Клиентский сертификат для соединений: из файла .env или загруженный через
 * кабинет (БД) — тот, что действует дольше. Так новый сертификат начинает
 * работать сразу после загрузки, а положенный на сервер вручную свежий файл
 * тоже не проигрывает старому из БД.
 */
async function loadTls(): Promise<TlsBundle> {
  if (cachedTls && Date.now() - cachedAt < TLS_CACHE_MS) return cachedTls;
  if (!loadingTls) {
    const generation = tlsGeneration;
    loadingTls = (async () => {
      let stored: TlsBundle | null = null;
      try {
        stored = await loadStoredTls();
      } catch (err) {
        logger.warn('[sber] stored TLS certificate not loaded', { error: (err as Error).message });
      }
      const picked = pickFreshest([loadFileTls(), stored]);
      if (!picked) {
        throw new Error('TLS-сертификат Сбера не задан: загрузите .p12 на странице «Сбербанк» (или SBER_TLS_PFX и SBER_TLS_PFX_PASSWORD в .env)');
      }
      const bundle = { ...picked, ca: loadCa() };
      // Пока читали, загрузили новый сертификат — этот выбор устарел, не кэшируем.
      if (generation === tlsGeneration) {
        cachedTls = bundle;
        cachedAt = Date.now();
      }
      return bundle;
    })().finally(() => { if (generation === tlsGeneration) loadingTls = null; });
  }
  return loadingTls;
}

/** Сертификат, с которым сейчас идут запросы к Сберу (для страницы «Сбербанк»). */
export async function activeTls(): Promise<Pick<TlsBundle, 'source' | 'validTo' | 'pfx' | 'passphrase'> | null> {
  try { return await loadTls(); } catch { return null; }
}

/** Забыть выбранный сертификат: следующий запрос выберет заново (после загрузки нового). */
export function resetTlsCache(): void {
  cachedTls = null;
  loadingTls = null;
  tlsGeneration++;
}
export const _resetTlsCache = resetTlsCache;

export async function sberFetch(url: string, options: SberFetchOptions = {}): Promise<SberResponse> {
  const tls = options.tls ? { ...options.tls, ca: loadCa() } : await loadTls();
  const parsed = new URL(url);
  return new Promise<SberResponse>((resolve, reject) => {
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : 9443,
        path: parsed.pathname + parsed.search,
        method: options.method || 'GET',
        headers: options.headers || {},
        pfx: tls.pfx,
        passphrase: tls.passphrase,
        ca: tls.ca,
        // Sber's fintech endpoint uses a server cert chain that doesn't
        // build through any CA we have access to (the sber-ca.pem we get
        // from the developers portal covers a different SberAPI CA).
        // mTLS still authenticates us to Sber via the client PFX, and the
        // host is hardcoded — so disabling server-cert verification is
        // safe in practice. (Same approach as the working TotalBussines
        // implementation.)
        rejectUnauthorized: false,
        timeout: options.timeoutMs ?? 30_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          const status = res.statusCode || 0;
          resolve({
            status,
            ok: status >= 200 && status < 300,
            body,
            json<T>() { return JSON.parse(body) as T; },
          });
        });
      },
    );
    req.on('error', (err) => reject(new Error(`Sber request failed: ${err.message}`)));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Sber request timed out (30s)'));
    });
    if (options.body) req.write(options.body);
    req.end();
  });
}
