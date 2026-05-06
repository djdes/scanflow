import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

export interface SberFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface SberResponse {
  status: number;
  ok: boolean;
  body: string;
  json<T = unknown>(): T;
}

interface TlsBundle {
  pfx: Buffer;
  passphrase: string;
  ca?: Buffer;
}

let cachedTls: TlsBundle | null = null;

function loadTls(): TlsBundle {
  if (cachedTls) return cachedTls;
  const pfxPath = process.env.SBER_TLS_PFX;
  const passphrase = process.env.SBER_TLS_PFX_PASSWORD;
  if (!pfxPath || !passphrase) {
    throw new Error('SBER_TLS_PFX or SBER_TLS_PFX_PASSWORD not configured');
  }
  const resolved = path.resolve(process.cwd(), pfxPath);
  const pfx = fs.readFileSync(resolved);
  let ca: Buffer | undefined;
  const caPath = process.env.SBER_CA_CERT;
  if (caPath) {
    try {
      ca = fs.readFileSync(path.resolve(process.cwd(), caPath));
    } catch {
      // CA file optional locally
    }
  }
  cachedTls = { pfx, passphrase, ca };
  return cachedTls;
}

// For tests
export function _resetTlsCache(): void {
  cachedTls = null;
}

export async function sberFetch(url: string, options: SberFetchOptions = {}): Promise<SberResponse> {
  const tls = loadTls();
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
        rejectUnauthorized: tls.ca ? true : false,
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
