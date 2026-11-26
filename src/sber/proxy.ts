import { sberFetch } from './sberClient';
import { SberApiError } from './payments';
import { withSberToken } from './oauth';

/**
 * Запросы SUBEX в Sber API через подключение ScanFlow.
 *
 * Токен Сбера привязан к TLS-сертификату приложения (40285): с чужим
 * сертификатом банк отвечает 403 CERTIFICATE_ACCESS_EXCEPTION. Поэтому SUBEX не
 * ходит в банк сам, а просит ScanFlow выполнить запрос — с его токеном и его
 * сертификатом. Пропускаются только перечисленные ниже операции: счета,
 * выписка, создание платёжки-черновика (без подписи деньги не уходят) и её статус.
 */
const FINTECH_BASE = process.env.SBER_FINTECH_BASE || 'https://fintech.sberbank.ru:9443';

const ALLOWED: Array<{ method: 'GET' | 'POST'; path: RegExp }> = [
  { method: 'GET', path: /^\/fintech\/api\/v[12]\/client-info$/ },
  { method: 'GET', path: /^\/fintech\/api\/v2\/statement\/(summary|transactions)$/ },
  { method: 'POST', path: /^\/fintech\/api\/v1\/payments$/ },
  { method: 'GET', path: /^\/fintech\/api\/v1\/payments\/[A-Za-z0-9-]{1,64}\/state$/ },
];

export class SberProxyDenied extends Error {}

export interface SberProxyRequest {
  method: string;
  path: string;
  query?: Record<string, string | number>;
  body?: unknown;
}

export interface SberProxyResult {
  status: number;
  body: string;
}

export function checkProxyRequest(r: SberProxyRequest): { method: 'GET' | 'POST'; url: string } {
  const method = String(r.method || '').toUpperCase();
  const path = String(r.path || '');
  const rule = ALLOWED.find(a => a.method === method && a.path.test(path));
  if (!rule) throw new SberProxyDenied(`Запрос ${method} ${path} к Сберу через ScanFlow не разрешён`);
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(r.query ?? {})) {
    if (!/^[A-Za-z]{1,40}$/.test(k)) throw new SberProxyDenied(`Недопустимый параметр ${k}`);
    qs.set(k, String(v));
  }
  const q = qs.toString();
  return { method: rule.method, url: `${FINTECH_BASE}${path}${q ? `?${q}` : ''}` };
}

/** Выполнить разрешённый запрос токеном компании; на 401 — обновить токен и повторить (withSberToken). */
export async function proxySberRequest(ownerUserId: number, r: SberProxyRequest): Promise<SberProxyResult> {
  const { method, url } = checkProxyRequest(r);
  const body = method === 'POST' ? JSON.stringify(r.body ?? {}) : undefined;
  return withSberToken(ownerUserId, async (accessToken) => {
    const res = await sberFetch(url, {
      method,
      headers: {
        Authorization: accessToken,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body,
      timeoutMs: 60_000,
    });
    if (res.status === 401) throw new SberApiError(401, res.body);
    return { status: res.status, body: res.body };
  });
}
