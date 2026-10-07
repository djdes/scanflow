import type { AiEngine } from './types';

/**
 * Почему до модели сейчас не достучаться:
 *   not_connected   — подписка ChatGPT не подключена (у Claude — нет ключа);
 *   reauth_required — ChatGPT просит войти заново;
 *   rate_limited    — исчерпан лимит подписки, retryAtMs — когда сбросится;
 *   network         — OpenAI или прокси не отвечают.
 */
export type AiUnavailableReason = 'not_connected' | 'reauth_required' | 'rate_limited' | 'network';

/**
 * Модель недоступна — это не ошибка документа. Накладная в таком случае ждёт
 * (статус waiting_ai) и распознаётся, когда модель снова доступна. Плохой ответ модели
 * (невалидный JSON, обрыв) — обычная ошибка, а не эта.
 */
export class AiUnavailableError extends Error {
  constructor(
    readonly reason: AiUnavailableReason,
    readonly retryAtMs: number | null,
    readonly detail: string | null = null,
    readonly engine: AiEngine = 'gpt',
  ) {
    super(aiUnavailableText(reason, retryAtMs, engine) + (detail ? ` (${detail})` : ''));
    this.name = 'AiUnavailableError';
  }

  /** Текст для людей — без технических подробностей. */
  get text(): string {
    return aiUnavailableText(this.reason, this.retryAtMs, this.engine);
  }
}

/** Время по Москве: «18:40» сегодня, иначе «08.10 18:40». */
export function formatMsk(ms: number): string {
  const opts: Intl.DateTimeFormatOptions = { timeZone: 'Europe/Moscow' };
  const day = (t: number) => new Date(t).toLocaleDateString('ru-RU', { ...opts, day: '2-digit', month: '2-digit' });
  const time = new Date(ms).toLocaleTimeString('ru-RU', { ...opts, hour: '2-digit', minute: '2-digit' });
  return day(ms) === day(Date.now()) ? time : `${day(ms)} ${time}`;
}

export function aiUnavailableText(reason: AiUnavailableReason, retryAtMs: number | null, engine: AiEngine = 'gpt'): string {
  if (engine === 'claude') {
    if (reason === 'not_connected') return 'Не задан ключ Anthropic';
    if (reason === 'network') return 'Anthropic API не отвечает';
  }
  switch (reason) {
    case 'not_connected': return 'ChatGPT не подключён: Настройки → «Войти по коду»';
    case 'reauth_required': return 'ChatGPT просит войти заново: Настройки → «Войти по коду»';
    case 'rate_limited': return retryAtMs ? `Лимит подписки ChatGPT до ${formatMsk(retryAtMs)} МСК` : 'Лимит подписки ChatGPT исчерпан';
    case 'network': return 'OpenAI или прокси не отвечают';
  }
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED',
]);

/**
 * Сбой связи с моделью, а не с конкретным документом: соединение не установилось, прокси
 * или сервер модели ответил 5xx/407, Cloudflare закрыл доступ по IP. Таймаут ответа сюда
 * НЕ относится: если модель не успевает прочитать конкретную страницу, это беда страницы,
 * и такая накладная не должна вечно ждать, загораживая остальные.
 */
export function isNetworkFailure(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; message?: string; code?: string; status?: number; cause?: unknown };
  if (e.name === 'AbortError' || e.name === 'TimeoutError' || e.name === 'APIConnectionTimeoutError') return false;
  if (typeof e.status === 'number') {
    if (e.status >= 500 && e.status <= 599) return true;
    if (e.status === 407) return true;
    return e.status === 403 && /блокировк/i.test(e.message ?? '');
  }
  if (e.code && NETWORK_CODES.has(e.code)) return true;
  if (e.name === 'APIConnectionError') return true;
  const cause = e.cause as { code?: string } | undefined;
  if (cause && typeof cause === 'object' && cause.code && NETWORK_CODES.has(cause.code)) return true;
  return e.name === 'TypeError' && /fetch failed/i.test(e.message ?? '');
}
