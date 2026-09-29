import { describe, it, expect } from 'vitest';
import { mineFromEdits, mineFromPriceOutliers, type QtyEdit, type FlaggedLine } from '../../src/learning/ruleMiner';

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

  it('одна правка — тоже предложение (человек сам исправил)', () => {
    expect(mineFromEdits([edit({})])).toHaveLength(1);
  });

  it('правка в той же единице (кг → кг) — не про пересчёт', () => {
    expect(mineFromEdits([edit({ raw_unit: 'кг', onec_unit: 'кг', raw_quantity: 10, new_quantity: 9 })])).toHaveLength(0);
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
