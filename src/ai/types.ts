/**
 * Общие типы ИИ-шлюза (src/ai/gateway.ts). Через шлюз идут все вызовы модели в ScanFlow:
 * распознавание, подбор позиций 1С, советчик правил, помощник, подсветка источника.
 */

/** Движок: GPT по подписке ChatGPT (основной) или Claude по ключу Anthropic (только режим claude_api). */
export type AiEngine = 'gpt' | 'claude';

/** Чем выполнить запрос. Создаётся только resolveAiTarget()/aiTargetFromConfig() — из режима анализатора. */
export interface AiTarget {
  engine: AiEngine;
  model: string;
  /** Ключ Anthropic; у GPT не нужен — доступ по подписке (src/chatgpt/). */
  apiKey: string | null;
}

export type AiImageType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

export type AiInput =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: AiImageType; data: string /* base64 */ };

export interface AiRequest {
  target: AiTarget;
  /** Подпись в журнале: «GPT single document», «map items» … */
  label: string;
  /** Блоки инструкций. У Claude каждый — отдельный блок с кэшем, у GPT — склеиваются. */
  system?: string[];
  content: AiInput[] | string;
  effort?: 'low' | 'medium' | 'high';
  /** Детализация картинок у GPT: low — для служебных превью (поворот). */
  imageDetail?: 'low' | 'high';
  /** Потолок вывода у Claude (размышления тратят тот же бюджет). По умолчанию 32000. */
  maxOutputTokens?: number;
  /** Размышления Claude: adaptive (по умолчанию), disabled или не передавать вовсе. */
  thinking?: 'adaptive' | 'disabled' | 'default';
  /** Таймаут одной попытки. По умолчанию 240 с — плотная страница читается минуты. */
  timeoutMs?: number;
  /** Повторы при сбое (не при недоступности). По умолчанию 2 — всего 3 попытки. */
  retries?: number;
}

export interface AiStructuredRequest extends AiRequest {
  /** JSON-схема ответа. Для GPT шлюз делает её строгой (toStrictSchema). */
  schema: Record<string, unknown>;
  schemaName: string;
}

export interface AiResponse {
  text: string;
  /** Ответ обрезан потолком вывода (только Claude: stop_reason = max_tokens). */
  truncated: boolean;
}
