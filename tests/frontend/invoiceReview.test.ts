import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { beforeEach, describe, expect, it } from 'vitest';

// Сверка со сканом (спек 2026-10-09): поворот листа, замечания, причина закрытой правки, разбор чисел.
const card = readFileSync('public/js/invoice-card.js', 'utf8');
const review = readFileSync('public/js/invoice-review.js', 'utf8');
const App = {
  formatMoney: (v: number) => Number(v).toFixed(2).replace('.', ','),
  formatDate: (d: string) => d.split('-').reverse().join('.'),
  formatQty: (v: number) => String(v).replace('.', ','),
  isXmlInvoice: () => false,
  esc: (s: string) => s,
};
let R: any;
beforeEach(() => {
  R = runInNewContext(`${card}\n${review}\nInvoiceReview;`, { App, window: {} });
});

describe('поворот листа', () => {
  it('экранная точка и точка листа взаимно обратны при 0/90/180/270°', () => {
    for (const deg of [0, 90, 180, 270]) {
      for (const [x, y] of [[0.1, 0.2], [0.75, 0.4], [0, 1]]) {
        const s = R.sheetToScreen(deg, x, y);
        const back = R.screenToSheet(deg, s.u, s.v);
        expect(back.x).toBeCloseTo(x);
        expect(back.y).toBeCloseTo(y);
      }
    }
  });
  it('по часовой: верх листа уходит вправо (90°) и влево (270°)', () => {
    expect(R.sheetToScreen(90, 0.5, 0)).toEqual({ u: 1, v: 0.5 });
    expect(R.sheetToScreen(270, 0.5, 0)).toEqual({ u: 0, v: 0.5 });
    expect(R.sheetToScreen(180, 0, 0)).toEqual({ u: 1, v: 1 });
  });
});

describe('панель сверки', () => {
  const inv = (over: any = {}) => ({ id: 1, status: 'processed', approved_for_1c: 0, total_sum: 1000, items: [], ...over });
  it('замечания простыми словами', () => {
    const d = { missing_header: ['invoice_number'], mismatch: true, item_sum: 900, quantity: [1, 2], unmapped: [3] };
    const out = R.issues(inv({ supplier_match: 'name', alignment_problems: [{}] }), d);
    expect(out).toEqual([
      'Не заполнено: Номер',
      'Итог документа 1000,00 ₽, а сумма строк 900,00 ₽ — сверьте с бумагой',
      '2 строки — проверьте количество и единицы',
      'Поставщик найден по названию, а не по ИНН — сверьте ИНН',
      'Возможен сдвиг строк — сверьте таблицу со сканом',
    ]);
    expect(R.issues(inv({ status: 'error' }), null)).toEqual(['Ошибка распознавания — проверьте скан или пересканируйте (меню «⋯»)']);
  });
  it('почему правка закрыта — по тем же условиям, что на сервере', () => {
    expect(R.lockReason(inv({ status: 'sent_to_1c' }))).toContain('уже в 1С');
    expect(R.lockReason(inv({ approved_for_1c: 1 }))).toContain('отзовите отправку');
    expect(R.lockReason(inv({ paid_externally: 1 }))).toContain('оплачена вне сервиса');
    expect(R.lockReason(inv({ duplicate_of: 5 }))).toContain('Дубликат');
    R.state = { payment: { status: 'created' } };
    expect(R.lockReason(inv())).toContain('создана платёжка');
    R.state = { payment: { status: 'failed' } };
    expect(R.lockReason(inv({ status: 'waiting_ai' }))).toContain('ещё не распознана');
  });
});

describe('правка значения', () => {
  it('сумма с пробелами и запятой разбирается в число', () => {
    R.invoice = { id: 1, items: [] };
    R.target = 'header:total_sum';
    expect(R.parsedValue('107 528,07')).toBe(107528.07);
    expect(R.parsedValue('')).toBeNull();
    R.target = 'header:invoice_number';
    expect(R.parsedValue('  17-0605773 ')).toBe('17-0605773');
  });
  it('значения для показа: деньги, дата, количество', () => {
    expect(R.fmt('total_sum', 13285.69)).toBe('13285,69 ₽');
    expect(R.fmt('invoice_date', '2026-10-06')).toBe('06.10.2026');
    expect(R.fmt('quantity', 2.5)).toBe('2,5');
    expect(R.fmt('supplier', null)).toBe('—');
  });
});
