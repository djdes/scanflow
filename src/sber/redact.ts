// Keys whose values are secrets/PII, matched case- and separator-insensitively:
// the value is compared after stripping '_'/'-' and lowercasing, so both
// `access_token` and `accessToken` are caught by a single entry.
const SECRET_KEYS_NORMALISED = new Set([
  'accesstoken',
  'refreshtoken',
  'clientsecret',
  'apikey',
  'password',
  'pfxpassword',
  'bottoken',
  'dispatchertoken',
  'jwtsecret',
  'payeraccount',
  'payeeaccount',
]);

function isSecretKey(key: string): boolean {
  return SECRET_KEYS_NORMALISED.has(key.replace(/[_-]/g, '').toLowerCase());
}

function redactInner<T>(value: T, seen: WeakSet<object>): T {
  if (value === null || value === undefined) return value;
  // Leave non-plain objects (Date, Buffer, etc.) intact — Object.entries() would
  // otherwise flatten a Date to {} and mangle a Buffer.
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    return value.map((v) => redactInner(v, seen)) as unknown as T;
  }
  if (typeof value === 'object') {
    if (seen.has(value as object)) return value; // cycle guard — avoid RangeError
    seen.add(value as object);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) ? '***' : redactInner(v, seen);
    }
    return out as unknown as T;
  }
  return value;
}

export function redact<T>(value: T): T {
  return redactInner(value, new WeakSet<object>());
}
