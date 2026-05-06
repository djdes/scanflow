const SECRET_KEYS = new Set([
  'access_token',
  'refresh_token',
  'client_secret',
  'api_key',
  'password',
  'pfx_password',
  'payerAccount',
  'payeeAccount',
  'payer_account',
  'payee_account',
]);

export function redact<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((v) => redact(v)) as unknown as T;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.has(k) ? '***' : redact(v);
    }
    return out as unknown as T;
  }
  return value;
}
