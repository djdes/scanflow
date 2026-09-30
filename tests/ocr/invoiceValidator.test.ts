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

  // Накладная 783 (30.09.2026, ИП Кнутова): фото снято под углом, числа справа
  // визуально на полстроки ниже названий. Модель оставила строку 1 без чисел,
  // сдвинула названия на строку и «догнала» сдвиг, повторив «Мука (50кг)».
  // Сумма строк при этом совпала с итогом — прежние проверки молчали.
  describe('row_alignment', () => {
    function shifted(): ParsedInvoiceData {
      const row = (row_no: number, name: string, quantity: number | null, unit: string | null, price: number | null, total: number | null) =>
        ({ name, quantity, unit, price, total, vat_rate: null, row_no, pack_size: null });
      return {
        ...baseInvoice(),
        vat_sum: 0,
        total_sum: 25306,
        items: [
          row(1, 'Баклажаны', null, null, null, null),
          row(2, 'Грибы шампиньоны', 5.4, 'кг', 95, 513),
          row(3, 'Кабачки', 3, 'кг', 220, 660),
          row(4, 'Капуста квашенная', 5.6, 'кг', 130, 728),
          row(5, 'Капуста китайская', 10, 'кг', 90, 900),
          row(6, 'Капуста морская(3кг)', 31.8, 'кг', 120, 3816),
          row(7, 'Лук зеленый', 2, 'шт', 600, 1200),
          row(8, 'Лук красный', 1, 'кг', 250, 250),
          row(9, 'Лук репчатый', 6.2, 'кг', 65, 403),
          row(10, 'Морковь', 66.5, 'кг', 42, 2793),
          row(11, 'Мука (50кг)', 57.2, 'кг', 45, 2574),
          row(12, 'Мука (50кг)', 1, 'шт', 1900, 1900),
          row(13, 'Огурцы гладкие', 9.7, 'кг', 120, 1164),
          row(14, 'Перец желтый', 5.9, 'кг', 330, 1947),
          row(15, 'Перец красный болгарский', 4.9, 'кг', 260, 1274),
          row(16, 'Салат Айсберг', 2.8, 'кг', 180, 504),
          row(17, 'Стебель сельдерея(кг)', 5.8, 'кг', 150, 870),
          row(18, 'Томат (помидоры)', 7.1, 'кг', 250, 1775),
          row(18, 'Томат Черри (вес)', 3.7, 'кг', 550, 2035),
        ],
      };
    }

    it('catches the shifted table even though the sum matches the total', () => {
      const issues = validateParsedInvoice(shifted(), NOW);
      expect(issues.map(i => i.code)).toEqual(['row_alignment']);
      const msg = issues[0].message;
      expect(msg).toContain('Баклажаны');      // строка без чисел
      expect(msg).toContain('Мука (50кг)');    // одно название у двух соседних строк
      expect(msg).toContain('18');             // номер строки дважды
      expect(msg).toMatch(/под углом|сетк/);   // как перечитать
    });

    it('the correctly aligned table is clean', () => {
      const d = shifted();
      const names = d.items.map(i => i.name);
      // Правильная привязка: название i ↔ числа i, без повтора муки.
      const fixedNames = ['Баклажаны', 'Грибы шампиньоны', 'Кабачки', 'Капуста квашенная', 'Капуста китайская',
        'Капуста морская(3кг)', 'Лук зеленый', 'Лук красный', 'Лук репчатый', 'Морковь', 'Мука (50кг)',
        'Огурцы гладкие', 'Перец желтый', 'Перец красный болгарский', 'Салат Айсберг', 'Стебель сельдерея(кг)',
        'Томат (помидоры)', 'Томат Черри (вес)'];
      expect(names.length).toBe(19);
      const numbers = d.items.filter(i => i.total != null);
      d.items = numbers.map((it, k) => ({ ...it, name: fixedNames[k], row_no: k + 1 }));
      expect(validateParsedInvoice(d, NOW)).toEqual([]);
    });

    it('the same name on non-adjacent rows or with identical numbers is not a shift', () => {
      const d = baseInvoice();
      d.items = [
        { name: 'Товар А', quantity: 2, unit: 'шт', price: 50, total: 100, vat_rate: 20, row_no: 1, pack_size: null },
        { name: 'Товар Б', quantity: 1, unit: 'шт', price: 50, total: 50, vat_rate: 20, row_no: 2, pack_size: null },
        { name: 'Товар А', quantity: 3, unit: 'шт', price: 50, total: 150, vat_rate: 20, row_no: 3, pack_size: null },
      ];
      expect(codes(d)).not.toContain('row_alignment');
    });

    it('a single row without numbers is reported (the model re-checks it)', () => {
      const d = baseInvoice();
      d.items = [
        ...d.items,
        { name: 'Доставка', quantity: null, unit: null, price: null, total: null, vat_rate: null, row_no: 3, pack_size: null },
      ];
      const issues = validateParsedInvoice(d, NOW).filter(i => i.code === 'row_alignment');
      expect(issues).toHaveLength(1);
      expect(issues[0].message).toContain('Доставка');
    });
  });
});
