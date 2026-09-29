import { describe, it, expect } from 'vitest';
import { mineFromEdits, mineFromPriceOutliers, isPlainFactor, type QtyEdit, type FlaggedLine } from '../../src/learning/ruleMiner';

const edit = (over: Partial<QtyEdit>): QtyEdit => ({
  name: 'Батон "Нарезной" в/с 0,4 кг', supplier_key: 'inn:7722316694', raw_quantity: 60, raw_unit: 'шт',
  new_quantity: 24, onec_unit: 'кг', invoice_id: 1, item_id: 1, ...over,
});

describe('mineFromEdits — ручные правки количества → правило пересчёта', () => {
  it('устойчивый коэффициент по нескольким правкам', () => {
    const p = mineFromEdits([edit({}), edit({ raw_quantity: 30, new_quantity: 12, invoice_id: 2, item_id: 2 })]);
    expect(p).toHaveLength(1);
    expect(p[0].payload).toMatchObject({ raw_unit: 'шт', target_unit: 'кг', factor: 0.4 });
    expect(p[0].title).toMatch(/0,4/);
    expect(p[0].evidence.count).toBe(2);
  });

  it('разнобой коэффициентов — не правило', () => {
    expect(mineFromEdits([edit({}), edit({ raw_quantity: 30, new_quantity: 20, item_id: 2 })])).toHaveLength(0);
  });

  it('одна правка — ещё не закономерность (для неё есть «запомнить» в строке)', () => {
    expect(mineFromEdits([edit({})])).toHaveLength(0);
  });

  it('две правки в ОДНОЙ накладной — не повторение; у строки считается последняя правка', () => {
    expect(mineFromEdits([edit({}), edit({ item_id: 2 })])).toHaveLength(0);
    // Строка 1 сначала исправлена неверно (25), потом верно (24): берётся 24.
    const p = mineFromEdits([
      edit({ new_quantity: 25 }), edit({ new_quantity: 24 }),
      edit({ raw_quantity: 30, new_quantity: 12, invoice_id: 2, item_id: 2 }),
    ]);
    expect(p).toHaveLength(1);
    expect(p[0].payload.factor).toBe(0.4);
    expect(p[0].evidence.count).toBe(2);
  });

  it('правка в той же единице (кг → кг) — не про пересчёт', () => {
    expect(mineFromEdits([
      edit({ raw_unit: 'кг', onec_unit: 'кг', raw_quantity: 10, new_quantity: 9 }),
      edit({ raw_unit: 'кг', onec_unit: 'кг', raw_quantity: 10, new_quantity: 9, invoice_id: 2, item_id: 2 }),
    ])).toHaveLength(0);
  });
});

describe('mineFromPriceOutliers — выброс цены → вероятный вес упаковки', () => {
  const line = (over: Partial<FlaggedLine>): FlaggedLine => ({
    id: 1, invoice_id: 1, name: 'Масло фритюрное 5л 1/2', supplier_key: 'inn:7724357632',
    raw_quantity: 3, raw_unit: 'упак', raw_total: 4722, onec_unit: 'кг', onec_name: 'Масло фритюрное',
    flag: 'price_outlier', median: 160, ...over,
  });

  it('коэффициент, возвращающий цену к обычной, совпал с упаковкой из названия (2×5 л)', () => {
    const p = mineFromPriceOutliers([line({})]);
    expect(p).toHaveLength(1);
    expect(p[0].payload.factor).toBe(10);
    expect(p[0].title).toMatch(/1 упак = 10 кг/);
  });

  it('ничего «круглого» в названии — не предлагаем (пусть решает ИИ/человек)', () => {
    expect(mineFromPriceOutliers([line({ name: 'Масло фритюрное', median: 37 })])).toHaveLength(0);
  });

  it('без медианы — нечем проверить', () => {
    expect(mineFromPriceOutliers([line({ median: null })])).toHaveLength(0);
  });
});

describe('isPlainFactor — «круглый» коэффициент упаковки', () => {
  it('целые и до трёх знаков после запятой — да; подгонка под цену — нет', () => {
    for (const f of [1, 5, 50, 0.4, 2.5, 0.125, 11.52]) expect(isPlainFactor(f)).toBe(true);
    for (const f of [1.8333, 0.33333, 0, -2, NaN, Infinity]) expect(isPlainFactor(f)).toBe(false);
  });
});
