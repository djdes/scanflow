/**
 * Формат Responses API бэкенда Codex: содержимое запроса, строгая JSON-схема и разбор потока
 * событий (text/event-stream) ответа. Чистые функции, без сети.
 */

export type GptInputContent =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail: 'low' | 'high' | 'auto' };

export interface GptUsage { input: number; cached: number; output: number; reasoning: number }
export interface GptResponse { text: string; model: string | null; usage: GptUsage | null }

/**
 * Строгий режим JSON-схемы OpenAI: у каждого объекта все поля в required и
 * additionalProperties: false. Необязательные поля схемы (банковские реквизиты)
 * становятся обязательными со значением null.
 */
export function toStrictSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const s = schema as Record<string, unknown>;
  if (s.type === 'object' && s.properties && typeof s.properties === 'object') {
    const required = Array.isArray(s.required) ? (s.required as string[]) : [];
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(s.properties as Record<string, unknown>)) {
      let prop = toStrictSchema(value) as Record<string, unknown>;
      if (!required.includes(key) && typeof prop?.type === 'string') prop = { ...prop, type: [prop.type, 'null'] };
      properties[key] = prop;
    }
    return { ...s, properties, required: Object.keys(properties), additionalProperties: false };
  }
  if (s.type === 'array' && s.items) return { ...s, items: toStrictSchema(s.items) };
  return s;
}

/** Ошибка из потока ответа: лимит подписки отличается от прочих — по нему ставится пауза. */
export class GptStreamError extends Error {
  constructor(message: string, readonly rateLimited: boolean, readonly resetsAtMs: number | null) {
    super(message);
    this.name = 'GptStreamError';
  }
}

/**
 * Разбирает поток событий Responses API в итоговый текст и расход. Событие ошибки бросается
 * (GptStreamError); оборванный ответ без текста — тоже.
 */
export function parseResponsesStream(raw: string): GptResponse {
  const deltas: string[] = [];
  const items: string[] = [];
  let usage: GptUsage | null = null;
  let model: string | null = null;
  let incomplete: string | null = null;

  for (const block of raw.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
    if (!data || data === '[DONE]') continue;
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(data); } catch { continue; }
    const type = ev.type;
    if (type === 'error' || type === 'response.failed') throw streamError(ev);
    if (type === 'response.output_text.delta' && typeof ev.delta === 'string') deltas.push(ev.delta);
    if (type === 'response.output_item.done') items.push(messageText(ev.item));
    if (type === 'response.completed' || type === 'response.incomplete') {
      const response = ev.response as Record<string, unknown> | undefined;
      usage = usageOf(response?.usage) ?? usage;
      if (typeof response?.model === 'string') model = response.model;
      if (type === 'response.incomplete') {
        const reason = (response?.incomplete_details as { reason?: unknown } | undefined)?.reason;
        incomplete = typeof reason === 'string' ? reason : 'incomplete';
      }
    }
  }
  const text = (deltas.length ? deltas.join('') : items.join('')).trim();
  if (incomplete) throw new GptStreamError(`GPT: ответ оборван (${incomplete})`, false, null);
  if (!text) throw new GptStreamError('GPT: no text in response', false, null);
  return { text, model, usage };
}

function streamError(ev: Record<string, unknown>): GptStreamError {
  const response = ev.response as { error?: { message?: unknown; code?: unknown } } | undefined;
  const nested = ev.error as { message?: unknown; code?: unknown; type?: unknown; resets_at?: unknown; resets_in_seconds?: unknown } | undefined;
  const message = [ev.message, response?.error?.message, nested?.message].find(m => typeof m === 'string' && m) as string | undefined;
  const code = String(response?.error?.code ?? nested?.code ?? nested?.type ?? '');
  const rateLimited = /usage_limit|rate_limit|insufficient_quota/i.test(code) || /usage limit/i.test(message ?? '');
  return new GptStreamError(`GPT: ${message ?? 'бэкенд вернул ошибку без пояснений'}`, rateLimited, resetFromError(nested));
}

/** Когда снимется лимит: из тела ошибки (resets_at — секунды эпохи, resets_in_seconds). */
export function resetFromError(source: { resets_at?: unknown; resets_in_seconds?: unknown } | null | undefined, nowMs = Date.now()): number | null {
  const at = Number(source?.resets_at);
  if (Number.isFinite(at) && at > 0) return at * 1000;
  const inSec = Number(source?.resets_in_seconds);
  if (Number.isFinite(inSec) && inSec > 0) return nowMs + inSec * 1000;
  return null;
}

function messageText(item: unknown): string {
  const it = item as { type?: unknown; content?: unknown } | null;
  if (!it || it.type !== 'message' || !Array.isArray(it.content)) return '';
  return it.content
    .map((part: { type?: unknown; text?: unknown }) => (part?.type === 'output_text' && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

function usageOf(value: unknown): GptUsage | null {
  if (!value || typeof value !== 'object') return null;
  const u = value as { input_tokens?: unknown; output_tokens?: unknown; input_tokens_details?: { cached_tokens?: unknown }; output_tokens_details?: { reasoning_tokens?: unknown } };
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    input: n(u.input_tokens),
    cached: n(u.input_tokens_details?.cached_tokens),
    output: n(u.output_tokens),
    reasoning: n(u.output_tokens_details?.reasoning_tokens),
  };
}
