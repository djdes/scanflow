import { logger } from '../utils/logger';
import { AiUnavailableError } from './errors';

/**
 * Повтор вызова модели с паузой 1 с, 2 с … Каждая попытка — со своим таймаутом.
 * Не повторяем: недоступность (лимит, вход, нет подключения — от повтора ничего не изменится)
 * и ошибки запроса 4xx, кроме 429.
 */
export async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  label: string,
  timeoutMs: number,
  retries: number,
): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(AbortSignal.timeout(timeoutMs));
    } catch (e) {
      lastError = e;
      if (e instanceof AiUnavailableError) throw e;
      const status = (e as { status?: number }).status;
      if (status && status >= 400 && status < 500 && status !== 429) throw e;
      if (attempt < retries) {
        const backoffMs = 1000 * Math.pow(2, attempt);
        logger.warn(`${label}: attempt ${attempt + 1} failed, retrying in ${backoffMs}ms`, { error: (e as Error).message, status });
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
  }
  throw lastError ?? new Error(`${label}: unknown failure`);
}
