import { describe, it, expect } from 'vitest';
import { priceShiftProblems, UsualPriceLookup } from '../../src/ocr/invoiceValidator';

// Обычные цены ИП Кнутовой (медианы из истории прода, ₽/кг).
const USUAL: Record<string, number> = {
  'Баклажаны': 110, 'Грибы шампиньоны': 220, 'Кабачки': 120, 'Капуста квашенная': 100, 'Капуста китайская': 120,
  'Лук красный': 75, 'Лук репчатый': 50, 'Морковь': 50, 'Огурцы гладкие': 155, 'Перец желтый': 260,
};
const usual: UsualPriceLookup = (name, unit) => (unit === 'кг' ? USUAL[name] ?? null : null);
const row = (name: string, unit: string, price: number) => ({ name, unit, price });

describe('priceShiftProblems', () => {
  it('finds rows whose usual price sits in the neighbouring row (invoice 783 read with a shift)', () => {
    const problems = priceShiftProblems([
      row('Баклажаны', 'кг', 260),
      row('Грибы шампиньоны', 'кг', 95),
      row('Кабачки', 'кг', 220),
      row('Капуста квашенная', 'кг', 130),
      row('Капуста китайская', 'кг', 90),
    ], usual);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('«Грибы шампиньоны» — 95 ₽, обычно ~220 ₽ (такая цена у строки ниже)');
    expect(problems[0]).toContain('«Кабачки» — 220 ₽, обычно ~120 ₽');
  });

  it('a correctly read invoice is clean', () => {
    expect(priceShiftProblems([
      row('Баклажаны', 'кг', 95),
      row('Грибы шампиньоны', 'кг', 220),
      row('Кабачки', 'кг', 130),
      row('Капуста квашенная', 'кг', 90),
    ], usual)).toEqual([]);
  });

  it('one price jump is not a shift', () => {
    // Сезонный скачок одной позиции, даже если соседняя цена похожа на обычную.
    expect(priceShiftProblems([
      row('Лук репчатый', 'кг', 45),
      row('Морковь', 'кг', 120),
      row('Огурцы гладкие', 'кг', 150),
      row('Перец желтый', 'кг', 250),
    ], usual)).toEqual([]);
  });

  it('rows without history or in another unit are skipped', () => {
    expect(priceShiftProblems([
      row('Мука (50кг)', 'шт', 45),
      row('Новый товар', 'кг', 1900),
      row('Грибы шампиньоны', 'шт', 95),
    ], usual)).toEqual([]);
  });
});
