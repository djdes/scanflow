import { describe, it, expect } from 'vitest';
import { sanitizeItemArithmetic, sanitizeInvoiceVat, sanitizeItemVatPerItem, deriveVatSum } from '../../src/parser/itemSanitizer';

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

describe('sanitizeInvoiceVat', () => {
  it('leaves items alone when their sum matches total_sum', () => {
    const items = [
      { quantity: 1, unit: 'шт', price: 100, total: 100 },
      { quantity: 1, unit: 'шт', price: 200, total: 200 },
    ];
    const r = sanitizeInvoiceVat(items, 300, 30);
    expect(r.report.scaled).toBe(false);
    expect(r.items[0].total).toBe(100);
  });

  it('scales items up when they are pre-VAT but total_sum is post-VAT', () => {
    // Real case from invoice 1286, УПД 261:
    //   items.total = [6713.64, 5909.09, 2945.45] sum=15568.18 (pre-VAT)
    //   total_sum = 17125 (post-VAT), vat_sum = 1556.82
    //   17125 - 1556.82 = 15568.18 ✓ → items are pre-VAT, scale them up
    const items = [
      { quantity: 7, unit: 'шт', price: 959.09, total: 6713.64 },
      { quantity: 4, unit: 'шт', price: 1477.27, total: 5909.09 },
      { quantity: 6, unit: 'шт', price: 490.91, total: 2945.45 },
    ];
    const totalSum = 17125;
    const vatSum = 1556.82;
    const r = sanitizeInvoiceVat(items, totalSum, vatSum);
    expect(r.report.scaled).toBe(true);
    // post-VAT items should now sum to 17125 (within rounding)
    const newSum = r.items.reduce((s, i) => s + (i.total ?? 0), 0);
    expect(newSum).toBeCloseTo(totalSum, 0);
    // prices scaled by same factor
    expect(r.items[0].price).toBeGreaterThan(959.09);
  });

  it('does not scale when already post-VAT (items sum already includes VAT)', () => {
    const items = [
      { quantity: 1, unit: 'шт', price: 110, total: 110 }, // post-VAT
      { quantity: 1, unit: 'шт', price: 220, total: 220 },
    ];
    // total_sum 330 already includes 30 VAT → no scaling needed
    const r = sanitizeInvoiceVat(items, 330, 30);
    expect(r.report.scaled).toBe(false);
    expect(r.items[0].total).toBe(110);
  });

  it('does nothing on empty items', () => {
    const r = sanitizeInvoiceVat([], 1000, 100);
    expect(r.report.scaled).toBe(false);
    expect(r.items).toEqual([]);
  });

  it('does nothing when total_sum is null', () => {
    const items = [{ quantity: 1, unit: 'шт', price: 100, total: 100 }];
    const r = sanitizeInvoiceVat(items, null, null);
    expect(r.report.scaled).toBe(false);
  });
});

