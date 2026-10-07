import { codexRespond } from '../chatgpt/codexClient';
import { ChatgptUnavailableError } from '../chatgpt/access';
import { GptStreamError, type GptInputContent } from '../chatgpt/responses';
import { unavailableFromChatgpt } from './engine';
import type { AiInput, AiRequest, AiResponse } from './types';

const DEFAULT_INSTRUCTIONS = 'Ты — ассистент ScanFlow. Отвечай по-русски.';

/** Содержимое запроса → формат Responses API (текст и base64-картинки). */
export function toGptInput(content: AiInput[] | string, imageDetail: 'low' | 'high' = 'high'): GptInputContent[] {
  if (typeof content === 'string') return [{ type: 'input_text', text: content }];
  return content.map((part): GptInputContent => (part.type === 'text'
    ? { type: 'input_text', text: part.text }
    : { type: 'input_image', image_url: `data:${part.mediaType};base64,${part.data}`, detail: imageDetail }));
}

/**
 * Один запрос к GPT по подписке ChatGPT. Недоступность подписки (нет подключения, нужен вход,
 * лимит) — AiUnavailableError: повторять бессмысленно, накладная подождёт.
 */
export async function gptCall(
  req: AiRequest & { schema?: Record<string, unknown>; schemaName?: string },
  signal: AbortSignal,
): Promise<AiResponse> {
  try {
    const response = await codexRespond({
      model: req.target.model,
      instructions: (req.system ?? []).filter(Boolean).join('\n\n') || DEFAULT_INSTRUCTIONS,
      content: toGptInput(req.content, req.imageDetail ?? 'high'),
      ...(req.schema ? { schema: { name: req.schemaName ?? 'result', schema: req.schema } } : {}),
      effort: req.effort ?? 'medium',
      signal,
      label: req.label,
    });
    return { text: response.text.trim(), truncated: false };
  } catch (e) {
    if (e instanceof ChatgptUnavailableError) throw await unavailableFromChatgpt(e.message, 'reauth_required');
    // 429 и лимит из потока: codexClient уже поставил паузу подключения до сброса.
    if ((e as { status?: number }).status === 429 || (e instanceof GptStreamError && e.rateLimited)) {
      throw await unavailableFromChatgpt((e as Error).message, 'rate_limited');
    }
    throw e;
  }
}
