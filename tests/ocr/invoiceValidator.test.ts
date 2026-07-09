import { describe, it, expect } from 'vitest';
import { validateParsedInvoice } from '../../src/ocr/invoiceValidator';
import { ParsedInvoiceData } from '../../src/ocr/types';

// A minimal, self-consistent invoice used as the "clean" baseline. Each test
// clones it and breaks exactly one thing so we can assert on a single issue code.
function baseInvoice(): ParsedInvoiceData {
  return {
    invoice_number: '261',
    invoice_date: '2026-06-01',
    invoice_type: 'торг_12',
    supplier: 'ООО "Ромашка"',
    supplier_inn: '7707083893', // valid 10-digit checksum
    supplier_kpp: '773601001',
    total_sum: 300,
    vat_sum: 50,
    items: [
      // qty*price = total exactly; vat 20% included → 100*20/120 = 16.67
      { name: 'Товар А', quantity: 2, unit: 'шт', price: 50, total: 100, vat_rate: 20, row_no: 1, pack_size: null },
      { name: 'Товар Б', quantity: 4, unit: 'шт', price: 50, total: 200, vat_rate: 20, row_no: 2, pack_size: null },
    ],
  };
}

// Fixed clock so date_range is deterministic regardless of when tests run.
const NOW = new Date('2026-07-09T00:00:00Z');

function codes(data: ParsedInvoiceData): string[] {
  return validateParsedInvoice(data, NOW).map(i => i.code);
}

