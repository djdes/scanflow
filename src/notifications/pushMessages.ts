import type { EventPayload, EventType } from './types';

/**
 * Уведомления на телефон (Web Push, мобильное приложение /m/ — правило 48):
 * коротко и простыми словами, нажатие открывает накладную в приложении.
 * Чистые функции — тексты и проверка адреса подписки; отправка — push.ts.
 */

export interface PushMessage {
  title: string;
  body: string;
  url: string;
  /** Одинаковый tag заменяет прежнее уведомление о той же накладной. */
  tag: string;
  /** Число на значке приложения («Проверить»), если известно. */
  badge?: number;
}

interface InvoiceLike {
  id: number;
  supplier?: string | null;
  total_sum?: number | null;
}

const MAX_SUPPLIER = 60;

function money(value: number): string {
  const [int, frac] = Math.abs(value).toFixed(2).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${value < 0 ? '−' : ''}${grouped}${frac === '00' ? '' : ',' + frac} ₽`;
}

function shortSupplier(name: string | null | undefined): string {
  const s = String(name ?? '').trim().replace(/\s+/g, ' ');
  return s.length > MAX_SUPPLIER ? `${s.slice(0, MAX_SUPPLIER - 1).trimEnd()}…` : s;
}

/** «Поставщик · сумма», без пустых частей. */
function who(inv: InvoiceLike): string {
  const parts = [shortSupplier(inv.supplier)];
  if (typeof inv.total_sum === 'number' && Number.isFinite(inv.total_sum) && inv.total_sum > 0) parts.push(money(inv.total_sum));
  return parts.filter(Boolean).join(' · ');
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

/**
 * Текст уведомления о событии накладной или null — о нём на телефон не пишем:
 * загрузку, «в очередь 1С» и правки человек сделал сам, недельная сводка идёт
 * отдельной рассылкой.
 */
export function pushMessage(eventType: EventType, payload: EventPayload, invoice: InvoiceLike): PushMessage | null {
  const id = Number(invoice.id ?? payload.invoice_id);
  const base = { url: `/m/#/inv/${id}`, tag: `inv-${id}` };
  const line = who(invoice) || 'Откройте, чтобы посмотреть.';
  switch (eventType) {
    case 'invoice_recognized': return { title: 'Накладная прочитана', body: line, ...base };
    case 'recognition_error': return { title: 'Не прочиталась накладная', body: 'Переснимите при хорошем свете.', ...base };
    case 'suspicious_total': {
      const supplier = shortSupplier(invoice.supplier);
      return { title: 'Проверьте сумму', body: supplier ? `${supplier}: сумма не сходится.` : 'Сумма не сходится.', ...base };
    }
    case 'elevated_prices': return { title: 'Цены выше обычного', body: line, ...base };
    case 'sent_to_1c': return { title: 'Накладная в 1С ✓', body: line, ...base };
    case 'sber_payment_overdue': return { title: 'Не оплачена накладная', body: line, ...base };
    default: return null;
  }
}

/** Сводка пачки загрузок (пакетный режим уведомлений) или null, если читать нечего. */
export function pushBatchMessage(summary: { uploaded: number; recognized: number; errors: unknown[] }): PushMessage | null {
  const ok = summary.recognized;
  const failed = summary.errors.length;
  if (!ok && !failed) return null;
  const title = ok
    ? `${plural(ok, 'Прочитана', 'Прочитано', 'Прочитано')} ${ok} ${plural(ok, 'накладная', 'накладные', 'накладных')}`
    : `Не прочиталось ${failed} ${plural(failed, 'накладная', 'накладные', 'накладных')}`;
  const body = failed
    ? `${failed} не ${plural(failed, 'прочиталась', 'прочитались', 'прочитались')} — переснимите.`
    : 'Можно проверять.';
  return { title, body, url: '/m/#/list/all', tag: 'batch' };
}

// Службы уведомлений браузеров: Chrome, Android, Яндекс и Samsung — Google (FCM;
// сборки Chromium без ключей Google — jmt17.google.com), Safari — Apple,
// Firefox — Mozilla, Edge — Microsoft. Других адресов сервер не касается: иначе
// подписка с адресом во внутренней сети стала бы запросом туда.
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^jmt17\.google\.com$/,
  /(^|\.)push\.apple\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)notify\.windows\.com$/,
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try { url = new URL(endpoint); } catch { return false; }
  if (url.protocol !== 'https:' || (url.port && url.port !== '443')) return false;
  return PUSH_HOSTS.some(re => re.test(url.hostname));
}
