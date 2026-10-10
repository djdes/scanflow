import { describe, expect, it } from 'vitest';
import { invoiceCompleteness } from '../../src/ocr/invoiceCompleteness';

const check = (numbers: Array<number | null | undefined>) => invoiceCompleteness({
  ocr_engine: 'gpt_api', file_name: 'invoice.jpg', items: numbers.map(row_no => ({ row_no })),
});

describe('whole invoice photo completeness', () => {
  it('detects a second page alone, without relying on totals or header fields', () => {
    expect(check(Array.from({ length: 10 }, (_, i) => i + 21))).toMatchObject({
      checked: true, first_row: 21, last_row: 30, missing_ranges: [{ from: 1, to: 20 }],
      message: expect.stringContaining('1–20'),
    });
  });

  it('detects missing pages in the middle and a single skipped row', () => {
    const result = check([1, 2, 5, 6, 8]);
    expect(result.missing_ranges).toEqual([{ from: 3, to: 4 }, { from: 7, to: 7 }]);
    expect(result.message).toContain('3–4, 7');
  });

  it('clears the warning after pages arrive in reverse order', () => {
    expect(check([4, 5]).message).not.toBeNull();
    expect(check([4, 5, 1, 2, 3])).toMatchObject({ checked: true, message: null, missing_ranges: [] });
  });

  it('does not treat duplicate numbers as missing pages (alignment checks handle duplicates)', () => {
    expect(check([1, 2, 2, 3]).message).toBeNull();
    expect(check([1, 1, 3]).missing_ranges).toEqual([{ from: 2, to: 2 }]);
  });

  it.each([[], [null, null], [21, null], [1, undefined, 3], [0, 2], [-1, 2], [1, 2.5], [NaN]])(
    'does not invent missing pages when row numbers are unavailable or invalid: %j', (...numbers) => {
      expect(check(numbers as Array<number | null | undefined>)).toMatchObject({ checked: false, message: null });
    },
  );

  it('excludes complete electronic documents with their own numbering', () => {
    for (const source of [{ ocr_engine: 'xml_upd', file_name: 'invoice.jpg' }, { ocr_engine: null, file_name: 'invoice.XML' }]) {
      expect(invoiceCompleteness({ ...source, items: [{ row_no: 21 }] })).toMatchObject({ checked: false, message: null });
    }
  });

  it('«все страницы на месте»: предупреждения нет, разрывы остаются в ответе', () => {
    const confirmed = invoiceCompleteness({ ocr_engine: 'gpt_api', file_name: 'a.jpg', pages_confirmed: 1, items: [1, 2, 5].map(row_no => ({ row_no })) });
    expect(confirmed).toMatchObject({ checked: true, message: null, confirmed: true, missing_ranges: [{ from: 3, to: 4 }] });
    expect(invoiceCompleteness({ pages_confirmed: 0, items: [1, 2, 5].map(row_no => ({ row_no })) }).message).toContain('3–4');
  });

  it('bounds the message without enumerating huge missing ranges', () => {
    expect(check([2147483647]).missing_ranges).toEqual([{ from: 1, to: 2147483646 }]);
    expect(check(Array.from({ length: 100 }, (_, i) => i * 2 + 2)).message!.length).toBeLessThan(350);
  });
});
