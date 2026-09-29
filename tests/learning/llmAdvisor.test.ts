import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/ocr/claudeApiAnalyzer', () => ({ createClient: vi.fn() }));

import { buildAdvicePrompt, parseAdvice } from '../../src/learning/llmAdvisor';
import type { FlaggedLine } from '../../src/learning/ruleMiner';

const line = (over: Partial<FlaggedLine> = {}): FlaggedLine => ({
  id: 7, invoice_id: 3, name: 'Батон нарезной 0,4 кг', supplier_key: 'inn:7724357632',
  raw_quantity: 60, raw_unit: 'шт', raw_total: 2400, onec_unit: 'кг', onec_name: 'Батон', flag: 'price_outlier', median: 100,
  ...over,
});

describe('llmAdvisor', () => {
  it('prompt carries every line with raw values, 1C unit and usual price', () => {
    const p = buildAdvicePrompt([line(), line({ id: 8, median: null })]);
    expect(p).toContain('id=7');
    expect(p).toContain('60 шт, сумма 2400 ₽');
    expect(p).toContain('учёт в «кг»');
    expect(p).toContain('100 ₽ за кг');
    expect(p).toContain('id=8');
    expect(p).toContain('нет истории');
  });

  it('parses JSON even when wrapped in prose or markdown fences', () => {
    const out = parseAdvice('Вот ответ:\n```json\n{"answers":[{"id":7,"factor":0.4,"confidence":0.9,"reason":"вес батона в названии"}]}\n```');
    expect(out).toEqual([{ id: 7, factor: 0.4, confidence: 0.9, reason: 'вес батона в названии' }]);
  });

  it('drops null / non-positive / absurd factors and bad ids', () => {
    const out = parseAdvice(JSON.stringify({ answers: [
      { id: 1, factor: null, confidence: 0.9 },
      { id: 2, factor: 0, confidence: 0.9 },
      { id: 3, factor: -2, confidence: 0.9 },
      { id: 4, factor: 1e7, confidence: 0.9 },
      { id: 'x', factor: 2, confidence: 0.9 },
      { id: 5, factor: 10, confidence: 'high' },
    ] }));
    expect(out).toEqual([{ id: 5, factor: 10, confidence: 0, reason: '' }]);
  });

  it('returns [] on garbage', () => {
    expect(parseAdvice('нет данных')).toEqual([]);
    expect(parseAdvice('{"answers": "nope"}')).toEqual([]);
    expect(parseAdvice('{broken')).toEqual([]);
  });
});
