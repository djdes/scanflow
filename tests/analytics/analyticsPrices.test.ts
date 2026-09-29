import { describe, it, expect, vi, beforeEach } from 'vitest';

// Закупочные цены (п.11): группировка строк в закупки, сводки, «у кого дешевле»,
// подорожания за неделю — чистые функции; SQL — только область компании.
const linesAll = vi.fn();
const dirAll = vi.fn();
const prepareMock = vi.fn((sql: string) => ({
  all: String(sql).includes('FROM invoice_items ii') ? linesAll : dirAll,
  get: vi.fn(),
  run: vi.fn(),
}));
vi.mock('../../src/database/db', () => ({ getDb: () => ({ prepare: prepareMock }) }));

import {
  buildPriceDetail,
  buildPriceOverview,
  buildSupplierDirectory,
  findWeeklyRises,
  getPriceItemDetail,
  getPriceOverview,
  getWeeklyPriceRises,
  groupPriceLines,
  loadPriceLines,
  loadSupplierDirectory,
  summarizeItem,
  type PriceLineRow,
  type SupplierDirectoryRow,
} from '../../src/services/analyticsPrices';

const NOW = new Date(Date.UTC(2026, 8, 29, 12, 0, 0)); // 2026-09-29
const day = (n: number): string => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10);

const MEAT_INN = '7707083893';
let nextItem = 1;
let nextInvoice = 100;

function line(p: Partial<PriceLineRow> & { daysAgo: number }): PriceLineRow {
  const date = day(p.daysAgo);
  const { daysAgo: _d, ...rest } = p;
  return {
    item_id: nextItem++,
    onec_guid: 'g-beef',
    price: 100,
    unit: 'кг',
    quantity: 10,
    total: 1000,
    mapped_name: 'Говядина',
    invoice_id: nextInvoice++,
    invoice_number: null,
    invoice_date: date,
    created_at: `${date} 12:00:00`,
    supplier: 'ООО «Мясной двор»',
    supplier_inn: MEAT_INN,
    catalog_name: 'Говядина лопатка',
    catalog_unit: 'кг',
    ref_median: 510,
    ref_unit: 'кг',
    ref_samples: 8,
    ...rest,
  };
}

const PETROV = { supplier: 'ИП Петров', supplier_inn: null };

function beefLines(): PriceLineRow[] {
  return [
    line({ daysAgo: 80, price: 500, quantity: 10, total: 5000 }),
    line({ daysAgo: 60, price: 480, quantity: 5, total: 2400, ...PETROV }),
    line({ daysAgo: 50, price: 520, quantity: 10, total: 5200 }),
    line({ daysAgo: 20, price: 470, quantity: 5, total: 2350, ...PETROV }),
    line({ daysAgo: 10, price: 475, quantity: 5, total: 2375, ...PETROV }),
    line({ daysAgo: 5, price: 585, quantity: 10, total: 5850 }),
    // в чужой единице — не смешиваем со «кг»
    line({ daysAgo: 30, price: 1500, unit: 'шт', quantity: 1, total: 1500 }),
    // явная ошибка пересчёта (5 ₽/кг) — не цена
    line({ daysAgo: 40, price: 5, quantity: 100, total: 500, ...PETROV }),
  ];
}

function milkLines(): PriceLineRow[] {
  const invoice = 900;
  return [
    line({ daysAgo: 3, onec_guid: 'g-milk', catalog_name: null, catalog_unit: 'л', mapped_name: 'Молоко 3,2%',
      unit: 'л', price: 100, quantity: 2, total: 200, invoice_id: invoice, ref_median: 95, ref_unit: 'шт' }),
    line({ daysAgo: 3, onec_guid: 'g-milk', catalog_name: null, catalog_unit: 'л', mapped_name: 'Молоко 3,2%',
      unit: 'Литр', price: 110, quantity: 3, total: 330, invoice_id: invoice, ref_median: 95, ref_unit: 'шт' }),
  ];
}

const DIR_ROWS: SupplierDirectoryRow[] = [
  { supplier: 'ООО «Мясной двор»', supplier_inn: MEAT_INN, card_name: 'Мясной двор (карточка)', last_at: `${day(5)} 12:00:00` },
  { supplier: 'ИП Петров', supplier_inn: null, card_name: null, last_at: `${day(10)} 12:00:00` },
];

