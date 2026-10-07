import { config } from '../config';
import { invoiceRepo } from '../database/repositories/invoiceRepo';
import { chatgptConnectionRepo } from '../database/repositories/chatgptConnectionRepo';
import { DEFAULT_GPT_MODEL, isGptModel } from '../ocr/gptVision';
import { AiUnavailableError, aiUnavailableText, type AiUnavailableReason } from './errors';
import type { AiEngine, AiTarget } from './types';

/**
 * Выбор движка — единственное место, где решается «GPT или Claude». Claude — только в режиме
 * claude_api (аккаунта Claude нет, режим оставлен как рычаг возврата). Любой другой режим,
 * включая скрытые hybrid и dispatcher, для вызовов модели использует GPT по подписке.
 */
export function aiTargetFromConfig(cfg: {
  mode: string;
  anthropic_api_key: string | null;
  claude_model: string;
  gpt_model?: string | null;
}): AiTarget {
  if (cfg.mode === 'claude_api') {
    return { engine: 'claude', model: cfg.claude_model, apiKey: cfg.anthropic_api_key || config.anthropicApiKey || null };
  }
  return { engine: 'gpt', model: isGptModel(cfg.gpt_model) ? (cfg.gpt_model as string) : DEFAULT_GPT_MODEL, apiKey: null };
}

export async function resolveAiTarget(): Promise<AiTarget> {
  return aiTargetFromConfig(await invoiceRepo.getAnalyzerConfig());
}

/** Состояние подключения ChatGPT: null — пользоваться можно (связь проверяется самим запросом). */
async function chatgptUnavailability(): Promise<{ reason: AiUnavailableReason; retryAtMs: number | null } | null> {
  const c = await chatgptConnectionRepo.get();
  if (!c) return { reason: 'not_connected', retryAtMs: null };
  if (c.status === 'reauth_required') return { reason: 'reauth_required', retryAtMs: null };
  if (c.rateLimitedUntilMs && c.rateLimitedUntilMs > Date.now()) return { reason: 'rate_limited', retryAtMs: c.rateLimitedUntilMs };
  return null;
}

/** Ошибку подписки ChatGPT — в AiUnavailableError с причиной по строке подключения. */
export async function unavailableFromChatgpt(detail: string, fallback: AiUnavailableReason): Promise<AiUnavailableError> {
  const state = await chatgptUnavailability().catch(() => null);
  return new AiUnavailableError(state?.reason ?? fallback, state?.retryAtMs ?? null, detail);
}

export interface AiEngineState {
  engine: AiEngine;
  model: string;
  /** Можно пробовать: подключено, повторный вход не нужен, лимит не исчерпан. */
  available: boolean;
  reason: AiUnavailableReason | null;
  retryAtMs: number | null;
  /** Для людей: «gpt-6.1-sol: подключено» или причина недоступности. */
  text: string;
}

export async function aiEngineState(target?: AiTarget): Promise<AiEngineState> {
  const t = target ?? await resolveAiTarget();
  if (t.engine === 'claude') {
    const available = !!t.apiKey;
    return {
      engine: 'claude', model: t.model, available, reason: available ? null : 'not_connected', retryAtMs: null,
      text: available ? `${t.model}: ключ Anthropic задан` : aiUnavailableText('not_connected', null, 'claude'),
    };
  }
  const state = await chatgptUnavailability();
  if (!state) return { engine: 'gpt', model: t.model, available: true, reason: null, retryAtMs: null, text: `${t.model}: подключено` };
  return {
    engine: 'gpt', model: t.model, available: false, reason: state.reason, retryAtMs: state.retryAtMs,
    text: aiUnavailableText(state.reason, state.retryAtMs),
  };
}
