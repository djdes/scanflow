import type Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { codexRespond } from '../chatgpt/codexClient';
import type { GptInputContent } from '../chatgpt/responses';

/**
 * GPT для распознавания фото — режим анализатора `gpt`.
 *
 * Запросы идут по своей подписке ChatGPT, подключённой в ScanFlow по коду (src/chatgpt/:
 * вход как у `codex login --device-auth`, токены зашифрованы в БД, обновляет их только
 * ScanFlow). Промпт, JSON-схема, проверки и до-чтение — общие с Claude
 * (claudeApiAnalyzer.ts): вызов уходит сюда, если модель распознавания — GPT (isGptModel).
 */

export const DEFAULT_GPT_MODEL = 'gpt-6.1-sol';
const GPT_MODEL_RE = /^gpt-[a-z0-9._-]{1,60}$/i;

/** Модель распознавания — GPT (подписка ChatGPT), а не Claude. */
export function isGptModel(model: string | null | undefined): boolean {
  return typeof model === 'string' && GPT_MODEL_RE.test(model);
}

/** Режимы, в которых фото читает модель по фото (Claude или GPT), а не цепочка OCR. */
export function isVisionLlmMode(mode: string | null | undefined): boolean {
  return mode === 'claude_api' || mode === 'gpt';
}

/**
 * Какая модель читает фото при текущих настройках. В режиме `gpt` — модель GPT без ключа
 * Anthropic; PDF и в этом режиме читает Claude (документ-блок PDF есть только у Claude).
 */
export function visionModelFor(
  cfg: { mode: string; anthropic_api_key: string | null; claude_model: string; gpt_model?: string | null },
  opts: { pdf?: boolean } = {},
): { modelId: string; apiKey: string } {
  if (cfg.mode === 'gpt' && !opts.pdf) {
    return { modelId: isGptModel(cfg.gpt_model) ? cfg.gpt_model as string : DEFAULT_GPT_MODEL, apiKey: '' };
  }
  return { modelId: cfg.claude_model, apiKey: cfg.anthropic_api_key || config.anthropicApiKey };
}

/** Блоки сообщения Claude → содержимое запроса Responses API (текст и base64-картинки). */
export function toGptContent(
  content: Anthropic.MessageParam['content'],
  imageDetail: 'low' | 'high' = 'high',
): GptInputContent[] {
  if (typeof content === 'string') return [{ type: 'input_text', text: content }];
  return content.map((block): GptInputContent => {
    if (block.type === 'text') return { type: 'input_text', text: block.text };
    if (block.type === 'image' && block.source.type === 'base64') {
      return { type: 'input_image', image_url: `data:${block.source.media_type};base64,${block.source.data}`, detail: imageDetail };
    }
    throw new Error(`GPT: блок «${block.type}» не поддерживается — PDF распознаётся через Claude`);
  });
}

/** Один запрос к GPT по своей подписке ChatGPT (src/chatgpt/codexClient.ts). */
export const gptRespond = codexRespond;
