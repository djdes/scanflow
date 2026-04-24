import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

// Hash format: scrypt$N$saltHex$hashHex
// N is the scrypt cost parameter (logN — 14 → 2^14 = ~50ms on a modern server,
// reasonable trade-off between throughput and brute-force resistance for an
// internal admin login). Stored alongside the hash so we can bump it later
// without breaking existing hashes.
const SCRYPT_LOG_N = 14;
const KEY_LEN = 64;
const SALT_LEN = 16;

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LEN);
  const cost = 1 << SCRYPT_LOG_N;
  const hash = scryptSync(password, salt, KEY_LEN, { N: cost });
  return `scrypt$${SCRYPT_LOG_N}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const logN = parseInt(parts[1], 10);
  if (!Number.isFinite(logN) || logN < 10 || logN > 20) return false;
  const salt = Buffer.from(parts[2], 'hex');
  const expected = Buffer.from(parts[3], 'hex');
  if (salt.length === 0 || expected.length === 0) return false;
  const cost = 1 << logN;
  let actual: Buffer;
  try {
    actual = scryptSync(password, salt, expected.length, { N: cost });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function generateApiKey(): string {
  return randomBytes(24).toString('hex');
}
