import { describe, it, expect } from 'vitest';
import {
  compareGolden,
  truthFromInvoice,
  truthLine,
  normalizeDate,
  normalizeUnit,
  toNumber,
  type GoldenDoc,
} from '../../src/golden/compare';

function doc(overrides: Partial<GoldenDoc> = {}): GoldenDoc {
  return {
    invoice_number: 'ВМ-611',
    invoice_date: '2026-09-15',
    total_sum: 3864,
    vat_sum: 351.27,
    supplier_inn: '7724357632',
    items: [
      { quantity: 60, unit: 'шт', price: 32.2, total: 1932 },
      { quantity: 2.5, unit: 'кг', price: 772.8, total: 1932 },
    ],
    ...overrides,
  };
}

describe('compareGolden — шапка', () => {
  it('полное совпадение: всё ok, точность 5/5 и 100% строк', () => {
    const r = compareGolden(doc(), doc());
    expect(r.summary.all_ok).toBe(true);
    expect(r.summary.header_ok).toBe(5);
    expect(r.summary.header_total).toBe(5);
    expect(r.summary.items_ok).toBe(2);
    expect(r.summary.items_total).toBe(2);
    expect(r.summary.items_ok_ratio).toBe(1);
    expect(r.summary.failed).toEqual([]);
    expect(r.summary.line_failures).toEqual({});
  });

  it('номер сравнивается после нормализации: кириллица/латиница, регистр, «№», разделители', () => {
    const r = compareGolden(doc({ invoice_number: 'ВМ-611' }), doc({ invoice_number: '№ bm 611' }));
    const num = r.header.find(h => h.field === 'invoice_number')!;
    expect(num.ok).toBe(true);
    // В отчёт уходят исходные значения, а не нормализованные.
    expect(num.expected).toBe('ВМ-611');
    expect(num.actual).toBe('№ bm 611');
  });

  it('другой номер — ошибка номера', () => {
    const r = compareGolden(doc({ invoice_number: '611' }), doc({ invoice_number: '6111' }));
    expect(r.header.find(h => h.field === 'invoice_number')!.ok).toBe(false);
    expect(r.summary.failed).toEqual(['invoice_number']);
    expect(r.summary.all_ok).toBe(false);
    expect(r.summary.header_ok).toBe(4);
  });

  it('дата — точно; ДД.ММ.ГГГГ приравнивается к ГГГГ-ММ-ДД, соседний день — ошибка', () => {
    expect(compareGolden(doc({ invoice_date: '2026-09-15' }), doc({ invoice_date: '15.09.2026' }))
      .header.find(h => h.field === 'invoice_date')!.ok).toBe(true);
    expect(compareGolden(doc({ invoice_date: '2026-09-15' }), doc({ invoice_date: '2026-09-16' }))
      .header.find(h => h.field === 'invoice_date')!.ok).toBe(false);
  });

  it('сумма и НДС — допуск 0,01 включительно, 0,02 уже ошибка', () => {
    const ok = compareGolden(doc({ total_sum: 1932 }), doc({ total_sum: 1932.01 }));
    expect(ok.header.find(h => h.field === 'total_sum')!.ok).toBe(true);
    const bad = compareGolden(doc({ total_sum: 1932 }), doc({ total_sum: 1932.02 }));
    expect(bad.header.find(h => h.field === 'total_sum')!.ok).toBe(false);

    const vatBad = compareGolden(doc({ vat_sum: 351.27 }), doc({ vat_sum: 322 }));
    expect(vatBad.summary.failed).toEqual(['vat_sum']);
  });

  it('НДС: пусто с обеих сторон — совпадение, пусто только с одной — ошибка', () => {
    expect(compareGolden(doc({ vat_sum: null }), doc({ vat_sum: null }))
      .header.find(h => h.field === 'vat_sum')!.ok).toBe(true);
    expect(compareGolden(doc({ vat_sum: 351.27 }), doc({ vat_sum: null }))
      .header.find(h => h.field === 'vat_sum')!.ok).toBe(false);
    expect(compareGolden(doc({ vat_sum: null }), doc({ vat_sum: 0 }))
      .header.find(h => h.field === 'vat_sum')!.ok).toBe(false);
  });

  it('ИНН — точно (пробелы не считаются), одна цифра — ошибка', () => {
    expect(compareGolden(doc({ supplier_inn: '7724357632' }), doc({ supplier_inn: ' 7724 357632 ' }))
      .header.find(h => h.field === 'supplier_inn')!.ok).toBe(true);
    expect(compareGolden(doc({ supplier_inn: '7724357632' }), doc({ supplier_inn: '7724357832' }))
      .header.find(h => h.field === 'supplier_inn')!.ok).toBe(false);
  });
});

