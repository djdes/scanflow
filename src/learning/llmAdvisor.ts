import { createClient } from '../ocr/claudeApiAnalyzer';
import { logger } from '../utils/logger';
import type { FlaggedLine } from './ruleMiner';

/**
 * Подсказки Claude для строк, которые детерминированный разбор не объяснил
 * (пакет v2, п.15): «сколько единиц 1С в одной единице накладной?». Ответ —
 * лишь ПРЕДЛОЖЕНИЕ; правило появится, только если человек его примет.
 * Не больше 30 строк за раз; ошибки не бросаются.
 */
export interface LlmAdvice {
  id: number;
  factor: number;
  confidence: number;
  reason: string;
}

export function buildAdvicePrompt(lines: FlaggedLine[]): string {
  const rows = lines.map(l => [
    `id=${l.id}`,
    `название: ${l.name}`,
    `в накладной: ${l.raw_quantity} ${l.raw_unit}, сумма ${l.raw_total} ₽`,
    `позиция 1С: ${l.onec_name ?? '—'} (учёт в «${l.onec_unit ?? '?'}»)`,
    `обычная цена в 1С: ${l.median ? `${l.median} ₽ за ${l.onec_unit}` : 'нет истории'}`,
  ].join(' | ')).join('\n');
  return `Ты помогаешь складу общепита пересчитывать количество из накладной поставщика в единицу учёта 1С.
Для каждой строки определи КОЭФФИЦИЕНТ: сколько единиц учёта 1С в ОДНОЙ единице из накладной.
Примеры: «Батон 0,4 кг», в накладной шт, в 1С кг → 0.4. «Перчатки 100шт/упак», в накладной упак, в 1С шт → 100.
«Масло 5л 1/2», в накладной упак (коробка из 2 канистр), в 1С кг → 10. «Яйцо С1 360шт», в накладной шт, в 1С шт → 1.
Сверяйся с обычной ценой: после пересчёта цена за единицу 1С должна быть правдоподобной.
Если коэффициент нельзя надёжно определить по названию и цене — factor: null. Лучше null, чем догадка.

Строки:
${rows}

Ответ — JSON: {"answers":[{"id":число,"factor":число_или_null,"confidence":число_от_0_до_1,"reason":"кратко по-русски"}]}`;
}

export function parseAdvice(text: string): LlmAdvice[] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { return []; }
  const answers = (parsed as { answers?: unknown }).answers;
  if (!Array.isArray(answers)) return [];
  const out: LlmAdvice[] = [];
  for (const a of answers as Array<Record<string, unknown>>) {
    const id = Number(a.id);
    const factor = Number(a.factor);
    const confidence = Number(a.confidence);
    if (!Number.isInteger(id) || !Number.isFinite(factor) || factor <= 0 || factor > 100000) continue;
    out.push({ id, factor, confidence: Number.isFinite(confidence) ? confidence : 0, reason: String(a.reason ?? '').slice(0, 300) });
  }
  return out;
}

/** Схема ответа для structured outputs: JSON гарантирован, одна union (factor). */
export const ADVICE_SCHEMA = {
  type: 'object',
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          factor: { type: ['number', 'null'] },
          confidence: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['id', 'factor', 'confidence', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['answers'],
  additionalProperties: false,
} as const;

export async function adviseWithLlm(lines: FlaggedLine[], apiKey: string, model: string): Promise<LlmAdvice[]> {
  if (!lines.length || !apiKey) return [];
  const batch = lines.slice(0, 30);
  try {
    const client = createClient(apiKey);
    // Модель размышляет по умолчанию, и размышления тратят тот же max_tokens:
    // при 2500 весь бюджет уходил на них, и текста ответа не оставалось.
    // Поэтому — adaptive thinking с низким усилием, запас по токенам и
    // structured outputs (ответ — всегда валидный JSON по схеме).
    const resp = await client.messages.create({
      model,
      max_tokens: 12000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low', format: { type: 'json_schema', schema: ADVICE_SCHEMA as unknown as Record<string, unknown> } },
      messages: [{ role: 'user', content: buildAdvicePrompt(batch) }],
    }, { signal: AbortSignal.timeout(180_000) });
    const text = resp.content.map(c => (c.type === 'text' ? c.text : '')).join('');
    if (!text) logger.warn('learning: LLM advice without text', { stop: resp.stop_reason });
    return parseAdvice(text).filter(a => batch.some(l => l.id === a.id));
  } catch (err) {
    logger.warn('learning: LLM advice failed', { error: (err as Error).message });
    return [];
  }
}
