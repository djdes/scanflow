import { describe, it, expect } from 'vitest';
import {
  buildSupplierKeyResolver,
  cleanStreak,
  daysBetween,
  dropPriceOutliers,
  effectiveDate,
  innOf,
  isoWeekKey,
  medianDaysToSend,
  parseDbDateTime,
  parsePeriod,
  pctChange,
  periodChangePct,
  pickCheapest,
  savingVsCheapest,
  share,
  supplierIdentity,
  toneHigherBetter,
  toneLowerBetter,
  worstTone,
} from '../../src/services/analyticsMath';

// Аналитика (п.7, п.11): чистые помощники — без БД.

describe('parsePeriod', () => {
  it('пусто → 90 по умолчанию; разрешены 30/90/180/365', () => {
    expect(parsePeriod(undefined)).toBe(90);
    expect(parsePeriod('')).toBe(90);
    expect(parsePeriod('30')).toBe(30);
    expect(parsePeriod(180)).toBe(180);
    expect(parsePeriod('365')).toBe(365);
  });
  it('прочее — null (роут отвечает 400)', () => {
    expect(parsePeriod('7')).toBeNull();
    expect(parsePeriod('abc')).toBeNull();
    expect(parsePeriod(['30', '90'])).toBeNull();
    expect(parsePeriod({ days: 30 })).toBeNull();
  });
});

describe('share / pctChange', () => {
  it('доля — null, когда делить не на что', () => {
    expect(share(1, 4)).toBe(0.25);
    expect(share(0, 0)).toBeNull();
  });
  it('процент изменения — только от положительной базы', () => {
    expect(pctChange(100, 110)).toBeCloseTo(10);
    expect(pctChange(200, 150)).toBeCloseTo(-25);
    expect(pctChange(0, 10)).toBeNull();
    expect(pctChange(null, 10)).toBeNull();
    expect(pctChange(10, undefined)).toBeNull();
  });
});

describe('даты', () => {
  it('parseDbDateTime понимает DATETIME и DATE, отвергает несуществующие даты', () => {
    expect(parseDbDateTime('2026-09-28 10:30:00')).toBe(Date.UTC(2026, 8, 28, 10, 30, 0));
    expect(parseDbDateTime('2026-09-28')).toBe(Date.UTC(2026, 8, 28));
    expect(parseDbDateTime('2026-02-31')).toBeNull();
    expect(parseDbDateTime('28.09.2026')).toBeNull();
    expect(parseDbDateTime(null)).toBeNull();
  });

  it('daysBetween — дробные дни, обратный порядок = null', () => {
    expect(daysBetween('2026-09-01 00:00:00', '2026-09-02 12:00:00')).toBeCloseTo(1.5);
    expect(daysBetween('2026-09-02 00:00:00', '2026-09-01 00:00:00')).toBeNull();
    expect(daysBetween('2026-09-01 00:00:00', null)).toBeNull();
  });

  it('effectiveDate: дата документа, если правдоподобна, иначе дата загрузки', () => {
    const up = '2026-09-25 14:00:00';
    expect(effectiveDate('2026-09-20', up)).toBe('2026-09-20');
    // OCR ошибся годом — точка не должна улететь на год назад
    expect(effectiveDate('2025-09-20', up)).toBe('2026-09-25');
    // дата из будущего дальше недели — тоже мимо
    expect(effectiveDate('2026-10-20', up)).toBe('2026-09-25');
    expect(effectiveDate('20.09.2026', up)).toBe('2026-09-25');
    expect(effectiveDate(null, up)).toBe('2026-09-25');
    // старая накладная, загруженная через пару месяцев, — дата документа честная
    expect(effectiveDate('2026-07-10', up)).toBe('2026-07-10');
    expect(effectiveDate(null, null)).toBeNull();
  });

  it('isoWeekKey — ISO-неделя, год по четвергу', () => {
    expect(isoWeekKey(new Date(Date.UTC(2026, 8, 28, 9, 30)))).toBe('2026-W40'); // понедельник
    expect(isoWeekKey(new Date(Date.UTC(2026, 9, 4, 23, 0)))).toBe('2026-W40');  // воскресенье той же недели
    expect(isoWeekKey(new Date(Date.UTC(2026, 9, 5)))).toBe('2026-W41');
    expect(isoWeekKey(new Date(Date.UTC(2027, 0, 1)))).toBe('2026-W53');
    expect(isoWeekKey(new Date(Date.UTC(2026, 0, 1)))).toBe('2026-W01');
  });
});