beforeEach(() => {
  nextItem = 1;
  nextInvoice = 100;
  linesAll.mockReset();
  dirAll.mockReset();
  prepareMock.mockClear();
});

describe('buildSupplierDirectory', () => {
  it('название — из карточки справочника, иначе из свежей накладной; без ИНН — по названию', () => {
    const dir = buildSupplierDirectory([
      // старое написание раньше в списке — название всё равно из свежей накладной
      { supplier: 'Петров ИП', supplier_inn: null, card_name: null, last_at: `${day(90)} 12:00:00` },
      ...DIR_ROWS,
      { supplier: 'Мясной двор ООО', supplier_inn: null, card_name: null, last_at: `${day(2)} 12:00:00` },
    ]);
    expect(dir.keyOf({ supplier_inn: null, supplier: 'Мясной двор' })).toBe(`inn:${MEAT_INN}`);
    expect(dir.get(`inn:${MEAT_INN}`)).toEqual({ key: `inn:${MEAT_INN}`, inn: MEAT_INN, name: 'Мясной двор (карточка)' });
    expect(dir.get('name:петров')).toEqual({ key: 'name:петров', inn: null, name: 'ИП Петров' });
    expect(dir.get('inn:5000000000').name).toBe('ИНН 5000000000');
    expect(dir.get('name:').name).toBe('Поставщик не указан');
  });
});

describe('groupPriceLines', () => {
  it('самая частая единица, чужая единица и ошибки цены — отдельно', () => {
    const dir = buildSupplierDirectory(DIR_ROWS);
    const g = groupPriceLines(beefLines(), dir, day(90)).get('g-beef')!;
    expect(g.name).toBe('Говядина лопатка');
    expect(g.unit).toBe('кг');
    expect(g.excluded).toEqual({ other_unit: 1, outliers: 1 });
    expect(g.purchases.map(p => p.price)).toEqual([500, 480, 520, 470, 475, 585]);
    expect(g.purchases.map(p => p.supplier_key)).toEqual([
      `inn:${MEAT_INN}`, 'name:петров', `inn:${MEAT_INN}`, 'name:петров', 'name:петров', `inn:${MEAT_INN}`,
    ]);
    expect(g.reference).toEqual({ median_price: 510, unit: 'кг', samples: 8 });
  });

  it('несколько строк позиции в одной накладной — одна закупка по средневзвешенной цене', () => {
    const dir = buildSupplierDirectory(DIR_ROWS);
    const g = groupPriceLines(milkLines(), dir, day(90)).get('g-milk')!;
    expect(g.unit).toBe('л'); // «Литр» и «л» — одна единица
    expect(g.name).toBe('Молоко 3,2%');
    expect(g.purchases).toHaveLength(1);
    expect(g.purchases[0].price).toBeCloseTo(106);
    expect(g.purchases[0].qty).toBe(5);
    expect(g.purchases[0].total).toBe(530);
    // «обычная цена» посчитана в другой единице — не показываем
    expect(g.reference).toBeNull();
  });

  it('закупки раньше начала периода отсекаются по дате закупки', () => {
    const dir = buildSupplierDirectory(DIR_ROWS);
    const g = groupPriceLines(beefLines(), dir, day(30)).get('g-beef')!;
    expect(g.purchases.map(p => p.price)).toEqual([470, 475, 585]);
  });
});

