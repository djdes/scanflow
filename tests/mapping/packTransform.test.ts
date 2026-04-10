import { describe, it, expect } from 'vitest';
import { detectPackFromName, applyPackTransform } from '../../src/mapping/packTransform';

describe('detectPackFromName', () => {
  it('extracts integer kg from "(50кг)"', () => {
    expect(detectPackFromName('Мука (50кг)')).toEqual({ pack_size: 50, pack_unit: 'кг' });
  });

  it('extracts decimal kg with comma', () => {
    expect(detectPackFromName('Крупа (1,5 кг)')).toEqual({ pack_size: 1.5, pack_unit: 'кг' });
  });

  it('extracts decimal kg with dot', () => {
    expect(detectPackFromName('Масло (0.5 кг)')).toEqual({ pack_size: 0.5, pack_unit: 'кг' });
  });

  it('handles spaces around the number and unit', () => {
    expect(detectPackFromName('Соль (  25  кг  )')).toEqual({ pack_size: 25, pack_unit: 'кг' });
  });

  it('is case-insensitive on КГ', () => {
    expect(detectPackFromName('Сахар (10 КГ)')).toEqual({ pack_size: 10, pack_unit: 'кг' });
  });

  it('returns null for names without kg pattern', () => {
    expect(detectPackFromName('Мука ржаная')).toBeNull();
    expect(detectPackFromName('')).toBeNull();
    expect(detectPackFromName('Батон 0.4 кг')).toBeNull(); // unit NOT inside parens
  });

  it('intentionally ignores litres / millilitres / grams', () => {
    // User explicitly scoped the feature to kg only.
    expect(detectPackFromName('Молоко (1л)')).toBeNull();
    expect(detectPackFromName('Вода (500 мл)')).toBeNull();
    expect(detectPackFromName('Специи (100г)')).toBeNull();
  });

  it('returns null for zero or negative', () => {
    expect(detectPackFromName('Мука (0кг)')).toBeNull();
  });

  it('picks the first match when multiple parens', () => {
    // Defensive: real invoices tend to have only one "(Nкг)" per item, but
    // the regex falls back to the first match if there are several.
    const r = detectPackFromName('Мука (50кг) пачка (2кг)');
    expect(r).toEqual({ pack_size: 50, pack_unit: 'кг' });
  });
});

describe('applyPackTransform', () => {
  it('multiplies quantity by pack_size and swaps unit', () => {
    const r = applyPackTransform(
      { quantity: 1, unit: 'шт', price: 1500, total: 1500 },
      50,
      'кг',
    );
    expect(r.quantity).toBe(50);
    expect(r.unit).toBe('кг');
    expect(r.total).toBe(1500); // unchanged
    expect(r.price).toBe(30); // 1500 / 50
  });

  it('recomputes price from total when price is missing', () => {
    const r = applyPackTransform(
      { quantity: 2, unit: 'шт', price: null, total: 3000 },
      25,
      'кг',
    );
    expect(r.quantity).toBe(50); // 2 * 25
    expect(r.total).toBe(3000);
    expect(r.price).toBe(60); // 3000 / 50
  });

  it('falls back to price*qty when total is missing', () => {
    const r = applyPackTransform(
      { quantity: 1, unit: 'шт', price: 1500, total: null },
      50,
      'кг',
    );
    expect(r.quantity).toBe(50);
    expect(r.total).toBe(1500); // derived from 1500*1
    expect(r.price).toBe(30);
  });

  it('handles decimal pack sizes', () => {
    const r = applyPackTransform(
      { quantity: 4, unit: 'шт', price: 100, total: 400 },
      1.5,
      'кг',
    );
    expect(r.quantity).toBe(6);
    expect(r.unit).toBe('кг');
    expect(r.total).toBe(400);
    expect(r.price).toBeCloseTo(400 / 6, 6);
  });

  it('returns the item unchanged when pack_size is null', () => {
    const orig = { quantity: 1, unit: 'шт', price: 1500, total: 1500 };
    expect(applyPackTransform(orig, null, 'кг')).toEqual(orig);
  });

  it('returns the item unchanged when pack_unit is null', () => {
    const orig = { quantity: 1, unit: 'шт', price: 1500, total: 1500 };
    expect(applyPackTransform(orig, 50, null)).toEqual(orig);
  });

  it('returns the item unchanged when pack_size is zero or negative', () => {
    const orig = { quantity: 1, unit: 'шт', price: 1500, total: 1500 };
    expect(applyPackTransform(orig, 0, 'кг')).toEqual(orig);
    expect(applyPackTransform(orig, -5, 'кг')).toEqual(orig);
  });

  it('returns the item unchanged when quantity is missing or zero', () => {
    const noQty = { quantity: null, unit: 'шт', price: 1500, total: 1500 };
    expect(applyPackTransform(noQty, 50, 'кг')).toEqual(noQty);
    const zeroQty = { quantity: 0, unit: 'шт', price: 1500, total: 1500 };
    expect(applyPackTransform(zeroQty, 50, 'кг')).toEqual(zeroQty);
  });

  it('does not mutate the input object', () => {
    const orig = { quantity: 1, unit: 'шт', price: 1500, total: 1500 };
    const frozen = Object.freeze({ ...orig });
    const r = applyPackTransform(frozen, 50, 'кг');
    expect(frozen).toEqual(orig);
    expect(r).not.toBe(frozen);
  });
});