describe('sanitizeItemVatPerItem', () => {
  const makeItem = (qty: number, price: number, total: number, vat: number) =>
    ({ quantity: qty, unit: 'кг', price, total, vat_rate: vat });

  it('leaves items alone when sum already matches header', () => {
    const items = [makeItem(10, 100, 1000, 20), makeItem(5, 50, 250, 10)];
    const r = sanitizeItemVatPerItem(items, 1250);
    expect(r.report.inflated).toBe(0);
    expect(r.items).toEqual(items);
  });

  it('inflates a single pre-VAT line to close the header gap', () => {
    // Item 1 is pre-VAT at 20%: 10 × 100 = 1000 but true total with VAT = 1200
    // Item 2 is already post-VAT: 5 × 50 = 250 (total matches)
    // Header = 1450 = 1200 + 250
    const items = [makeItem(10, 100, 1000, 20), makeItem(5, 50, 250, 10)];
    const r = sanitizeItemVatPerItem(items, 1450);
    expect(r.report.inflated).toBe(1);
    expect(r.items[0].total).toBe(1200);
    expect(r.items[0].price).toBeCloseTo(120, 2);
    expect(r.items[1].total).toBe(250);
  });

  it('inflates multiple lines when the subset matches header exactly', () => {
    // Items 1, 3 pre-VAT; item 2 post-VAT.
    // Pre-VAT: 10×100=1000 (true: 1200), 8×50=400 (true: 480)
    // Post-VAT: 5×50=250 (matches header)
    // Correct header = 1200 + 250 + 480 = 1930
    const items = [
      makeItem(10, 100, 1000, 20),
      makeItem(5, 50, 250, 10),
      makeItem(8, 50, 400, 20),
    ];
    const r = sanitizeItemVatPerItem(items, 1930);
    expect(r.report.inflated).toBe(2);
    expect(r.items[0].total).toBe(1200);
    expect(r.items[1].total).toBe(250);
    expect(r.items[2].total).toBe(480);
  });

  it('does nothing when no subset gets within 1% of header', () => {
    // Header is way off what any subset can produce — e.g. OCR misread
    // multiple qty values. We should NOT pretend to fix it.
    const items = [makeItem(10, 100, 1000, 20), makeItem(5, 50, 250, 10)];
    const r = sanitizeItemVatPerItem(items, 5000); // impossible from these lines
    expect(r.report.inflated).toBe(0);
    expect(r.items).toEqual(items);
  });

  it('ignores lines where qty × price ≠ total (arithmetic unclean)', () => {
    // This line has mismatch (q×p=500, total=480 — neither pre nor post-VAT).
    // We don't know which column Claude used, so leave it.
    const items = [{ quantity: 10, unit: 'кг', price: 50, total: 480, vat_rate: 20 }];
    const r = sanitizeItemVatPerItem(items, 600);
    expect(r.report.inflated).toBe(0);
  });

  it('skips items with missing qty/price/total/vat', () => {
    const items = [
      { quantity: null, unit: 'шт', price: 100, total: 100, vat_rate: 20 },
      { quantity: 5, unit: 'шт', price: null, total: 100, vat_rate: 20 },
      { quantity: 5, unit: 'шт', price: 20, total: null, vat_rate: 20 },
      { quantity: 5, unit: 'шт', price: 20, total: 100, vat_rate: null },
      { quantity: 5, unit: 'шт', price: 20, total: 100, vat_rate: 0 },
    ];
    const r = sanitizeItemVatPerItem(items, 500);
    expect(r.report.inflated).toBe(0);
  });

  it('handles header=null gracefully', () => {
    const items = [makeItem(10, 100, 1000, 20)];
    const r = sanitizeItemVatPerItem(items, null);
    expect(r.items).toEqual(items);
    expect(r.report.inflated).toBe(0);
  });

  it('bails when there are more than 20 eligible lines (too expensive)', () => {
    // 21 identical pre-VAT items. 2^21 = 2M iterations — we refuse.
    const items = Array(21).fill(null).map(() => makeItem(10, 100, 1000, 20));
    const r = sanitizeItemVatPerItem(items, 25200); // would be 21 × 1200
    expect(r.report.inflated).toBe(0);
    expect(r.report.reason).toContain('21');
  });

  it('does not apply when improvement is marginal (< 2x)', () => {
    // Single pre-VAT line at 20%. Header = 1150 (between 1000 and 1200).
    // Inflating would give err=50, not inflating gives err=150. Ratio 3x.
    // Should inflate.
    {
      const items = [makeItem(10, 100, 1000, 20)];
      const r = sanitizeItemVatPerItem(items, 1200);
      expect(r.report.inflated).toBe(1);
    }
    // Now header = 1050 — err=100 vs err=50. Ratio 2x but final err is
    // 50/1050 = 4.8% > 1%, so skip.
    {
      const items = [makeItem(10, 100, 1000, 20)];
      const r = sanitizeItemVatPerItem(items, 1050);
      expect(r.report.inflated).toBe(0);
    }
  });
});

describe('deriveVatSum', () => {
  // Items carry VAT-included totals; VAT component = total × rate/(100+rate).
  const item = (total: number | null, vat_rate: number | null) => ({ total, vat_rate });

  it('derives VAT from the real invoice №954 (9 items @22%, total 19296.12 → 3479.63)', () => {
    const items = [
      item(2035.48, 22), item(1254.40, 22), item(5433.12, 22), item(2240.00, 22),
      item(2946.60, 22), item(1189.32, 22), item(882.00, 22), item(817.60, 22),
      item(2497.60, 22),
    ];
    // Per-item rounding then sum reproduces the invoice's printed grand-total
    // НДС "Всего по накладной" = 3 479,62 exactly (not the stale 3029.23 bug).
    expect(deriveVatSum(items)).toBeCloseTo(3479.62, 2);
  });

  it('does NOT return the page-1 partial (first 8 items → 3029.23, not the bug value)', () => {
    const page1 = [
      item(2035.48, 22), item(1254.40, 22), item(5433.12, 22), item(2240.00, 22),
      item(2946.60, 22), item(1189.32, 22), item(882.00, 22), item(817.60, 22),
    ];
    expect(deriveVatSum(page1)).toBeCloseTo(3029.23, 2);
  });

  it('handles mixed 10/20% rates', () => {
    // 1100@10% → 100, 1200@20% → 200
    const items = [item(1100, 10), item(1200, 20)];
    expect(deriveVatSum(items)).toBeCloseTo(300, 2);
  });

  it('treats vat_rate 0 as zero VAT contribution', () => {
    const items = [item(1000, 0), item(1200, 20)];
    expect(deriveVatSum(items)).toBeCloseTo(200, 2);
  });

  it('returns null when any priced item is missing a vat_rate (do not clobber)', () => {
    const items = [item(1100, 10), item(500, null)];
    expect(deriveVatSum(items)).toBeNull();
  });

  it('ignores zero/null-total lines when judging completeness', () => {
    // A null-total descriptive line shouldn't block derivation.
    const items = [item(1100, 10), item(0, null), item(null, null)];
    expect(deriveVatSum(items)).toBeCloseTo(100, 2);
  });

  it('returns null when there are no priced items', () => {
    expect(deriveVatSum([item(0, 20), item(null, 20)])).toBeNull();
    expect(deriveVatSum([])).toBeNull();
  });
});
