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

  it('returns null when the name describes a container (the volume is the vessel size)', () => {
    // Real failure from invoice 1288: "Стакан 350 мл" was being turned into
    // 350 ml pack size × quantity, producing nonsense like "61.25 л of cups".
    expect(detectPackFromName('Стакан 350 мл крафт бумажный')).toBeNull();
    expect(detectPackFromName('Контейнер крышка круглый 350 мл')).toBeNull();
    expect(detectPackFromName('Бутылка 300 мл без пробки прозрачная')).toBeNull();
    expect(detectPackFromName('Ведро 5л пластиковое')).toBeNull();
    expect(detectPackFromName('Упаковка 1кг картонная')).toBeNull();
  });

  it('still extracts pack size for real food items', () => {
    expect(detectPackFromName('Вода питьевая 5л')).toEqual({ pack_size: 5, pack_unit: 'л' });
    expect(detectPackFromName('Молоко 3.2% 950г')).toEqual({ pack_size: 950, pack_unit: 'г' });
    expect(detectPackFromName('Мука Ржаная 50кг')).toEqual({ pack_size: 50, pack_unit: 'кг' });
    expect(detectPackFromName('Опята маринованные 3л')).toEqual({ pack_size: 3, pack_unit: 'л' });
  });

  it('treats packaging hints AFTER the pack size as format, not container', () => {
    // "Сельдь 3 кг (ведро)" — продукт упакован в ведро, qty=шт × 3 кг.
    // Ключ: цифра+единица ИДЁТ ПЕРЕД словом ведро/банка/короб/упаковка.
    expect(detectPackFromName('Сельдь филе "Классическая" в масле 3 кг (ведро)')).toEqual({ pack_size: 3, pack_unit: 'кг' });
    expect(detectPackFromName('Огурцы маринованные 5л (банка)')).toEqual({ pack_size: 5, pack_unit: 'л' });
    expect(detectPackFromName('Конфеты 2кг короб')).toEqual({ pack_size: 2, pack_unit: 'кг' });
    expect(detectPackFromName('Печенье 1.5кг упаковка')).toEqual({ pack_size: 1.5, pack_unit: 'кг' });
  });

  it('still blocks when packaging hint precedes the pack size', () => {
    // Product itself IS the vessel.
    expect(detectPackFromName('Ведро 5л пластиковое')).toBeNull();
    expect(detectPackFromName('Банка стеклянная 1л')).toBeNull();
    expect(detectPackFromName('Короб картонный 40х30х20 5л')).toBeNull();
    expect(detectPackFromName('Упаковка 1кг картонная')).toBeNull();
  });

  it('still blocks strict container words regardless of position', () => {
    // "стакан" / "контейнер" / "крышка" always describe the product itself,
    // even when a measurement appears before them.
    expect(detectPackFromName('Крышка 115мм прозрачная')).toBeNull();
    expect(detectPackFromName('Стакан 350 мл крафт')).toBeNull();
    expect(detectPackFromName('Пакет 30л мусорный')).toBeNull();
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

  it('is idempotent: does not re-transform when unit already matches normalised parent unit', () => {
    // Item is already in kg (after a previous normalisation from g),
    // mapping wants to apply "950г" again — guard should skip.
    const already = { quantity: 22.8, unit: 'кг', price: 127.4, total: 2904.8 };
    expect(applyPackTransform(already, 950, 'г')).toEqual(already);
    // Same for ml → л
    const already2 = { quantity: 25.2, unit: 'л', price: 93, total: 2341 };
    expect(applyPackTransform(already2, 420, 'мл')).toEqual(already2);
  });

  it('normalises mл → л when resulting quantity ≥ 1000', () => {
    const r = applyPackTransform(
      { quantity: 60, unit: 'шт', price: 39, total: 2340 },
      420, // 60 × 420 = 25200 мл
      'мл',
    );
    expect(r.unit).toBe('л');
    expect(r.quantity).toBe(25.2);
    expect(r.total).toBe(2340);
    expect(r.price).toBeCloseTo(2340 / 25.2, 4);
  });

  it('normalises г → кг when resulting quantity ≥ 1000', () => {
    const r = applyPackTransform(
      { quantity: 60, unit: 'шт', price: 57, total: 3420 },
      950, // 60 × 950 = 57000 г
      'г',
    );
    expect(r.unit).toBe('кг');
    expect(r.quantity).toBe(57);
    expect(r.total).toBe(3420);
    expect(r.price).toBeCloseTo(3420 / 57, 4);
  });

  it('does NOT normalise г → кг when resulting quantity < 1000', () => {
    // 1 шт × 500 г = 500 г, still reasonable to keep in grams
    const r = applyPackTransform(
      { quantity: 1, unit: 'шт', price: 100, total: 100 },
      500,
      'г',
    );
    expect(r.unit).toBe('г');
    expect(r.quantity).toBe(500);
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

  describe('Mode B: 1C name carries a size — multiplier from scan', () => {
    it('multiplies qty by "N п" after the size', () => {
      // Scan: "Кофе 2г 100 п Триумф" qty=1 шт, 799.20 р. 1C: "Кофе ... 2г".
      // 1C unit is one 2-gram pack; the invoice "шт" means a box of 100 packs.
      // Expected: qty=100 шт, price = 799.20/100 = 7.992 per pack.
      const r = resolveAndApplyPackTransform(
        { quantity: 1, unit: 'шт', price: 799.2, total: 799.2 },
        'Кофе растворимый субл. 2г 100 п Триумф',
        null, null,
        'Кофе растворимый субл жокей 2г',
      );
      expect(r.item.quantity).toBe(100);
      expect(r.item.unit).toBe('шт');
      expect(r.item.total).toBe(799.2);
      expect(r.item.price).toBeCloseTo(7.992, 4);
      expect(r.packSize).toBe(100);
      expect(r.packUnit).toBe('шт');
    });

    it('recognises variants of the multiplier unit', () => {
      const variants = [
        'Кофе 2г 100п',
        'Кофе 2г 100 пак',
        'Кофе 2г 100пак',
        'Кофе 2г 100 пакетов',
        'Кофе 2г 100 пакетиков',
        'Кофе 2г 100 шт',
        'Кофе 2г 100шт',
        'Кофе 2г 100 штук',
        'Кофе 2г ×100',
        'Кофе 2г *100',
        'Кофе 2г x100',
        'Кофе 2г х100', // Cyrillic х
      ];
      for (const scan of variants) {
        const r = resolveAndApplyPackTransform(
          { quantity: 1, unit: 'шт', price: 799.2, total: 799.2 },
          scan, null, null,
          'Кофе 2г',
        );
        expect(r.item.quantity, scan).toBe(100);
        expect(r.item.unit, scan).toBe('шт');
      }
    });

    it('leaves item unchanged when the 1C size is present but no multiplier in scan', () => {
      // Scan describes a single pack already — invoice unit matches 1C unit.
      const scan = { quantity: 1, unit: 'шт', price: 7.99, total: 7.99 };
      const r = resolveAndApplyPackTransform(
        scan,
        'Кофе 2г одиночный пакет',
        null, null,
        'Кофе 2г',
      );
      expect(r.item).toEqual(scan);
      expect(r.packSize).toBeNull();
      expect(r.packUnit).toBeNull();
    });

    it('leaves item unchanged when the scan has no size anchor at all', () => {
      // Without a size in the scan there's nothing to anchor a multiplier
      // search to — leave qty as-is rather than guess.
      const scan = { quantity: 3, unit: 'шт', price: 50, total: 150 };
      const r = resolveAndApplyPackTransform(
        scan,
        'Кофе в стиках',
        null, null,
        'Кофе 2г',
      );
      expect(r.item).toEqual(scan);
    });

    it('ignores a number BEFORE the size (only looks AFTER)', () => {
      // "Партия 5 коробок Кофе 2г" — the leading "5" is not the multiplier,
      // there's nothing after "2г".
      const scan = { quantity: 1, unit: 'шт', price: 799.2, total: 799.2 };
      const r = resolveAndApplyPackTransform(
        scan,
        'Партия 5 Кофе 2г',
        null, null,
        'Кофе 2г',
      );
      expect(r.item).toEqual(scan);
    });

    it('ignores the multiplier when qty is zero or missing (degenerate input)', () => {
      const zeroQty = { quantity: 0, unit: 'шт', price: 0, total: 0 };
      const r1 = resolveAndApplyPackTransform(zeroQty, 'Кофе 2г 100п', null, null, 'Кофе 2г');
      expect(r1.item).toEqual(zeroQty);

      const noQty = { quantity: null, unit: 'шт', price: null, total: null };
      const r2 = resolveAndApplyPackTransform(noQty, 'Кофе 2г 100п', null, null, 'Кофе 2г');
      expect(r2.item).toEqual(noQty);
    });

    it('overrides any stale mapping pack_size when the 1C name has a size', () => {
      // Even if a leftover pack_size=50 got written onto the mapping at some
      // point, Mode B takes precedence because the source of truth is the 1C
      // name.
      const r = resolveAndApplyPackTransform(
        { quantity: 1, unit: 'шт', price: 799.2, total: 799.2 },
        'Кофе 2г 100 п',
        50, 'кг',
        'Кофе 2г',
      );
      // Expect multiplier behaviour, not 50 кг.
      expect(r.item.quantity).toBe(100);
      expect(r.item.unit).toBe('шт');
    });
  });

  describe('Countable 1C unit guard', () => {
    it('skips transform when 1C accounting unit is шт', () => {
      // Invoice «Геркулес 1кг» arrived as 2 упак. 1C stores «Геркулес» in
      // шт. 1 упак of 1кг = 1 шт in 1C — do NOT multiply to 2 кг.
      const scan = { quantity: 2, unit: 'упак', price: 1012, total: 2024 };
      const r = resolveAndApplyPackTransform(
        scan,
        'Геркулес 1кг',
        1, 'кг',
        'Геркулес',
        'шт', // 1C unit
      );
      expect(r.item).toEqual(scan);
      expect(r.packSize).toBeNull();
      expect(r.packUnit).toBeNull();
    });

    it('skips transform for all countable 1C units', () => {
      const scan = { quantity: 4, unit: 'упак', price: 100, total: 400 };
      for (const u of ['шт', 'ШТ', 'штук', 'упак', 'упаковка', 'уп', 'пач', 'бут', 'бан', 'кор', 'пак', 'рул', 'набор']) {
        const r = resolveAndApplyPackTransform(scan, 'Товар 1кг', 1, 'кг', 'Товар', u);
        expect(r.item, `unit=${u}`).toEqual(scan);
      }
    });

    it('still transforms when 1C unit is kg/l/g/ml', () => {
      // Supplier ships in шт, 1C tracks in кг — classic Mode A use case
      // («Мука 50кг» → 1 шт = 50 кг).
      const r = resolveAndApplyPackTransform(
        { quantity: 1, unit: 'шт', price: 1500, total: 1500 },
        'Мука 50кг',
        50, 'кг',
        'Мука ржаная',
        'кг', // 1C unit — needs conversion
      );
      expect(r.item.quantity).toBe(50);
      expect(r.item.unit).toBe('кг');
    });

    it('back-compat: when 1C unit param is undefined, old behaviour applies', () => {
      // Callers that haven't been updated to pass the 1C unit should continue
      // to work exactly as before.
      const r = resolveAndApplyPackTransform(
        { quantity: 1, unit: 'шт', price: 1500, total: 1500 },
        'Мука 50кг',
        50, 'кг',
        'Мука ржаная',
        // no 6th arg
      );
      expect(r.item.quantity).toBe(50);
    });
  });

  describe('Mode A remains: 1C name has NO size', () => {
    it('still transforms Мука via mapping pack fields', () => {
      const r = resolveAndApplyPackTransform(
        { quantity: 1, unit: 'шт', price: 1500, total: 1500 },
        'Мука 50кг',
        50, 'кг',
        'Мука ржаная',
      );
      expect(r.item.quantity).toBe(50);
      expect(r.item.unit).toBe('кг');
    });

    it('still transforms Грецкий орех 1 кг qty=2 шт → 2 кг', () => {
      const r = resolveAndApplyPackTransform(
        { quantity: 2, unit: 'шт', price: 731.2, total: 1462.4 },
        'Грецкий орех 1 кг.',
        1, 'кг',
        'Грецкий орех',
      );
      expect(r.item.quantity).toBe(2);
      expect(r.item.unit).toBe('кг');
    });

    it('still falls back to scanned-name detection when mapping pack fields are null', () => {
      const r = resolveAndApplyPackTransform(
        { quantity: 7, unit: 'шт', price: 1289.2, total: 9024.4 },
        'Сельдь филе "Классическая" в масле 3 кг (ведро)',
        null, null,
        'Сельдь филе',
      );
      expect(r.item.quantity).toBe(21);
      expect(r.item.unit).toBe('кг');
    });
  });
});