describe('summarizeItem', () => {
  it('последняя цена, изменения, «у кого дешевле» и экономия при недавнем объёме', () => {
    const dir = buildSupplierDirectory(DIR_ROWS);
    const g = groupPriceLines(beefLines(), dir, day(90)).get('g-beef')!;
    const { summary: s, suppliers } = summarizeItem(g, dir, { now: NOW, periodDays: 90 });
    expect(s).toMatchObject({
      guid: 'g-beef', name: 'Говядина лопатка', unit: 'кг',
      purchases: 6, suppliers: 2,
      last_price: 585, last_date: day(5), last_supplier: 'Мясной двор (карточка)',
      prev_price: 475, last_change_pct: 23.2,
      period_change_pct: -5,
      last_vs_reference_pct: 14.7,
      min_price: 470, max_price: 585, median_price: 490,
      spend: 23175, qty: 45,
      cheapest: { key: 'name:петров', name: 'ИП Петров', recent_median: 475 },
      saving: { rub: 1100, pct: 18.8, volume: 10, window_days: 30 },
      spark: [500, 480, 520, 470, 475, 585],
    });
    expect(suppliers.map(x => [x.name, x.purchases, x.last_price, x.change_pct, x.recent_median, x.is_cheapest])).toEqual([
      ['Мясной двор (карточка)', 3, 585, 12.5, 520, false],
      ['ИП Петров', 3, 475, 1.1, 475, true],
    ]);
  });

  it('один поставщик — сравнивать не с кем', () => {
    const dir = buildSupplierDirectory(DIR_ROWS);
    const g = groupPriceLines(milkLines(), dir, day(90)).get('g-milk')!;
    const { summary } = summarizeItem(g, dir, { now: NOW, periodDays: 90 });
    expect(summary.cheapest).toBeNull();
    expect(summary.saving).toBeNull();
    expect(summary.period_change_pct).toBeNull();
    expect(summary.last_change_pct).toBeNull();
  });
});

describe('buildPriceOverview / buildPriceDetail', () => {
  it('позиции по сумме закупок; итоги', () => {
    const dir = buildSupplierDirectory(DIR_ROWS);
    const o = buildPriceOverview([...beefLines(), ...milkLines()], dir, { now: NOW, periodDays: 90 });
    expect(o.items.map(i => i.guid)).toEqual(['g-beef', 'g-milk']);
    expect(o.recent_days).toBe(30);
    expect(o.totals).toEqual({ items: 2, purchases: 7, spend: 23705, rising: 0, saving_rub: 1100 });
    expect(o.truncated).toBe(false);
  });

  it('окно экономии не длиннее периода', () => {
    const dir = buildSupplierDirectory(DIR_ROWS);
    const o = buildPriceOverview(beefLines(), dir, { now: NOW, periodDays: 30 });
    const beef = o.items[0];
    expect(beef.purchases).toBe(3);
    // Петров: 470 и 475 → 472,5; Мясной двор: 585 × 10 кг
    expect(beef.cheapest?.recent_median).toBe(472.5);
    expect(beef.saving).toEqual({ rub: 1125, pct: 19.2, volume: 10, window_days: 30 });
  });

  it('деталь позиции — точки по дате и поставщики; чужой guid — null', () => {
    const dir = buildSupplierDirectory(DIR_ROWS);
    const d = buildPriceDetail([...beefLines(), ...milkLines()], dir, 'g-beef', { now: NOW, periodDays: 90 })!;
    expect(d.item.guid).toBe('g-beef');
    expect(d.points.map(p => [p.date, p.price])).toEqual([
      [day(80), 500], [day(60), 480], [day(50), 520], [day(20), 470], [day(10), 475], [day(5), 585],
    ]);
    expect(d.points[5]).toMatchObject({ qty: 10, total: 5850, supplier_key: `inn:${MEAT_INN}` });
    expect(d.suppliers.find(s => s.is_cheapest)?.name).toBe('ИП Петров');
    expect(d.points_truncated).toBe(false);
    expect(buildPriceDetail(beefLines(), dir, 'нет-такой', { now: NOW, periodDays: 90 })).toBeNull();
  });
});

