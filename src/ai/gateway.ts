import { AiUnavailableError, isNetworkFailure } from './errors';
import { withRetry } from './retry';
import { gptCall } from './gptEngine';
import { claudeCall } from './claudeEngine';
import type { AiRequest, AiResponse, AiStructuredRequest } from './types';

/**
 * ИИ-шлюз: единственная дверь к модели. Движок — из target (resolveAiTarget: режим анализатора),
 * в режиме gpt Claude не вызывается ни при каких условиях. Модель недоступна — AiUnavailableError
 * с причиной; плохой ответ — обычная ошибка.
 */
const DEFAULT_TIMEOUT_MS = 240_000;
const DEFAULT_RETRIES = 2;

/** Ответ по JSON-схеме: у GPT — строгий режим, у Claude — output_config.format. */
export function aiStructured(req: AiStructuredRequest): Promise<AiResponse> {
  return run(req);
}

/** Свободный текст. */
export function aiText(req: AiRequest): Promise<AiResponse> {
  return run(req);
}

async function run(req: AiRequest & { schema?: Record<string, unknown>; schemaName?: string }): Promise<AiResponse> {
  const call = req.target.engine === 'gpt' ? gptCall : claudeCall;
  try {
    return await withRetry(
      signal => call(req, signal),
      req.label,
      req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      req.retries ?? DEFAULT_RETRIES,
    );
  } catch (e) {
    // Связь не появилась и после повторов — это недоступность, а не беда документа.
    if (!(e instanceof AiUnavailableError) && isNetworkFailure(e)) {
      throw new AiUnavailableError('network', null, (e as Error).message, req.target.engine);
    }
    throw e;
  }
}
