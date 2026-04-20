import { describe, it, expect } from 'vitest';
import { detectPackFromName, applyPackTransform, resolveAndApplyPackTransform } from '../../src/mapping/packTransform';

describe('detectPackFromName', () => {
  it('extracts integer kg from parentheses', () => {
    expect(detectPackFromName('Мука (50кг)')).toEqual({ pack_size: 50, pack_unit: 'кг' });
  });

  it('extracts integer kg without parentheses', () => {
    expect(detectPackFromName('Мука 50кг')).toEqual({ pack_size: 50, pack_unit: 'кг' });
    expect(detectPackFromName('Сахар 50 кг')).toEqual({ pack_size: 50, pack_unit: 'кг' });
  });

  it('extracts decimal kg with comma', () => {
    expect(detectPackFromName('Крупа (1,5 кг)')).toEqual({ pack_size: 1.5, pack_unit: 'кг' });
    expect(detectPackFromName('Батон 0,4 кг')).toEqual({ pack_size: 0.4, pack_unit: 'кг' });
  });

  it('extracts decimal kg with dot', () => {
    expect(detectPackFromName('Масло (0.5 кг)')).toEqual({ pack_size: 0.5, pack_unit: 'кг' });
  });

  it('is case-insensitive on КГ', () => {
    expect(detectPackFromName('Сахар (10 КГ)')).toEqual({ pack_size: 10, pack_unit: 'кг' });
  });

  it('extracts litres', () => {
    expect(detectPackFromName('Молоко 1л')).toEqual({ pack_size: 1, pack_unit: 'л' });
    expect(detectPackFromName('Вода 1.5л пэт')).toEqual({ pack_size: 1.5, pack_unit: 'л' });
    expect(detectPackFromName('Вода 19л')).toEqual({ pack_size: 19, pack_unit: 'л' });
  });

  it('extracts millilitres', () => {
    expect(detectPackFromName('Вода (500 мл)')).toEqual({ pack_size: 500, pack_unit: 'мл' });
  });

  it('extracts grams and normalises "гр" → "г"', () => {
    expect(detectPackFromName('Специи (100г)')).toEqual({ pack_size: 100, pack_unit: 'г' });
    expect(detectPackFromName('Специи 250гр')).toEqual({ pack_size: 250, pack_unit: 'г' });
  });

  it('returns null for names without pack pattern', () => {
    expect(detectPackFromName('Мука ржаная')).toBeNull();
    expect(detectPackFromName('')).toBeNull();
  });

  it('returns null for zero or negative', () => {
    expect(detectPackFromName('Мука (0кг)')).toBeNull();
  });

  it('does not match numbers fused into Cyrillic words', () => {
    // "25лет" must not be read as "25 л"
    expect(detectPackFromName('Юбилей 25лет')).toBeNull();
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
    expect(r.total).toBe(1500);
    expect(r.price).toBe(30);
  });

  it('recomputes price from total when price is missing', () => {
    const r = applyPackTransform(
      { quantity: 2, unit: 'шт', price: null, total: 3000 },
      25,
      'кг',
    );
    expect(r.quantity).toBe(50);
    expect(r.total).toBe(3000);
    expect(r.price).toBe(60);
  });

  it('falls back to price*qty when total is missing', () => {
    const r = applyPackTransform(
      { quantity: 1, unit: 'шт', price: 1500, total: null },
      50,
      'кг',
    );
    expect(r.quantity).toBe(50);
    expect(r.total).toBe(1500);
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

  it('is idempotent: does not re-transform when unit already matches pack_unit', () => {
    const already = { quantity: 50, unit: 'кг', price: 30, total: 1500 };
    expect(applyPackTransform(already, 50, 'кг')).toEqual(already);
  });

  it('does not mutate the input object', () => {
    const orig = { quantity: 1, unit: 'шт', price: 1500, total: 1500 };
    const frozen = Object.freeze({ ...orig });
    const r = applyPackTransform(frozen, 50, 'кг');
    expect(frozen).toEqual(orig);
    expect(r).not.toBe(frozen);
  });
});

describe('resolveAndApplyPackTransform', () => {
  it('uses mapping pack fields when provided', () => {
    const r = resolveAndApplyPackTransform(
      { quantity: 1, unit: 'шт', price: 1500, total: 1500 },
      'Мука 50кг',
      50,
      'кг',
    );
    expect(r.item.quantity).toBe(50);
    expect(r.item.unit).toBe('кг');
    expect(r.usedFallback).toBe(false);
    expect(r.packSize).toBe(50);
    expect(r.packUnit).toBe('кг');
  });

  it('falls back to the scanned name when mapping has no pack fields', () => {
    const r = resolveAndApplyPackTransform(
      { quantity: 1, unit: 'шт', price: 1500, total: 1500 },
      'Мука 50кг',
      null,
      null,
    );
    expect(r.item.quantity).toBe(50);
    expect(r.item.unit).toBe('кг');
    expect(r.usedFallback).toBe(true);
    expect(r.packSize).toBe(50);
    expect(r.packUnit).toBe('кг');
  });

  it('returns item unchanged when neither mapping nor name has pack info', () => {
    const orig = { quantity: 1, unit: 'шт', price: 1500, total: 1500 };
    const r = resolveAndApplyPackTransform(orig, 'Мука ржаная', null, null);
    expect(r.item).toEqual(orig);
    expect(r.usedFallback).toBe(false);
    expect(r.packSize).toBe(null);
    expect(r.packUnit).toBe(null);
  });

  it('does not double-transform when item already arrived in base unit', () => {
    const already = { quantity: 50, unit: 'кг', price: 38, total: 1900 };
    const r = resolveAndApplyPackTransform(already, 'Мука 50кг', 50, 'кг');
    expect(r.item).toEqual(already);
  });
});