describe('validateParsedInvoice', () => {
  it('returns no issues for a clean, self-consistent invoice', () => {
    expect(validateParsedInvoice(baseInvoice(), NOW)).toEqual([]);
  });

  describe('row_math', () => {
    it('flags a row where quantity × price ≠ total (>1%)', () => {
      const d = baseInvoice();
      d.items[0].total = 100; d.items[0].quantity = 2; d.items[0].price = 50;
      d.items[1].total = 1240; d.items[1].quantity = 4; d.items[1].price = 50; // expected 200
      // fix totals so the total_mismatch check doesn't also fire
      d.total_sum = 100 + 1240;
      const issues = validateParsedInvoice(d, NOW).filter(i => i.code === 'row_math');
      expect(issues).toHaveLength(1);
      expect(issues[0].rowNo).toBe(2);
    });

    it('tolerates rounding within ±1%', () => {
      const d = baseInvoice();
      d.items[0].total = 100.5; // 0.5% off from 100
      d.total_sum = 300.5;
      expect(codes(d)).not.toContain('row_math');
    });

    it('skips rows with null price/qty/total', () => {
      const d = baseInvoice();
      d.items[0].price = undefined;
      expect(codes(d)).not.toContain('row_math');
    });
  });

  describe('qty_digits', () => {
    it('flags quantity with more than 4 digits (SKU misread as qty)', () => {
      const d = baseInvoice();
      d.items[0].quantity = 113393;
      d.items[0].total = 113393 * 50; // keep row_math happy
      d.total_sum = d.items[0].total + 200;
      const issues = validateParsedInvoice(d, NOW).filter(i => i.code === 'qty_digits');
      expect(issues).toHaveLength(1);
      expect(issues[0].rowNo).toBe(1);
    });

    it('allows a 4-digit quantity', () => {
      const d = baseInvoice();
      d.items[0].quantity = 9999;
      d.items[0].price = 1; d.items[0].total = 9999;
      d.total_sum = 9999 + 200;
      expect(codes(d)).not.toContain('qty_digits');
    });
  });

  describe('total_mismatch', () => {
    it('flags when Σ items.total diverges from total_sum by >1₽', () => {
      const d = baseInvoice();
      d.total_sum = 500; // items sum to 300
      expect(codes(d)).toContain('total_mismatch');
    });

    it('is skipped when total_sum is null (intermediate page)', () => {
      const d = baseInvoice();
      d.total_sum = undefined;
      expect(codes(d)).not.toContain('total_mismatch');
    });

    it('is skipped on a continuation page (no invoice_number) even if total_sum > Σ items', () => {
      // Last page of a multipage invoice: no header number, only 1 item, but the
      // grand "Всего по накладной" total is present and legitimately exceeds it.
      const d = baseInvoice();
      d.invoice_number = undefined;
      d.total_sum = 19296.12;
      d.vat_sum = 3479.62;
      d.items = [{ name: 'Полотенца', quantity: 1, unit: 'меш', price: 2497.6, total: 2497.6, vat_rate: 22, row_no: 9 }];
      const c = codes(d);
      expect(c).not.toContain('total_mismatch');
      expect(c).not.toContain('vat_mismatch');
    });

    it('is skipped on a last page that repeats the doc number but starts at row_no > 1', () => {
      // Some multipage invoices repeat "Товарная накладная №..." on every page,
      // so invoice_number is present even on the final continuation page. row_no
      // of the first item on the page (>1) is what marks it as a continuation.
      const d = baseInvoice();
      d.invoice_number = '17-0348232'; // present on this page too
      d.total_sum = 54217.6;
      d.vat_sum = 6776.41;
      d.items = [{ name: 'Яйцо', quantity: 720, unit: 'шт', price: 4.8, total: 3456, vat_rate: 10, row_no: 21 }];
      const c = codes(d);
      expect(c).not.toContain('total_mismatch');
      expect(c).not.toContain('vat_mismatch');
    });

    it('still flags row_math on a continuation page (per-item checks run)', () => {
      const d = baseInvoice();
      d.invoice_number = undefined;
      d.items = [{ name: 'X', quantity: 4, unit: 'шт', price: 50, total: 9999, vat_rate: 22, row_no: 9 }];
      expect(codes(d)).toContain('row_math');
    });
  });

  describe('vat_mismatch', () => {
    it('flags when vat_sum is far from Σ(total × rate/(100+rate))', () => {
      const d = baseInvoice();
      d.vat_sum = 5; // real included VAT ≈ 50
      expect(codes(d)).toContain('vat_mismatch');
    });

    it('accepts a correct included VAT', () => {
      const d = baseInvoice();
      d.vat_sum = 50; // 300 * 20/120 = 50
      expect(codes(d)).not.toContain('vat_mismatch');
    });

    it('is skipped when vat_sum is null', () => {
      const d = baseInvoice();
      d.vat_sum = undefined;
      expect(codes(d)).not.toContain('vat_mismatch');
    });
  });

  describe('inn_checksum', () => {
    it('accepts a valid 10-digit INN', () => {
      const d = baseInvoice();
      d.supplier_inn = '7707083893';
      expect(codes(d)).not.toContain('inn_checksum');
    });

    it('accepts a valid 12-digit INN', () => {
      const d = baseInvoice();
      d.supplier_inn = '500100732259';
      d.supplier_kpp = undefined; // 12-digit = ИП, no KPP
      expect(codes(d)).not.toContain('inn_checksum');
    });

    it('flags a broken 10-digit checksum', () => {
      const d = baseInvoice();
      d.supplier_inn = '7707083894';
      expect(codes(d)).toContain('inn_checksum');
    });

    it('flags a broken 12-digit checksum', () => {
      const d = baseInvoice();
      d.supplier_inn = '500100732258';
      d.supplier_kpp = undefined;
      expect(codes(d)).toContain('inn_checksum');
    });

    it('flags a wrong-length INN', () => {
      const d = baseInvoice();
      d.supplier_inn = '12345';
      expect(codes(d)).toContain('inn_checksum');
    });

    it('is skipped when INN is null', () => {
      const d = baseInvoice();
      d.supplier_inn = undefined;
      expect(codes(d)).not.toContain('inn_checksum');
    });
  });

  describe('kpp_format', () => {
    it('accepts a 9-digit KPP', () => {
      const d = baseInvoice();
      d.supplier_kpp = '773601001';
      expect(codes(d)).not.toContain('kpp_format');
    });

    it('flags a non-9-digit KPP', () => {
      const d = baseInvoice();
      d.supplier_kpp = '7736';
      expect(codes(d)).toContain('kpp_format');
    });

    it('is skipped when KPP is null', () => {
      const d = baseInvoice();
      d.supplier_kpp = undefined;
      expect(codes(d)).not.toContain('kpp_format');
    });
  });

  describe('date_range', () => {
    it('accepts a date within [today-2y, today+7d]', () => {
      const d = baseInvoice();
      d.invoice_date = '2026-07-01';
      expect(codes(d)).not.toContain('date_range');
    });

    it('flags a date more than 2 years in the past', () => {
      const d = baseInvoice();
      d.invoice_date = '2023-01-01';
      expect(codes(d)).toContain('date_range');
    });

    it('flags a date more than 7 days in the future', () => {
      const d = baseInvoice();
      d.invoice_date = '2026-08-01';
      expect(codes(d)).toContain('date_range');
    });

    it('flags an unparseable date', () => {
      const d = baseInvoice();
      d.invoice_date = 'не дата';
      expect(codes(d)).toContain('date_range');
    });

    it('is skipped when date is null', () => {
      const d = baseInvoice();
      d.invoice_date = undefined;
      expect(codes(d)).not.toContain('date_range');
    });
  });

  it('reports multiple independent issues at once', () => {
    const d = baseInvoice();
    d.supplier_kpp = '7736';       // kpp_format
    d.supplier_inn = '7707083894'; // inn_checksum
    d.total_sum = 999;             // total_mismatch
    const set = new Set(codes(d));
    expect(set).toContain('kpp_format');
    expect(set).toContain('inn_checksum');
    expect(set).toContain('total_mismatch');
  });
});