describe('compareGolden — строки', () => {
  it('разное число строк: items_count ошибка, лишняя строка помечена и не засчитана', () => {
    const rec = doc({
      items: [...doc().items, { quantity: 1, unit: 'шт', price: 10, total: 10 }],
    });
    const r = compareGolden(doc(), rec);
    expect(r.items_count).toEqual({ field: 'items_count', expected: 2, actual: 3, ok: false });
    expect(r.summary.failed).toEqual(['items_count']);
    expect(r.summary.items_total).toBe(3);
    expect(r.summary.items_ok).toBe(2);
    expect(r.summary.items_ok_ratio).toBeCloseTo(0.6667, 4);
    const extra = r.items[2];
    expect(extra.ok).toBe(false);
    expect(extra.missing).toBe('expected');
    expect(extra.fields.find(f => f.field === 'total')).toEqual({ field: 'total', expected: null, actual: 10, ok: false });
    // Потерянные/лишние строки не раздувают счётчики по полям.
    expect(r.summary.line_failures).toEqual({});
  });

  it('модель потеряла строку — missing=actual, значения эталона видны в отчёте', () => {
    const r = compareGolden(doc(), doc({ items: [doc().items[0]] }));
    expect(r.items[1].missing).toBe('actual');
    expect(r.items[1].fields.find(f => f.field === 'quantity')).toEqual({ field: 'quantity', expected: 2.5, actual: null, ok: false });
    expect(r.summary.all_ok).toBe(false);
  });

  it('по позиции: количество ±0,001, цена и сумма ±0,01', () => {
    const rec = doc({
      items: [
        { quantity: 60.0009, unit: 'шт', price: 32.21, total: 1932.01 },  // всё в допуске
        { quantity: 2.502, unit: 'кг', price: 772.8, total: 1932 },       // количество вне допуска
      ],
    });
    const r = compareGolden(doc(), rec);
    expect(r.items[0].ok).toBe(true);
    expect(r.items[1].ok).toBe(false);
    expect(r.items[1].fields.find(f => f.field === 'quantity')!.ok).toBe(false);
    expect(r.summary.line_failures).toEqual({ quantity: 1 });
    expect(r.summary.items_ok_ratio).toBe(0.5);
    // Число строк совпало — в failed только поля шапки/число строк, строки считаются отдельно.
    expect(r.summary.failed).toEqual([]);
    expect(r.summary.all_ok).toBe(false);
  });

  it('единица: регистр, пробелы по краям и точка в конце не важны; другая единица — ошибка', () => {
    const same = compareGolden(
      doc({ items: [{ quantity: 1, unit: 'шт', price: 1, total: 1 }] }),
      doc({ items: [{ quantity: 1, unit: ' ШТ. ', price: 1, total: 1 }] }),
    );
    expect(same.items[0].ok).toBe(true);
    const other = compareGolden(
      doc({ items: [{ quantity: 1, unit: 'шт', price: 1, total: 1 }] }),
      doc({ items: [{ quantity: 1, unit: 'кг', price: 1, total: 1 }] }),
    );
    expect(other.items[0].fields.find(f => f.field === 'unit')!.ok).toBe(false);
    expect(other.summary.line_failures).toEqual({ unit: 1 });
  });

  it('нет строк ни там, ни там — точность строк 1, число строк сошлось', () => {
    const r = compareGolden(doc({ items: [] }), doc({ items: [] }));
    expect(r.summary.items_ok_ratio).toBe(1);
    expect(r.summary.items_count_ok).toBe(true);
    expect(r.summary.all_ok).toBe(true);
  });
});

describe('truthLine / truthFromInvoice — что считается правдой', () => {
  it('без колонок raw_* берутся quantity/unit/price/total', () => {
    expect(truthLine({ quantity: 24, unit: 'кг', price: 80.5, total: 1932 }))
      .toEqual({ quantity: 24, unit: 'кг', price: 80.5, total: 1932 });
  });

  it('с raw_* — значения «как в накладной», а не пересчитанные в единицы 1С', () => {
    const row = {
      quantity: 24, unit: 'кг', price: 80.5, total: 1932,
      raw_quantity: 60, raw_unit: 'шт', raw_price: 32.2, raw_total: 1932,
    };
    expect(truthLine(row)).toEqual({ quantity: 60, unit: 'шт', price: 32.2, total: 1932 });
  });

  it('raw_* есть, но все NULL (не заполнены) — откат на текущие значения', () => {
    const row = {
      quantity: 24, unit: 'кг', price: 80.5, total: 1932,
      raw_quantity: null, raw_unit: null, raw_price: null, raw_total: null,
    };
    expect(truthLine(row)).toEqual({ quantity: 24, unit: 'кг', price: 80.5, total: 1932 });
  });

  it('raw_* заполнены частично — берутся raw_* как есть (пустая единица в накладной — тоже правда)', () => {
    const row = {
      quantity: 3, unit: 'шт', price: 10, total: 30,
      raw_quantity: 3, raw_unit: null, raw_price: 10, raw_total: 30,
    };
    expect(truthLine(row)).toEqual({ quantity: 3, unit: null, price: 10, total: 30 });
  });

  it('шапка из строки накладной: строки-числа приводятся, пустые строки → null', () => {
    const t = truthFromInvoice(
      { invoice_number: ' 611 ', invoice_date: '2026-09-15', total_sum: '3864.00', vat_sum: null, supplier_inn: '' },
      [{ quantity: '60', unit: 'шт', price: '32,2', total: 1932 }],
    );
    expect(t).toEqual({
      invoice_number: '611',
      invoice_date: '2026-09-15',
      total_sum: 3864,
      vat_sum: null,
      supplier_inn: null,
      items: [{ quantity: 60, unit: 'шт', price: 32.2, total: 1932 }],
    });
  });
});

describe('нормализаторы', () => {
  it('toNumber: пробелы-разделители тысяч и запятая', () => {
    expect(toNumber('1 932,50')).toBe(1932.5);
    expect(toNumber('')).toBeNull();
    expect(toNumber('abc')).toBeNull();
    expect(toNumber(NaN)).toBeNull();
    expect(toNumber(undefined)).toBeNull();
  });

  it('normalizeDate / normalizeUnit', () => {
    expect(normalizeDate('01.02.2026')).toBe('2026-02-01');
    expect(normalizeDate(' 2026-02-01 ')).toBe('2026-02-01');
    expect(normalizeDate(null)).toBe('');
    expect(normalizeUnit(' Упак.. ')).toBe('упак');
    expect(normalizeUnit(null)).toBe('');
  });
});
