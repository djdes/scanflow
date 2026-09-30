import { describe, it, expect } from 'vitest';
import { repairRowPairing, NumberRow } from '../../src/ocr/rowPairing';
import { ParsedInvoiceData, ParsedInvoiceItem } from '../../src/ocr/types';

// Накладная 783 (ИП Кнутова, 30.09.2026): правильная таблица.
const TRUTH: Array<[string, number, string, number, number]> = [
  ['Баклажаны', 5.4, 'кг', 95, 513], ['Грибы шампиньоны', 3, 'кг', 220, 660], ['Кабачки', 5.6, 'кг', 130, 728],
  ['Капуста квашенная', 10, 'кг', 90, 900], ['Капуста китайская', 31.8, 'кг', 120, 3816],
  ['Капуста морская(3кг)', 2, 'шт', 600, 1200], ['Лук зеленый', 1, 'кг', 250, 250], ['Лук красный', 6.2, 'кг', 65, 403],
  ['Лук репчатый', 66.5, 'кг', 42, 2793], ['Морковь', 57.2, 'кг', 45, 2574], ['Мука (50кг)', 1, 'шт', 1900, 1900],
  ['Огурцы гладкие', 9.7, 'кг', 120, 1164], ['Перец желтый', 5.9, 'кг', 330, 1947],
  ['Перец красный болгарский', 4.9, 'кг', 260, 1274], ['Салат Айсберг', 2.8, 'кг', 180, 504],
  ['Стебель сельдерея(кг)', 5.8, 'кг', 150, 870], ['Томат (помидоры)', 7.1, 'кг', 250, 1775],
  ['Томат Черри (вес)', 3.7, 'кг', 550, 2035],
];
const NAMES = TRUTH.map(t => t[0]);
const NUMBERS = TRUTH.map(([, quantity, unit, price, total]) => ({ quantity, unit, price, total }));

// Отдельное чтение чисел — как оно пришло на фото 783: пустая первая строка
// (строка сетки без чисел на её уровне), затем 18 строк в порядке на бумаге.
const NUMBER_ROWS: NumberRow[] = [{ quantity: null, unit: null, price: null, total: null }, ...NUMBERS];

const item = (row_no: number, name: string, n: Partial<ParsedInvoiceItem> | null): ParsedInvoiceItem =>
  ({ name, quantity: n?.quantity, unit: n?.unit, price: n?.price, total: n?.total, vat_rate: undefined, row_no, pack_size: null });
const invoice = (items: ParsedInvoiceItem[]): ParsedInvoiceData =>
  ({ invoice_number: '1351', invoice_date: '2026-09-30', supplier: 'ИП Кнутова А. С.', total_sum: 25306, items });
const pairs = (d: ParsedInvoiceData) => d.items.map(it => `${it.name}=${it.total}`);
const TRUE_PAIRS = TRUTH.map(t => `${t[0]}=${t[4]}`);

describe('repairRowPairing', () => {
  it('fixes the production reading: first row empty, flour repeated to catch up', () => {
    // Прод: названия 2–11 сдвинуты на строку, «Мука (50кг)» дважды, строк 19.
    const shifted = [null, ...NUMBERS.slice(0, 10)];
    const items = [
      ...NAMES.slice(0, 11).map((n, i) => item(i + 1, n, shifted[i])),
      item(12, 'Мука (50кг)', NUMBERS[10]),
      ...NAMES.slice(11).map((n, i) => item(13 + i, n, NUMBERS[11 + i])),
    ];
    expect(items).toHaveLength(19);
    const out = repairRowPairing(invoice(items), NUMBER_ROWS, { mainHasIssues: true });
    expect(out.changed).toBe(true);
    expect(pairs(out.data)).toEqual(TRUE_PAIRS);
    expect(out.data.items.map(i => i.row_no)).toEqual(TRUTH.map((_, i) => i + 1));
    expect(out.data.items[10]).toMatchObject({ name: 'Мука (50кг)', quantity: 1, unit: 'шт', price: 1900 });
    expect(out.reason).toContain('убран повтор названия: 19→18');
  });

  it('fixes a clean-looking reading where the leftover numbers were moved into the empty first row', () => {
    // Прогоны с новым промптом: числа перца (строка 14) перенесены в «Баклажаны»,
    // строки 2–14 сдвинуты. Все строки с числами, дублей нет, сумма сходится.
    const order = [13, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17];
    const items = NAMES.map((n, i) => item(i + 1, n, NUMBERS[order[i]]));
    const out = repairRowPairing(invoice(items), NUMBER_ROWS, { mainHasIssues: false });
    expect(out.changed).toBe(true);
    expect(pairs(out.data)).toEqual(TRUE_PAIRS);
    expect(out.changes[0]).toBe('Баклажаны: 4.9 кг = 1274 → 5.4 кг = 513');
  });

  it('keeps a correct reading as is', () => {
    const items = NAMES.map((n, i) => item(i + 1, n, NUMBERS[i]));
    const out = repairRowPairing(invoice(items), NUMBER_ROWS, { mainHasIssues: false });
    expect(out).toMatchObject({ changed: false, reason: 'пары совпадают' });
    expect(out.data.items).toBe(items);
  });

  it('does not trust a separate reading whose sums do not add up to the total (other column)', () => {
    const order = [13, ...Array.from({ length: 13 }, (_, i) => i), 14, 15, 16, 17];
    const items = NAMES.map((n, i) => item(i + 1, n, NUMBERS[order[i]]));
    const withoutVat = NUMBERS.map(r => ({ ...r, price: +(r.price / 1.2).toFixed(2), total: +(r.total / 1.2).toFixed(2) }));
    const out = repairRowPairing(invoice(items), withoutVat, { mainHasIssues: false });
    expect(out).toMatchObject({ changed: false, reason: 'сумма строк отдельного чтения не сходится с итогом' });
  });

  it('a clean reading is not replaced by different numbers, only reordered', () => {
    const items = NAMES.map((n, i) => item(i + 1, n, NUMBERS[i]));
    const rows = NUMBERS.map(r => ({ ...r }));
    // Отдельное чтение ошиблось в цифре (а сумма и итог те же).
    rows[0] = { ...rows[0], quantity: 5.9, price: 86.95 };
    const out = repairRowPairing(invoice(items), rows, { mainHasIssues: false });
    expect(out.changed).toBe(false);
  });

  it('gives up when names and number rows cannot be matched one to one', () => {
    const items = [...NAMES, 'Доставка'].map((n, i) => item(i + 1, n, i < 18 ? NUMBERS[i] : null));
    const out = repairRowPairing(invoice(items), NUMBER_ROWS, { mainHasIssues: true });
    expect(out).toMatchObject({ changed: false, reason: 'названий 19, строк чисел 18' });
  });

  it('without a separate reading nothing changes', () => {
    const items = NAMES.map((n, i) => item(i + 1, n, NUMBERS[i]));
    expect(repairRowPairing(invoice(items), null, { mainHasIssues: true }).changed).toBe(false);
  });
});
