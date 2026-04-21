import { describe, it, expect } from 'vitest';
import { sanitizeItemArithmetic } from '../../src/parser/itemSanitizer';

describe('sanitizeItemArithmetic', () => {
  it('leaves correct arithmetic alone', () => {
    const r = sanitizeItemArithmetic({ quantity: 7, unit: 'шт', price: 959.09, total: 6713.63 });
    expect(r.corrected).toBe(false);
    expect(r.item.quantity).toBe(7);
  });

  it('tolerates small floating-point drift', () => {
    // 7 × 959.09 = 6713.63, total off by 0.01 — well within tolerance
    const r = sanitizeItemArithmetic({ quantity: 7, unit: 'шт', price: 959.09, total: 6713.64 });
    expect(r.corrected).toBe(false);
  });

  it('fixes qty when Claude misread thousand-separator (7000 → 7)', () => {
    const r = sanitizeItemArithmetic({ quantity: 7000, unit: 'шт', price: 959.09, total: 6713.64 });
    expect(r.corrected).toBe(true);
    expect(r.item.quantity).toBeCloseTo(7, 3);
  });

  it('fixes when qty was off by order of magnitude in the other direction', () => {
    // claimed 0.7 шт × 959 = 671.3 but total actually 6713
    const r = sanitizeItemArithmetic({ quantity: 0.7, unit: 'шт', price: 959.09, total: 6713.64 });
    expect(r.corrected).toBe(true);
    expect(r.item.quantity).toBeCloseTo(7, 3);
  });

  it('preserves unit when fixing qty', () => {
    const r = sanitizeItemArithmetic({ quantity: 7000, unit: 'шт', price: 959.09, total: 6713.64 });
    expect(r.item.unit).toBe('шт');
  });

  it('does nothing when price is missing', () => {
    const input = { quantity: 7000, unit: 'шт', price: null, total: 6713.64 };
    const r = sanitizeItemArithmetic(input);
    expect(r.corrected).toBe(false);
    expect(r.item).toEqual(input);
  });

  it('does nothing when total is missing', () => {
    const input = { quantity: 7000, unit: 'шт', price: 959.09, total: null };
    const r = sanitizeItemArithmetic(input);
    expect(r.corrected).toBe(false);
  });

  it('does nothing when qty is missing', () => {
    const input = { quantity: null, unit: 'шт', price: 959.09, total: 6713.64 };
    const r = sanitizeItemArithmetic(input);
    expect(r.corrected).toBe(false);
  });

  it('does nothing when any value is zero', () => {
    expect(sanitizeItemArithmetic({ quantity: 0, unit: 'шт', price: 959.09, total: 6713.64 }).corrected).toBe(false);
    expect(sanitizeItemArithmetic({ quantity: 7, unit: 'шт', price: 0, total: 6713.64 }).corrected).toBe(false);
    expect(sanitizeItemArithmetic({ quantity: 7, unit: 'шт', price: 959.09, total: 0 }).corrected).toBe(false);
  });

  it('does not mutate input', () => {
    const input = { quantity: 7000, unit: 'шт', price: 959.09, total: 6713.64 };
    const frozen = Object.freeze({ ...input });
    const r = sanitizeItemArithmetic(frozen);
    expect(r.item).not.toBe(frozen);
    expect(frozen.quantity).toBe(7000); // original untouched
  });

  it('fixes realistic "пицца" case: 166 × 34.353 = 5702, but total 15458.85', () => {
    // real case from invoice 1253 page 2. price and total are correct,
    // qty is the one picked up from wrong column.
    const r = sanitizeItemArithmetic({ quantity: 166, unit: 'кг', price: 34.353, total: 15458.85 });
    expect(r.corrected).toBe(true);
    // new qty should be 15458.85 / 34.353 ≈ 450
    expect(r.item.quantity).toBeCloseTo(450, 0);
  });
});
