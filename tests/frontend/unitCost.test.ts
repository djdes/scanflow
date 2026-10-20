import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
const esc = (s: unknown) => String(s ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ui = runInNewContext(`${readFileSync('public/js/unit-cost.js', 'utf8')}\nUnitCost;`, { App: { esc }, Intl });
const calculation = { packages: 30, units_per_pack: 2000, total_units: 60000, total: 53550, unit_price: 0.8925, unit_kind: 'label' };
describe('расчёт цены в интерфейсе', () => {
  it('показывает дробную цену и полную формулу с правильной единицей', () => {
    expect(ui.price(calculation)).toBe('0,8925 ₽ за 1 этикетку');
    expect(ui.formula(calculation).replace(/[\u00a0\u202f]/g, ' ')).toBe('30 × 2 000 = 60 000 этикеток; 53 550,00 ₽ ÷ 60 000 = 0,8925 ₽');
  });
  it('различает предложение и уже сохранённую формулу', () => {
    const item = { id: 2, unit_cost: { basis: {}, calculation, rule_id: null } };
    expect(ui.rowHtml(7, item)).toContain('Проверить и запомнить формулу');
    expect(ui.rowHtml(7, { ...item, unit_cost: { ...item.unit_cost, rule_id: 1 } })).toContain('Сохранённая формула');
    expect(ui.rowHtml(7, { id: 2 })).toBe('');
  });
  it('предлагает ручной расчёт там, где фасовка неизвестна, и правильно склоняет единицы', () => {
    expect(ui.rowHtml(7, { id: 2, unit_cost: { basis: {}, calculation: null } })).toContain('Рассчитать цену за единицу');
    expect([1, 2, 5].map(n => ui.countUnit('label', n))).toEqual(['этикетка', 'этикетки', 'этикеток']);
  });
});
