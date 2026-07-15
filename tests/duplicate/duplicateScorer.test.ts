import { describe, expect, it } from 'vitest';
import { scoreDuplicate } from '../../src/duplicate/duplicateScorer';

describe('extended duplicate scoring', () => {
  it('recognises a near OCR number when items and requisites agree', () => {
    const result = scoreDuplicate({
      invoice_number: 'A-1088', invoice_date: '2026-07-15', supplier: 'ООО Ромашка', supplier_inn: '7701000000',
      total_sum: 10000, supplier_account: '40702810000000000001', supplier_bik: '044525225',
      items: [{ name: 'Молоко 3,2%', quantity: 10, total: 10000 }],
    }, {
      invoice_number: 'A-1O88', invoice_date: '2026-07-15', supplier: 'Ромашка', supplier_inn: '7701000000',
      total_sum: 10000, supplier_account: '40702810000000000001', supplier_bik: '044525225',
      items: [{ original_name: 'Молоко 3,2 процента', quantity: 10, total: 10000 }],
    });
    expect(result.score).toBeGreaterThanOrEqual(0.86);
    expect(result.reasons).toContain('Номер отличается на один символ');
    expect(result.item_similarity).toBeGreaterThan(0.6);
  });

  it('does not treat a different amount and item composition as a duplicate', () => {
    const result = scoreDuplicate({
      invoice_number: '55', invoice_date: '2026-07-15', supplier: 'ООО Ромашка', supplier_inn: null,
      total_sum: 1000, items: [{ name: 'Чай', total: 1000 }],
    }, {
      invoice_number: '55', invoice_date: '2026-07-15', supplier: 'ООО Ромашка', supplier_inn: null,
      total_sum: 9000, items: [{ name: 'Кофе', total: 9000 }],
    });
    expect(result.score).toBeLessThan(0.86);
  });
});
