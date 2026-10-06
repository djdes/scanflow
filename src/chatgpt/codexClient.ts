import { fetch as undiciFetch } from 'undici';
import { chatgptConnectionRepo } from '../database/repositories/chatgptConnectionRepo';
import { logger } from '../utils/logger';
import { acquireChatgptAccess, type ChatgptAccess } from './access';
import { openaiDispatcher } from './deviceAuth';
import { GptStreamError, parseResponsesStream, resetFromError, toStrictSchema, type GptInputContent, type GptResponse } from './responses';

/**
 * Запрос к модели по своей подписке ChatGPT — бэкенд Codex в ChatGPT (тот же адрес, куда
 * ходит официальный codex с входом через ChatGPT). Адрес внутренний, без публичной
 * документации: весь доступ к нему — здесь, чтобы при изменениях править одно место.
 */
const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const ORIGINATOR = 'codex_cli_rs';
const USER_AGENT = 'codex_cli_rs/0.160.0 (ScanFlow)';
/** Лимит без названного времени сброса — скорее короткий всплеск: пауза минута. */
const DEFAULT_COOLDOWN_MS = 60_000;

export interface CodexRequest {
  model: string;
  instructions: string;
  content: GptInputContent[];
  /** Строгий JSON-ответ по схеме; без схемы — свободный текст. */
  schema?: { name: string; schema: unknown };
  effort: 'low' | 'medium' | 'high';
  signal: AbortSignal;
  label: string;
}

/** Тело запроса Responses API для бэкенда Codex. Чистая функция — её проверяют тесты. */
export function buildCodexBody(req: Omit<CodexRequest, 'signal' | 'label'>): Record<string, unknown> {
  return {
    model: req.model,
    instructions: req.instructions,
    input: [{ type: 'message', role: 'user', content: req.content }],
    reasoning: { effort: req.effort },
    ...(req.schema
      ? { text: { format: { type: 'json_schema', name: req.schema.name, schema: toStrictSchema(req.schema.schema), strict: true } } }
      : {}),
    // store: false обязателен — с true бэкенд подписки отклоняет запрос.
    store: false,
    stream: true,
  };
}

export function codexHeaders(access: ChatgptAccess): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${access.accessToken}`,
    originator: ORIGINATOR,
    'user-agent': USER_AGENT,
    'content-type': 'application/json',
    accept: 'text/event-stream',
  };
  // Без account id бэкенд отвечает 401.
  if (access.accountId) headers['chatgpt-account-id'] = access.accountId;
  return headers;
}

/**
 * Один запрос к модели. На 401 — один повтор с принудительно обновлённым токеном; на 429 —
 * пауза подключения до сброса лимита. Ошибка HTTP бросается с полем status (по нему withRetry
 * решает, повторять ли).
 */
export async function codexRespond(req: CodexRequest): Promise<GptResponse> {
  const body = JSON.stringify(buildCodexBody(req));
  const dispatcher = openaiDispatcher();
  const send = (access: ChatgptAccess) => undiciFetch(CODEX_RESPONSES_URL, {
    method: 'POST',
    headers: codexHeaders(access),
    body,
    signal: req.signal,
    ...(dispatcher ? { dispatcher } : {}),
  });

  let access = await acquireChatgptAccess();
  let res = await send(access);
  if (res.status === 401) {
    await res.text().catch(() => '');
    access = await acquireChatgptAccess({ rejectedAccessToken: access.accessToken });
    res = await send(access);
    if (res.status === 401) await chatgptConnectionRepo.markReauth('ChatGPT отклонил токен (401)');
  }

  const raw = await res.text();
  if (!res.ok) {
    const detail = errorDetail(raw, res.status);
    if (res.status === 429) {
      await chatgptConnectionRepo.markRateLimited(rateLimitResetMs(raw, res.headers) ?? Date.now() + DEFAULT_COOLDOWN_MS, `Лимит подписки ChatGPT: ${detail}`);
    }
    throw Object.assign(new Error(`ChatGPT ${res.status}: ${detail}`), { status: res.status });
  }

  let parsed: GptResponse;
  try {
    parsed = parseResponsesStream(raw);
  } catch (e) {
    if (e instanceof GptStreamError && e.rateLimited) {
      await chatgptConnectionRepo.markRateLimited(e.resetsAtMs ?? Date.now() + DEFAULT_COOLDOWN_MS, e.message);
    }
    throw e;
  }
  void chatgptConnectionRepo.touchUsed(Date.now()).catch(() => {});
  logger.info(`${req.label}: usage`, {
    model: parsed.model ?? req.model,
    input: parsed.usage?.input,
    cached: parsed.usage?.cached,
    output: parsed.usage?.output,
    reasoning: parsed.usage?.reasoning,
  });
  return parsed;
}

function errorDetail(raw: string, status: number): string {
  if (status === 403 && /<html|cloudflare|cf-ray|just a moment/i.test(raw)) {
    return 'похоже на блокировку по IP или региону — проверьте OPENAI_PROXY_URL';
  }
  try {
    const data = JSON.parse(raw) as { error?: { message?: unknown } | string; detail?: unknown; message?: unknown };
    const message = typeof data.error === 'object' ? data.error?.message : data.error ?? data.detail ?? data.message;
    if (typeof message === 'string' && message) return message.slice(0, 300);
  } catch { /* не JSON */ }
  return raw.replace(/\s+/g, ' ').trim().slice(0, 300) || 'без пояснений';
}

/** Время сброса лимита: из тела ошибки или из заголовков codex / retry-after. */
function rateLimitResetMs(raw: string, headers: { get(name: string): string | null }): number | null {
  try {
    const data = JSON.parse(raw) as { error?: Record<string, unknown> } & Record<string, unknown>;
    const fromBody = resetFromError((data.error && typeof data.error === 'object' ? data.error : data) as never);
    if (fromBody) return fromBody;
  } catch { /* не JSON */ }
  for (const name of ['x-codex-primary-reset-after-seconds', 'retry-after']) {
    const seconds = Number(headers.get(name));
    if (Number.isFinite(seconds) && seconds > 0) return Date.now() + seconds * 1000;
  }
  return null;
}