describe('findWeeklyRises', () => {
  it('новая цена недели против прошлой закупки у того же поставщика', () => {
    const dir = buildSupplierDirectory(DIR_ROWS);
    const groups = groupPriceLines(beefLines(), dir, day(97));
    const rises = findWeeklyRises(groups, dir, NOW);
    expect(rises).toEqual([{
      guid: 'g-beef', name: 'Говядина лопатка', unit: 'кг',
      supplier_key: `inn:${MEAT_INN}`, supplier: 'Мясной двор (карточка)',
      from_price: 520, from_date: day(50), to_price: 585, to_date: day(5),
      change_pct: 12.5, qty: 10, impact_rub: 650,
    }]);
  });

  it('подешевело или выросло меньше порога — не подорожание', () => {
    const dir = buildSupplierDirectory(DIR_ROWS);
    const lines = [
      line({ daysAgo: 30, price: 100 }),
      line({ daysAgo: 2, price: 104 }),
      line({ daysAgo: 30, onec_guid: 'g-2', price: 100 }),
      line({ daysAgo: 1, onec_guid: 'g-2', price: 90 }),
    ];
    expect(findWeeklyRises(groupPriceLines(lines, dir, day(97)), dir, NOW)).toEqual([]);
  });

  it('первая закупка у поставщика — сравнивать не с чем', () => {
    const dir = buildSupplierDirectory(DIR_ROWS);
    const lines = [line({ daysAgo: 2, price: 300 }), line({ daysAgo: 40, price: 100, ...PETROV })];
    expect(findWeeklyRises(groupPriceLines(lines, dir, day(97)), dir, NOW)).toEqual([]);
  });

  it('сортировка — по рублям подорожания, затем по проценту', () => {
    const dir = buildSupplierDirectory(DIR_ROWS);
    const lines = [
      line({ daysAgo: 30, onec_guid: 'g-a', price: 100, quantity: 1 }),
      line({ daysAgo: 1, onec_guid: 'g-a', price: 150, quantity: 1 }),   // +50%, +50 ₽
      line({ daysAgo: 30, onec_guid: 'g-b', price: 100, quantity: 100 }),
      line({ daysAgo: 1, onec_guid: 'g-b', price: 110, quantity: 100 }), // +10%, +1000 ₽
    ];
    const rises = findWeeklyRises(groupPriceLines(lines, dir, day(97)), dir, NOW);
    expect(rises.map(r => [r.guid, r.change_pct, r.impact_rub])).toEqual([['g-b', 10, 1000], ['g-a', 50, 50]]);
  });
});

describe('SQL — только компания вызывающего', () => {
  it('loadPriceLines: владелец, период с запасом, без флагов пересчёта', async () => {
    linesAll.mockResolvedValue([]);
    await loadPriceLines(5, 97);
    let sql = String(prepareMock.mock.calls[0][0]);
    expect(linesAll).toHaveBeenLastCalledWith(5);
    expect(sql).toMatch(/i\.owner_user_id = \?/);
    expect(sql).toMatch(/INTERVAL 97 DAY/);
    expect(sql).toMatch(/ii\.qty_flag IS NULL/);
    expect(sql).toMatch(/n\.owner_user_id = i\.owner_user_id/);
    expect(sql).toMatch(/ps\.owner_user_id = i\.owner_user_id/);

    await loadPriceLines(5, 30, 'g-1');
    sql = String(prepareMock.mock.calls[1][0]);
    expect(linesAll).toHaveBeenLastCalledWith(5, 'g-1');
    expect(sql).toMatch(/ii\.onec_guid = \?/);
  });

  it('loadSupplierDirectory: только накладные компании', async () => {
    dirAll.mockResolvedValue(DIR_ROWS);
    const dir = await loadSupplierDirectory(5, 37);
    expect(dirAll).toHaveBeenCalledWith(5);
    expect(String(prepareMock.mock.calls[0][0])).toMatch(/i\.owner_user_id = \?/);
    expect(dir.get(`inn:${MEAT_INN}`).name).toBe('Мясной двор (карточка)');
  });

  it('getPriceOverview / getPriceItemDetail / getWeeklyPriceRises собирают отчёт из двух запросов', async () => {
    linesAll.mockResolvedValue([...beefLines(), ...milkLines()]);
    dirAll.mockResolvedValue(DIR_ROWS);
    const o = await getPriceOverview(5, 90, NOW);
    expect(o.period_days).toBe(90);
    expect(o.items).toHaveLength(2);
    expect(linesAll).toHaveBeenCalledWith(5);

    linesAll.mockResolvedValue(beefLines());
    const d = await getPriceItemDetail(5, 'g-beef', 90, NOW);
    expect(linesAll).toHaveBeenLastCalledWith(5, 'g-beef');
    expect(d?.item.purchases).toBe(6);
    linesAll.mockResolvedValue([]);
    expect(await getPriceItemDetail(5, 'g-beef', 90, NOW)).toBeNull();

    linesAll.mockResolvedValue(beefLines());
    const rises = await getWeeklyPriceRises(5, NOW);
    expect(rises.map(r => r.change_pct)).toEqual([12.5]);
  });
});
