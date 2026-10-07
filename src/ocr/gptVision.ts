/**
 * Модели GPT для режима анализатора `gpt` — основного: всё, что делает ИИ, идёт через
 * ИИ-шлюз (src/ai/gateway.ts) по своей подписке ChatGPT, подключённой в ScanFlow по коду
 * (src/chatgpt/). Здесь — только имена моделей и признаки режимов.
 */

export const DEFAULT_GPT_MODEL = 'gpt-6.1-sol';
const GPT_MODEL_RE = /^gpt-[a-z0-9._-]{1,60}$/i;

/** Имя модели GPT (подписка ChatGPT), безопасное для запроса. */
export function isGptModel(model: string | null | undefined): boolean {
  return typeof model === 'string' && GPT_MODEL_RE.test(model);
}

/** Режимы, в которых фото читает модель по фото (GPT или Claude), а не цепочка OCR. */
export function isVisionLlmMode(mode: string | null | undefined): boolean {
  return mode === 'claude_api' || mode === 'gpt';
}
