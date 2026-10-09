import { describe, it, expect } from 'vitest';
import { mergeStructuredPageText } from '../../src/ocr/mergeStructuredPages';
import { repairRowPairing } from '../../src/ocr/rowPairing';
import type { ParsedInvoiceData } from '../../src/ocr/types';

const numbers = [
  { quantity: 20, unit: 'шт', price: 67, total: 1340, vat_rate: 10 },
  { quantity: 12, unit: 'шт', price: 180, total: 2160, vat_rate: 22 },
  { quantity: 9.125, unit: 'кг', price: 350, total: 3193.75, vat_rate: 10 },
];
const first: ParsedInvoiceData = {
  invoice_number: 'TEST-ALIGNMENT', invoice_date: '2026-10-01', supplier: 'Тестовый поставщик',
  items: [{ name: 'Товары первого листа', quantity: 1, unit: 'шт', price: 93306.25, total: 93306.25, row_no: 1 }],
};
const last: ParsedInvoiceData = {
  invoice_number: 'TEST-ALIGNMENT', total_sum: 100000, vat_sum: 12000,
  items: ['Молоко 950г', 'Сыр рассольный 330г', 'Карбонад 2,5кг'].map((name, i) => ({
    ...numbers[i], name, row_no: 21 + i, catalog_idx: i + 1, pack_size: null,
  })),
};
const join = (...pages: ParsedInvoiceData[]) => pages.map(p => JSON.stringify(p)).join('\n\n--- СТРАНИЦА ---\n\n');

describe('mergeStructuredPageText', () => {
  it('keeps each complete item from the page, the first header and the last grand total', () => {
    const merged = mergeStructuredPageText(join(first, last), 2)!;
    expect(merged).toMatchObject({ invoice_number: first.invoice_number, invoice_date: first.invoice_date, supplier: first.supplier, total_sum: last.total_sum, vat_sum: last.vat_sum });
    expect(merged.items).toEqual([...first.items, ...last.items]);
    expect(merged.items.slice(-3)).toEqual(last.items);
  });

  it('preserves the repaired numbers of a continuation instead of reading them again', () => {
    const shifted: ParsedInvoiceData = {
      ...last,
      items: last.items.map((it, i) => ({ ...it, ...numbers[[2, 0, 1][i]] })),
    };
    const repaired = repairRowPairing(shifted, numbers, { mainHasIssues: false });
    expect(repaired.changed).toBe(true);
    expect(mergeStructuredPageText(join(first, repaired.data), 2)?.items.slice(-3)).toEqual(last.items);
  });

  it('orders reverse-uploaded pages by printed row numbers, including header and total', () => {
    const head = { ...first, total_sum: 93306.25 };
    expect(mergeStructuredPageText(join(last, head), 2)).toEqual(mergeStructuredPageText(join(head, last), 2));
    expect(mergeStructuredPageText(join(last, head), 2)?.total_sum).toBe(last.total_sum);
  });

  it('keeps identical names as separate lines and preserves packaging/catalog selection', () => {
    const tail = { ...last, items: last.items.map(it => ({ ...it, name: 'Одинаковый товар', pack_size: 12 })) };
    const merged = mergeStructuredPageText(join(first, tail), 2)!;
    expect(merged.items).toHaveLength(4);
    expect(merged.items.slice(-3)).toEqual(tail.items);
  });

  it('does not interleave pages with repeated row numbers or missing numbering', () => {
    for (const items of [last.items.map((it, i) => ({ ...it, row_no: i + 1 })), last.items.map(it => ({ ...it, row_no: undefined }))]) {
      expect(mergeStructuredPageText(join(first, { ...last, items }), 2)?.items).toEqual([...first.items, ...items]);
    }
  });

  it('backfills missing headers and retains a printed zero VAT', () => {
    const merged = mergeStructuredPageText(join({ items: first.items }, { ...last, supplier: 'Поставщик', vat_sum: 0 }), 2)!;
    expect(merged.supplier).toBe('Поставщик');
    expect(merged.invoice_number).toBe(last.invoice_number);
    expect(merged.vat_sum).toBe(0);
  });

  it('leaves raw or mixed OCR text and malformed data to the text analyzer', () => {
    for (const text of ['Текст первой страницы--- СТРАНИЦА ---Текст второй', JSON.stringify(first) + '--- СТРАНИЦА ---обычный OCR', join(first, { items: [null] } as unknown as ParsedInvoiceData)]) {
      expect(mergeStructuredPageText(text, 2)).toBeNull();
    }
    expect(mergeStructuredPageText(join(first, last), 3)).toBeNull();
    expect(mergeStructuredPageText(JSON.stringify(first), 1)).toBeNull();
  });

  it('refuses different invoice numbers but allows their OCR separator variants', () => {
    expect(() => mergeStructuredPageText(join(first, { ...last, invoice_number: 'TEST-OTHER' }), 2)).toThrow('разные номера');
    expect(mergeStructuredPageText(join(first, { ...last, invoice_number: 'TEST/ALIGNMENT' }), 2)?.items).toHaveLength(4);
  });
});
