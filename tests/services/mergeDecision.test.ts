import { describe, it, expect } from 'vitest';
import { mergeBlockedByNumber, mergeLostData } from '../../src/services/mergeDecision';

describe('mergeBlockedByNumber', () => {
  it('блокирует, когда у обеих есть номер и они различаются (инцидент 287/288)', () => {
    expect(mergeBlockedByNumber({ invoice_number: '287' }, { invoice_number: '288' })).toBe(true);
  });

  it('не блокирует при совпадающих номерах (многостраничная, номер на каждом листе)', () => {
    expect(mergeBlockedByNumber({ invoice_number: '424' }, { invoice_number: '424' })).toBe(false);
  });

  it('нормализует перед сравнением (№, пробелы, регистр, разделители)', () => {
    expect(mergeBlockedByNumber({ invoice_number: '№ 287 ' }, { invoice_number: '287' })).toBe(false);
    expect(mergeBlockedByNumber({ invoice_number: '17-0428317' }, { invoice_number: '170428317' })).toBe(false);
  });

  it('не блокирует, если у одной стороны номера нет (продолжение без номера)', () => {
    expect(mergeBlockedByNumber({ invoice_number: '123' }, { invoice_number: null })).toBe(false);
    expect(mergeBlockedByNumber({ invoice_number: '' }, { invoice_number: '123' })).toBe(false);
    expect(mergeBlockedByNumber({ invoice_number: undefined }, { invoice_number: undefined })).toBe(false);
  });
});

describe('mergeLostData', () => {
  it('потеря: unified содержит меньше позиций, чем суммарно на страницах', () => {
    // страница A (5 позиций) + страница B (3) склеены, unified вернул только 5
    const pages = [{ itemCount: 5, totalSum: 1000 }, { itemCount: 3, totalSum: 500 }];
    expect(mergeLostData(pages, { itemCount: 5, totalSum: 1000 })).toBe(true);
  });

  it('потеря: unified сумма меньше максимальной суммы страницы', () => {
    // две разные накладные: 288 (9000) проглочена, unified = 287 (8900)
    const pages = [{ itemCount: 1, totalSum: 9000 }, { itemCount: 2, totalSum: 8900 }];
    expect(mergeLostData(pages, { itemCount: 2, totalSum: 8900 })).toBe(true);
  });

  it('нет потери: корректная многостраничная — все позиции на месте (1-5 + 6-8 = 8)', () => {
    const pages = [{ itemCount: 5, totalSum: null }, { itemCount: 3, totalSum: null }];
    expect(mergeLostData(pages, { itemCount: 8, totalSum: 12000 })).toBe(false);
  });

  it('нет потери: grand-total на последней странице ≥ суммы отдельных страниц', () => {
    // многостраничная: страница 1 показывает промежуточный итог, страница 2 — grand total
    const pages = [{ itemCount: 5, totalSum: 5000 }, { itemCount: 3, totalSum: 12000 }];
    expect(mergeLostData(pages, { itemCount: 8, totalSum: 12000 })).toBe(false);
  });

  it('допуск на копейку в сумме (округление НДС/цены)', () => {
    const pages = [{ itemCount: 1, totalSum: 100.00 }];
    expect(mergeLostData(pages, { itemCount: 1, totalSum: 99.995 })).toBe(false);
  });
});
