import Anthropic from '@anthropic-ai/sdk';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { config } from '../config';
import { logger } from '../utils/logger';
import { AiUnavailableError } from './errors';
import type { AiInput, AiRequest, AiResponse } from './types';

/**
 * Claude по ключу Anthropic — только в режиме claude_api. Аккаунта Claude у ScanFlow сейчас нет;
 * путь оставлен как рычаг возврата (правило 26) и ведёт себя как прежние вызовы распознавания.
 */
export function createClaudeClient(apiKey: string): Anthropic {
  const proxyUrl = config.anthropicProxyUrl;
  // maxRetries: 0 — повторы делает withRetry шлюза, иначе вызовы перемножались бы.
  if (!proxyUrl) return new Anthropic({ apiKey, maxRetries: 0 });
  // SDK на Node игнорирует fetchOptions.dispatcher — свой fetch поверх undici ProxyAgent.
  const dispatcher = new ProxyAgent(proxyUrl);
  const proxiedFetch: typeof globalThis.fetch = (url, init) =>
    undiciFetch(url as never, { ...(init as object), dispatcher } as never) as never;
  return new Anthropic({ apiKey, fetch: proxiedFetch, maxRetries: 0 });
}

export function toClaudeContent(content: AiInput[] | string): Anthropic.MessageParam['content'] {
  if (typeof content === 'string') return content;
  return content.map((part): Anthropic.ContentBlockParam => (part.type === 'text'
    ? { type: 'text', text: part.text }
    : { type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.data } }));
}

export async function claudeCall(
  req: AiRequest & { schema?: Record<string, unknown> },
  signal: AbortSignal,
): Promise<AiResponse> {
  if (!req.target.apiKey) throw new AiUnavailableError('not_connected', null, null, 'claude');
  const client = createClaudeClient(req.target.apiKey);
  const thinking = req.thinking ?? 'adaptive';
  const outputConfig: Record<string, unknown> = {};
  if (req.effort && thinking === 'adaptive') outputConfig.effort = req.effort;
  if (req.schema) outputConfig.format = { type: 'json_schema', schema: req.schema };
  const system = (req.system ?? []).filter(Boolean)
    .map((text): Anthropic.TextBlockParam => ({ type: 'text', text, cache_control: { type: 'ephemeral' } }));
  const params = {
    model: req.target.model,
    max_tokens: req.maxOutputTokens ?? 32000,
    ...(system.length ? { system } : {}),
    ...(thinking === 'default' ? {} : { thinking: { type: thinking } }),
    ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
    messages: [{ role: 'user' as const, content: toClaudeContent(req.content) }],
  } as unknown as Anthropic.MessageStreamParams;
  // Всегда streaming: SDK требует его при больших max_tokens.
  const response = await client.messages.stream(params, { signal }).finalMessage();
  const u = response.usage;
  logger.info(`${req.label}: usage`, {
    input: u.input_tokens,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    output: u.output_tokens,
  });
  if (response.stop_reason === 'max_tokens') {
    logger.warn(`${req.label}: stop_reason=max_tokens — ответ обрезан`, { maxTokens: req.maxOutputTokens ?? 32000 });
  }
  const text = response.content.map(b => (b.type === 'text' ? b.text : '')).join('').trim();
  return { text, truncated: response.stop_reason === 'max_tokens' };
}
