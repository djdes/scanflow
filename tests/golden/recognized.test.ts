import { describe, it, expect } from 'vitest';
import { recognizedFromParsed } from '../../src/golden/recognized';
import type { ParsedInvoiceData } from '../../src/ocr/types';

function parsed(overrides: Partial<ParsedInvoiceData> = {}): ParsedInvoiceData {
  return {
    invoice_number: '611',
    invoice_date: '2026-09-15',
    supplier: 'ООО Ромашка',
    supplier_inn: '7724357632',
    total_sum: 2200,
    vat_sum: 200,
    items: [
      { name: 'Батон нарезной 0,4 кг', quantity: 60, unit: 'шт', price: 20, total: 1200, vat_rate: 10 },
      { name: 'Молоко 1л', quantity: 10, unit: 'шт', price: 100, total: 1000, vat_rate: 10 },
    ],
    ...overrides,
  };
}

describe('recognizedFromParsed', () => {
  it('чистый ответ проходит без изменений; номер/дата/ИНН — как прочитала модель', () => {
    const r = recognizedFromParsed(parsed());
    expect(r).toEqual({
      invoice_number: '611',
      invoice_date: '2026-09-15',
      total_sum: 2200,
      vat_sum: 200,
      supplier_inn: '7724357632',
      items: [
        { quantity: 60, unit: 'шт', price: 20, total: 1200 },
        { quantity: 10, unit: 'шт', price: 100, total: 1000 },
      ],
    });
  });

  it('строки без названия отбрасываются (конвейер их не сохраняет)', () => {
    const r = recognizedFromParsed(parsed({
      items: [
        { name: 'Батон', quantity: 1, unit: 'шт', price: 2200, total: 2200, vat_rate: 10 },
        { name: '', quantity: 5, unit: 'шт', price: 1, total: 5 },
      ],
    }));
    expect(r.items).toHaveLength(1);
  });

  it('строки «без НДС» при итоге «с НДС» масштабируются, как в конвейере', () => {
    // Σ строк 1833.33 = 2200 − НДС 366.67 → строки взяты без НДС, итог с НДС.
    const r = recognizedFromParsed(parsed({
      total_sum: 2200,
      vat_sum: 366.67,
      items: [
        { name: 'Товар А', quantity: 1, unit: 'шт', price: 1000, total: 1000, vat_rate: 20 },
        { name: 'Товар Б', quantity: 1, unit: 'шт', price: 833.33, total: 833.33, vat_rate: 20 },
      ],
    }));
    expect(r.items[0].total).toBeCloseTo(1200, 1);
    expect(r.items[1].total).toBeCloseTo(1000, 1);
    expect(r.total_sum).toBe(2200);
  });

  it('арифметика строки: qty×price≠total → количество = total/price', () => {
    const r = recognizedFromParsed(parsed({
      total_sum: 1932,
      vat_sum: 175.64,
      items: [{ name: 'Батон', quantity: 6, unit: 'шт', price: 32.2, total: 1932, vat_rate: 10 }],
    }));
    expect(r.items[0].quantity).toBe(60);
  });

  it('итога нет — сумма из строк; НДС не напечатан — выводится из ставок строк', () => {
    const r = recognizedFromParsed(parsed({ total_sum: undefined, vat_sum: undefined }));
    expect(r.total_sum).toBe(2200);
    // 1200×10/110 = 109.09, 1000×10/110 = 90.91 → 200.00
    expect(r.vat_sum).toBe(200);
  });

  it('напечатанный НДС неправдоподобен для суммы — берётся выведенный из ставок', () => {
    // 20 при итоге 2200 — эффективная ставка ~0.9%, это не НДС документа.
    const r = recognizedFromParsed(parsed({ vat_sum: 20 }));
    expect(r.vat_sum).toBe(200);
  });

  it('НДС вывести не из чего (нет ставок) — остаётся напечатанный как есть', () => {
    const r = recognizedFromParsed(parsed({
      vat_sum: 5,
      items: [{ name: 'Товар', quantity: 1, unit: 'шт', price: 2200, total: 2200 }],
    }));
    expect(r.vat_sum).toBe(5);
  });

  it('итог есть, а строк нет — как recalculateTotal, сумма = Σ строк (0)', () => {
    const r = recognizedFromParsed(parsed({ items: [] }));
    expect(r.items).toEqual([]);
    expect(r.total_sum).toBe(0);
  });

  it('пустые строки шапки → null', () => {
    const r = recognizedFromParsed(parsed({ invoice_number: '  ', supplier_inn: undefined }));
    expect(r.invoice_number).toBeNull();
    expect(r.supplier_inn).toBeNull();
  });
});
