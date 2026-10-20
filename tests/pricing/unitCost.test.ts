import { describe, expect, it } from 'vitest';
import { calculateUnitCost, costBasis, costNameKey, costReviewToken, detectCostFormula, validCostFormula } from '../../src/pricing/unitCost';

const name = 'Этикетка самоклеящаяся 60x120 (рядов 1 по 2 000шт) Полипропилен белый в рулоне, втулка 40 мм';
const line = { id: 1, invoice_id: 1, original_name: name, quantity: 30, unit: 'шт', price: 1785, total: 53550 };
describe('цена одной расходной единицы', () => {
  it('реальный пример: 30 рулонов по 2000 этикеток, 53550 / 60000 = 0.8925', () => {
    expect(detectCostFormula(name)).toMatchObject({ units_per_pack: 2000, unit_kind: 'label' });
    expect(calculateUnitCost(line)).toMatchObject({ packages: 30, total_units: 60000, total: 53550, unit_price: 0.8925, source: 'name' });
    expect(line.quantity).toBe(30);
    expect(line.price).toBe(1785);
  });
  it('читает неразрывные пробелы и явно указанные ряды', () => {
    expect(detectCostFormula('Этикетка (рядов 2 по 2\u00a0000 шт.) рулон')).toMatchObject({ units_per_pack: 4000 });
    expect(detectCostFormula('Этикетки 2\u202f000шт/рул')).toMatchObject({ units_per_pack: 2000 });
    expect(detectCostFormula('Бумага в упаковке 500 листов')).toMatchObject({ units_per_pack: 500, unit_kind: 'sheet' });
  });
  it.each([
    'Этикетка 60x120 втулка 40 мм', 'Риббон 65 мм x 300 м', 'Этикетка 1000шт или 2000шт',
    'Этикетка 100-200 шт', 'Этикетка 1.5 шт', 'Этикетка 0 шт', 'Этикетка 2x2000шт',
    'Этикетка 2000шт 2 ряда', 'Этикетка рядов 2, 2000шт', 'Этикетка 2 рулона по 2000шт',
  ])('не угадывает размеры/диапазоны/неоднозначную фасовку: %s', value => {
    expect(detectCostFormula(value)).toBe(null);
  });
  it('берёт исходное количество упаковок после пересчёта в килограммы и актуальную сумму строки', () => {
    expect(calculateUnitCost({ ...line, quantity: 90, unit: 'кг', price: 595,
      raw_quantity: 30, raw_unit: 'шт', raw_total: 50000, raw_price: 1785 })).toMatchObject({ total_units: 60000, unit_price: 0.8925 });
    expect(calculateUnitCost({ ...line, quantity: 90, unit: 'кг' })).toBe(null);
  });
  it('ручная формула работает без количества штук в названии', () => {
    expect(calculateUnitCost({ ...line, original_name: 'Терморулон' }, { units_per_pack: 1500, unit_kind: 'label' }, 'manual'))
      .toMatchObject({ total_units: 45000, unit_price: 1.19, source: 'manual' });
  });
  it('считает нулевую стоимость и сохраняет дробную цену без округления до копейки', () => {
    expect(calculateUnitCost({ ...line, total: 0 })?.unit_price).toBe(0);
    expect(calculateUnitCost({ ...line, total: 1 })?.unit_price).toBeCloseTo(1 / 60000, 12);
  });
  it.each([0, -1, NaN, Infinity, 1.5, 1e10, '2000'])('проверяет коэффициент %s', value => {
    expect(validCostFormula({ units_per_pack: value, unit_kind: 'label' })).toBe(false);
  });
  it('проверяет источник, переполнение и единицу результата', () => {
    expect(costBasis({ ...line, quantity: 0 })).toBe(null);
    expect(costBasis({ ...line, total: -5 })).toBe(null);
    expect(calculateUnitCost({ ...line, quantity: 1e12 }, { units_per_pack: 1e9, unit_kind: 'piece' })).toBe(null);
    expect(validCostFormula({ units_per_pack: 2000, unit_kind: '<script>' })).toBe(false);
  });
  it('ключ сохраняет размеры и фасовку, токен меняется при изменении строки или формулы', () => {
    expect(costNameKey(' ЭТИКЕТКА 2\u00a0000шт ')).toBe(costNameKey('этикетка 2 000шт'));
    expect(costNameKey('Этикетка 1000шт')).not.toBe(costNameKey('Этикетка 2000шт'));
    expect(costNameKey('Этикетка 60x120')).not.toBe(costNameKey('Этикетка 58x120'));
    const token = costReviewToken(line, 'inn:1', null);
    for (const changed of [{ ...line, total: 53551 }, { ...line, quantity: 31 }, { ...line, original_name: 'Другая' }])
      expect(costReviewToken(changed, 'inn:1', null)).not.toBe(token);
    expect(costReviewToken(line, 'inn:2', null)).not.toBe(token);
    expect(costReviewToken(line, 'inn:1', { units_per_pack: 2000, unit_kind: 'label' })).not.toBe(token);
  });
});