describe('серии и медианы', () => {
  it('cleanStreak — считает с самых свежих до первой «грязной»', () => {
    const isClean = (x: boolean) => x;
    expect(cleanStreak([true, true, false, true], isClean)).toBe(2);
    expect(cleanStreak([false, true], isClean)).toBe(0);
    expect(cleanStreak([], isClean)).toBe(0);
    expect(cleanStreak([true, true, true], isClean)).toBe(3);
  });

  it('medianDaysToSend — медиана по отправленным (общая medianOf)', () => {
    expect(medianDaysToSend([
      { created_at: '2026-09-01 00:00:00', sent_at: '2026-09-02 00:00:00' },
      { created_at: '2026-09-01 00:00:00', sent_at: '2026-09-04 00:00:00' },
      { created_at: '2026-09-01 00:00:00', sent_at: '2026-09-03 00:00:00' },
      { created_at: '2026-09-01 00:00:00', sent_at: null },
    ])).toBeCloseTo(2);
    expect(medianDaysToSend([{ created_at: '2026-09-01 00:00:00', sent_at: null }])).toBeNull();
  });

  it('periodChangePct — медиана первых k против последних k', () => {
    expect(periodChangePct([100])).toBeNull();
    expect(periodChangePct([100, 110])).toBeCloseTo(10);
    expect(periodChangePct([100, 100, 100, 120, 120, 120])).toBeCloseTo(20);
    // одна случайная дорогая закупка в начале не решает
    expect(periodChangePct([100, 200, 100, 110, 115, 120, 125])).toBeCloseTo(20);
  });

  it('dropPriceOutliers — в 5 раз от медианы отсекается', () => {
    const { kept, dropped } = dropPriceOutliers([200, 210, 0.21, 205, 5000], x => x);
    expect(kept).toEqual([200, 210, 205]);
    expect(dropped).toBe(2);
    expect(dropPriceOutliers([], x => x)).toEqual({ kept: [], dropped: 0 });
  });
});

describe('поставщики', () => {
  it('ИНН — только 10 или 12 цифр', () => {
    expect(innOf('7707083893')).toBe('7707083893');
    expect(innOf(' 7707 083893 ')).toBe('7707083893');
    expect(innOf('770708389312')).toBe('770708389312');
    expect(innOf('77070838')).toBeNull();
    expect(innOf(null)).toBeNull();
  });

  it('ключ: ИНН, а без него — название без ОПФ', () => {
    expect(supplierIdentity('7707083893', 'ООО «Ромашка»').key).toBe('inn:7707083893');
    expect(supplierIdentity(null, 'ООО "Ромашка"').key).toBe('name:ромашка');
    expect(supplierIdentity('', 'Ромашка ООО').key).toBe('name:ромашка');
    expect(supplierIdentity(null, null).key).toBe('name:');
  });

  it('накладная без ИНН присоединяется к поставщику с тем же названием и ИНН', () => {
    const rows = [
      { supplier_inn: '7707083893', supplier: 'ООО «Ромашка»' },
      { supplier_inn: null, supplier: 'Ромашка' },
      { supplier_inn: '5012345678', supplier: 'ИП Лютик' },
      { supplier_inn: '5098765432', supplier: 'Лютик ИП' },
      { supplier_inn: null, supplier: 'Лютик' },
    ];
    const keyOf = buildSupplierKeyResolver(rows);
    expect(keyOf(rows[1])).toBe('inn:7707083893');
    // два разных ИНН с одним названием — не угадываем
    expect(keyOf(rows[4])).toBe('name:лютик');
    expect(keyOf({ supplier_inn: null, supplier: null })).toBe('name:');
  });
});

describe('«у кого дешевле»', () => {
  it('pickCheapest — нужно минимум два поставщика с ценой', () => {
    expect(pickCheapest([{ key: 'a', recent_median: 100 }])).toBeNull();
    expect(pickCheapest([{ key: 'a', recent_median: 100 }, { key: 'b', recent_median: null }])).toBeNull();
    expect(pickCheapest([
      { key: 'a', recent_median: 120 },
      { key: 'b', recent_median: 95 },
      { key: 'c', recent_median: 101 },
    ])?.key).toBe('b');
  });

  it('savingVsCheapest — переплата у других поставщиков при их объёме', () => {
    const s = savingVsCheapest([
      { supplier_key: 'a', price: 100, qty: 5 },
      { supplier_key: 'b', price: 120, qty: 10 },
      { supplier_key: 'c', price: 110, qty: 2 },
      { supplier_key: 'c', price: 105, qty: null },
    ], { key: 'a', recent_median: 100 });
    expect(s).not.toBeNull();
    expect(s!.rub).toBeCloseTo(220);
    expect(s!.volume).toBeCloseTo(12);
    expect(s!.pct).toBeCloseTo((220 / 1420) * 100);
  });

  it('уже покупают у самого дешёвого — экономии нет', () => {
    expect(savingVsCheapest([{ supplier_key: 'a', price: 100, qty: 5 }], { key: 'a', recent_median: 100 })).toBeNull();
    expect(savingVsCheapest([{ supplier_key: 'b', price: 90, qty: 5 }], { key: 'a', recent_median: 100 })).toBeNull();
  });
});

describe('цветовые подсказки', () => {
  it('меньше — лучше / больше — лучше / худшая', () => {
    expect(toneLowerBetter(0.01, 0.02, 0.1)).toBe('good');
    expect(toneLowerBetter(0.05, 0.02, 0.1)).toBe('warn');
    expect(toneLowerBetter(0.2, 0.02, 0.1)).toBe('bad');
    expect(toneLowerBetter(null, 0.02, 0.1)).toBeNull();
    expect(toneHigherBetter(0.95, 0.9, 0.6)).toBe('good');
    expect(toneHigherBetter(0.7, 0.9, 0.6)).toBe('warn');
    expect(toneHigherBetter(0.1, 0.9, 0.6)).toBe('bad');
    expect(worstTone(['good', null, 'warn'])).toBe('warn');
    expect(worstTone(['good', 'bad', 'warn'])).toBe('bad');
    expect(worstTone([null, undefined])).toBeNull();
  });
});
