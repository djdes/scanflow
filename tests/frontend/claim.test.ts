import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { runInNewContext } from 'vm';

// «Претензия поставщику» (public/js/claim.js): позиции дороже обычного и расхождение итога.
const script = readFileSync('public/js/claim.js', 'utf8');
let C: any;
beforeAll(() => { C = runInNewContext(`${script}\nClaim;`, { App: {}, Intl }); });

const inv = (over: Record<string, unknown> = {}) => ({
  id: 5, invoice_number: 'ЗР-311', invoice_date: '2026-10-27', supplier: 'ООО «Зелёный ряд»', supplier_inn: '7708123451',
  total_sum: 4600, items_total_mismatch: 0,
  items: [
    { original_name: 'Огурцы', unit: 'кг', quantity: 20, price: 180, total: 3600, median_price: 150, price_deviation_pct: 20 },
    { original_name: 'Томаты', unit: 'кг', quantity: 5, price: 200, total: 1000, median_price: 195, price_deviation_pct: 2.5 },
  ],
  ...over,
});

describe('Claim', () => {
  it('считает переплату только по позициям дороже обычного больше чем на 10%', () => {
    const rows = C.overpriced(inv());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Огурцы', over: 600, pct: 20 });
    const { text, claimSum } = C.build(inv(), new Date('2026-11-17T10:00:00Z'));
    expect(claimSum).toBe(600);
    expect(text).toContain('Претензия по накладной № ЗР-311 от 27.10.2026');
    expect(text).toContain('ИНН 7708123451');
    expect(text).toMatch(/Итого переплата: 600,00 ₽/);
    expect(text).not.toContain('Томаты');
  });
  it('пишет расхождение итога и без завышенных цен', () => {
    const data = inv({ items_total_mismatch: 1, total_sum: 4800, items: [{ original_name: 'Огурцы', quantity: 20, price: 180, total: 3600 }] });
    expect(C.available(data)).toBe(true);
    const { text, rows } = C.build(data);
    expect(rows).toHaveLength(0);
    expect(text).toMatch(/расхождение 1\s200,00 ₽/);
    expect(text).toContain('итог больше суммы строк');
  });
  it('нечего предъявить — пункта в меню нет', () => {
    expect(C.available(inv({ items: [{ original_name: 'Хлеб', quantity: 1, price: 50, total: 50 }] }))).toBe(false);
  });
});
