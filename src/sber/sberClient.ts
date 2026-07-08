import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import { logger } from '../utils/logger';

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

// Sber's fintech endpoint presents a server chain that doesn't build through any
// CA we have, so full chain verification (`rejectUnauthorized: true`) fails. mTLS
// authenticates US to Sber, but on its own gives no protection against an active
// MITM tampering with the response or the payee account in a payment draft.
//
// The defence that works WITHOUT a buildable chain is public-key pinning: after
// the TLS handshake we hash the peer's SubjectPublicKeyInfo and compare it to a
// pinned allow-list. Capture the pin(s) once on the server:
//
//   openssl s_client -connect fintech.sberbank.ru:9443 -servername fintech.sberbank.ru </dev/null 2>/dev/null \
//     | openssl x509 -pubkey -noout \
//     | openssl pkey -pubin -outform der \
//     | openssl dgst -sha256 -binary | openssl enc -base64
//
// then set SBER_PINNED_SPKI to that base64 (comma-separate several to allow key
// rotation / multiple hosts). When set, a mismatch aborts the connection.
// When UNSET we fall back to the legacy unpinned behaviour but warn loudly — so
// nothing breaks in prod until the operator captures the pin, but the gap is visible.
function pinnedSpkiSet(): Set<string> | null {
  const raw = process.env.SBER_PINNED_SPKI;
  if (!raw) return null;
  const pins = raw.split(',').map(s => s.trim()).filter(Boolean);
  return pins.length ? new Set(pins) : null;
}

let warnedUnpinned = false;

function spkiSha256Base64(der: Buffer): string {
  return crypto.createHash('sha256').update(der).digest('base64');
}

// Verify the peer's public-key pin on an established TLS socket. Returns an Error
// to abort with, or null when the connection is acceptable.
function verifyPin(socket: TLSSocket, hostname: string): Error | null {
  const pins = pinnedSpkiSet();
  if (!pins) {
    if (!warnedUnpinned) {
      warnedUnpinned = true;
      logger.warn(
        'SBER_PINNED_SPKI is not set — Sber TLS runs WITHOUT server-cert verification ' +
        '(MITM-exposed). Capture the pin on the server and set SBER_PINNED_SPKI. See src/sber/sberClient.ts.'
      );
    }
    return null;
  }
  const cert = socket.getPeerCertificate(true);
  if (!cert || !cert.pubkey) {
    return new Error('Sber TLS: no peer certificate to pin against');
  }
  const actual = spkiSha256Base64(cert.pubkey);
  if (!pins.has(actual)) {
    return new Error(
      `Sber TLS: server public-key pin mismatch for ${hostname} ` +
      `(got sha256/${actual}); refusing connection`
    );
  }
  return null;
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
        // Chain verification stays off because Sber's server chain doesn't build
        // through any CA we have — but confidentiality/integrity is restored by
        // public-key pinning in the `secureConnect` handler below (see verifyPin
        // / SBER_PINNED_SPKI). Without a configured pin this falls back to the
        // legacy unpinned behaviour and logs a warning.
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
    // Enforce the public-key pin as soon as the TLS handshake completes, before
    // any request body or response bytes are trusted. A mismatch aborts here.
    req.on('socket', (socket) => {
      const tlsSocket = socket as TLSSocket;
      tlsSocket.on('secureConnect', () => {
        const pinErr = verifyPin(tlsSocket, parsed.hostname);
        if (pinErr) req.destroy(pinErr);
      });
    });
    req.on('error', (err) => reject(new Error(`Sber request failed: ${err.message}`)));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Sber request timed out (30s)'));
    });
    if (options.body) req.write(options.body);
    req.end();
  });
}
