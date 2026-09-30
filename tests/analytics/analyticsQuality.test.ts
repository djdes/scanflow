import { describe, it, expect, vi, beforeEach } from 'vitest';

// «Качество поставщиков» (п.7): группировка и показатели — чистая функция;
// SQL проверяем только на область компании и состав запросов (getDb замокан,
// БД нет).
const allMock = vi.fn();
const getMock = vi.fn();
const prepareMock = vi.fn((_sql: string) => ({ all: allMock, get: getMock, run: vi.fn() }));
vi.mock('../../src/database/db', () => ({ getDb: () => ({ prepare: prepareMock }) }));

import {
  buildSupplierQuality,
  compareWorstFirst,
  getSupplierQuality,
  isCleanInvoice,
  isTracked,
  loadQualityItemRows,
  loadQualityRows,
  loadTrackingSince,
  misalignedInvoiceIds,
  MIN_INVOICES_FOR_VERDICT,
  type QualityInvoiceRow,
  type QualityItemRow,
} from '../../src/services/analyticsQuality';

let nextId = 1;
function inv(p: Partial<QualityInvoiceRow>): QualityInvoiceRow {
  return {
    id: nextId++,
    invoice_number: null,
    invoice_date: null,
    supplier: 'ООО «Ромашка»',
    supplier_inn: '7707083893',
    card_name: null,
    total_sum: 1000,
    status: 'processed',
    created_at: '2026-09-01 10:00:00',
    sent_at: null,
    items_total_mismatch: 0,
    line_count: 10,
    flagged_lines: 0,
    edited_lines: 0,
    deleted_lines: 0,
    unmapped_lines: 0,
    low_conf_lines: 0,
    item_edit_rows: 0,
    header_edits: 0,
    ...p,
  };
}

function item(invoiceId: number, name: string, q: number | null, p: number | null, t: number | null, rowNo: number | null = null): QualityItemRow {
  return { invoice_id: invoiceId, original_name: name, q, u: 'шт', p, t, row_no: rowNo };
}

beforeEach(() => {
  nextId = 1;
  allMock.mockReset();
  getMock.mockReset();
  prepareMock.mockClear();
  prepareMock.mockImplementation((_sql: string) => ({ all: allMock, get: getMock, run: vi.fn() }));
});

describe('isCleanInvoice / isTracked', () => {
  it('чистая — без правок строк и шапки, без флагов пересчёта, сумма сходится, строки не сдвинуты', () => {
    expect(isCleanInvoice(inv({}))).toBe(true);
    expect(isCleanInvoice(inv({ edited_lines: 1 }))).toBe(false);
    // строку удалили: её уже нет, но правка была
    expect(isCleanInvoice(inv({ deleted_lines: 1 }))).toBe(false);
    // НДС всем строкам — запись в журнале без строки
    expect(isCleanInvoice(inv({ item_edit_rows: 1 }))).toBe(false);
    expect(isCleanInvoice(inv({ header_edits: 2 }))).toBe(false);
    expect(isCleanInvoice(inv({ flagged_lines: 1 }))).toBe(false);
    expect(isCleanInvoice(inv({ items_total_mismatch: 1 }))).toBe(false);
    expect(isCleanInvoice(inv({}), true)).toBe(false);
  });

  it('правки записываются с начала журнала: раньше — не «правок не было», а «неизвестно»', () => {
    expect(isTracked('2026-09-29 10:00:00', '2026-09-29 09:00:00')).toBe(true);
    expect(isTracked('2026-09-29 08:59:59', '2026-09-29 09:00:00')).toBe(false);
    expect(isTracked('2020-01-01 00:00:00', null)).toBe(true);
  });
});

describe('misalignedInvoiceIds — та же проверка сдвига, что у автопилота', () => {
  it('строка без чисел среди строк с числами и одно название у соседних строк', () => {
    const rows: QualityItemRow[] = [
      // 1: всё на месте
      item(1, 'Молоко', 2, 80, 160, 1), item(1, 'Кефир', 3, 90, 270, 2),
      // 2: первая строка без количества, цены и суммы (0 в базе — то же «нет числа»)
      item(2, 'Мука (50кг)', 0, 0, null, 1), item(2, 'Сахар', 1, 70, 70, 2),
      // 3: «Мука» у двух соседних строк, а числа разные
      item(3, 'Мука (50кг)', 1, 2500, 2500, 1), item(3, 'Мука (50кг)', 2, 90, 180, 2),
      // 4: все строки без чисел — сдвигом не считается (сравнивать не с чем)
      item(4, 'Услуга', null, null, null, 1), item(4, 'Доставка', null, null, null, 2),
    ];
    expect([...misalignedInvoiceIds(rows)].sort()).toEqual([2, 3]);
  });

  it('повтор номера строки из колонки «№»', () => {
    const rows = [item(5, 'Батон', 1, 50, 50, 3), item(5, 'Хлеб', 2, 40, 80, 3)];
    expect(misalignedInvoiceIds(rows).has(5)).toBe(true);
  });
});

describe('buildSupplierQuality', () => {
  const SINCE = '2026-09-10 00:00:00';
  const rows = (): QualityInvoiceRow[] => [
    // Ромашка: 4 накладные с ИНН (самая свежая — первая по дате) …
    inv({ created_at: '2026-09-20 10:00:00', sent_at: null, line_count: 10, card_name: 'ООО Ромашка (карточка)' }),
    inv({ created_at: '2026-09-18 10:00:00', sent_at: '2026-09-19 10:00:00', line_count: 10 }),
    inv({ created_at: '2026-09-15 10:00:00', sent_at: '2026-09-18 10:00:00', line_count: 10, edited_lines: 2, deleted_lines: 1, flagged_lines: 1 }),
    inv({ created_at: '2026-09-12 10:00:00', sent_at: '2026-09-14 10:00:00', line_count: 10, header_edits: 1, unmapped_lines: 1, low_conf_lines: 1, items_total_mismatch: 1 }),
    // … и одна без ИНН, но с тем же названием, загружена ДО журнала правок:
    // её «правки» в доли правок не идут, а сумма и сдвиг — идут
    inv({ created_at: '2026-09-05 10:00:00', supplier_inn: null, supplier: 'Ромашка ООО', sent_at: '2026-09-06 10:00:00', line_count: 10, total_sum: 500, edited_lines: 9 }),
    // Лютик: одна накладная без ИНН — мало данных для вывода
    inv({ created_at: '2026-09-21 10:00:00', supplier_inn: null, supplier: 'ИП Лютик', line_count: 4, edited_lines: 4, total_sum: 300 }),
  ];

  it('группирует по ИНН, подтягивает накладную без ИНН по названию', () => {
    const { suppliers } = buildSupplierQuality(rows(), { trackingSince: SINCE });
    const r = suppliers.find(s => s.key === 'inn:7707083893')!;
    expect(r.name).toBe('ООО Ромашка (карточка)');
    expect(r.inn).toBe('7707083893');
    expect(r.search).toBe('7707083893');
    expect(r.invoices).toBe(5);
    expect(r.tracked_invoices).toBe(4);
    expect(r.lines).toBe(50);
    expect(r.tracked_lines).toBe(40);
    expect(r.total_sum).toBe(4500);
    const lutik = suppliers.find(s => s.key === 'name:лютик')!;
    expect(lutik.search).toBe('ИП Лютик');
  });

  it('доли правок — только по накладным из журнала; удалённые строки — в числителе и знаменателе', () => {
    const r = buildSupplierQuality(rows(), { trackingSince: SINCE }).suppliers.find(s => s.inn)!;
    expect(r.edited_lines).toBe(2);
    expect(r.deleted_lines).toBe(1);
    expect(r.edited_share).toBeCloseTo(3 / 41);
    expect(r.flagged_lines).toBe(1);
    expect(r.flagged_share).toBeCloseTo(1 / 40);
    expect(r.header_edited_invoices).toBe(1);
    expect(r.header_edit_share).toBeCloseTo(1 / 4);
    // сумма, сопоставление и отправка — по всем накладным периода
    expect(r.mismatch_invoices).toBe(1);
    expect(r.mismatch_share).toBeCloseTo(1 / 5);
    expect(r.mapping_issue_share).toBeCloseTo(2 / 50);
    expect(r.sent_invoices).toBe(4);
    expect(r.sent_share).toBeCloseTo(0.8);
    // 1, 3, 2, 1 день → медиана 1,5
    expect(r.median_days_to_1c).toBe(1.5);
    expect(r.first_invoice_at).toBe('2026-09-05 10:00:00');
    expect(r.last_invoice_at).toBe('2026-09-20 10:00:00');
  });

  it('без начала журнала (null) — все накладные в долях правок', () => {
    const r = buildSupplierQuality(rows()).suppliers.find(s => s.inn)!;
    expect(r.tracked_invoices).toBe(5);
    expect(r.edited_lines).toBe(11);
  });

  it('сдвиг строк — доля накладных, и накладная со сдвигом не «чистая»', () => {
    const list = rows();
    const { suppliers } = buildSupplierQuality(list, { trackingSince: SINCE, misaligned: new Set([list[1].id]) });
    const r = suppliers.find(s => s.inn)!;
    expect(r.misaligned_invoices).toBe(1);
    expect(r.misaligned_share).toBeCloseTo(0.2);
    expect(r.recent_invoices[1]).toMatchObject({ misaligned: true, clean: false });
  });

  it('серия «подряд без правок» — по накладным из журнала, с самой свежей до первой правки', () => {
    const r = buildSupplierQuality(rows(), { trackingSince: SINCE }).suppliers.find(s => s.inn)!;
    expect(r.clean_streak).toBe(2);
    // правки старой накладной неизвестны (null), сумма у неё сходится
    expect(r.recent_invoices.map(x => x.clean)).toEqual([true, true, false, false, null]);
    expect(r.recent_invoices.map(x => x.tracked)).toEqual([true, true, true, true, false]);
    expect(r.recent_invoices[4].edited_lines).toBe(0);
    expect(r.recent_invoices[3]).toMatchObject({ mismatch: true, header_edits: 1 });
    expect(r.recent_invoices[0].created_at).toBe('2026-09-20 10:00:00');
  });

  it('подсказки по порогам', () => {
    const r = buildSupplierQuality(rows(), { trackingSince: SINCE }).suppliers.find(s => s.inn)!;
    expect(r.tones).toEqual({
      edited: 'warn',      // 3 из 41 строки ≈ 7,3%: больше 5%, не больше 15%
      flagged: 'warn',     // 1 из 40 = 2,5%
      header: 'warn',      // 1 из 4 = 25%
      mismatch: 'bad',     // 1 из 5 = 20%
      misaligned: 'good',  // 0
      mapping: 'good',     // 2 из 50 = 4%
      sent: 'warn',        // 80%
      days: 'good',        // 1,5 дня
      streak: 'warn',      // 2 подряд
    });
  });

  it('общий вывод — худшая из подсказок распознавания; меньше трёх накладных — без вывода', () => {
    const { suppliers } = buildSupplierQuality(rows(), { trackingSince: SINCE });
    const r = suppliers.find(s => s.inn)!;
    expect(r.verdict).toBe('bad');
    const few = suppliers.find(s => !s.inn)!;
    expect(few.invoices).toBeLessThan(MIN_INVOICES_FOR_VERDICT);
    expect(few.verdict).toBeNull();
    expect(few.tones.streak).toBeNull();
    expect(few.tones.edited).toBe('bad'); // 4 из 4 строк
    expect(few.name).toBe('ИП Лютик');
  });

  it('сначала худшие: вывод, затем баллы, «мало данных» — в конце', () => {
    const list = [
      // хороший, но с большим объёмом
      ...Array.from({ length: 6 }, (_, i) => inv({ supplier_inn: '5000000001', supplier: 'Хороший', created_at: `2026-09-1${i} 10:00:00` })),
      // три накладные, в каждой правили половину строк
      ...Array.from({ length: 3 }, (_, i) => inv({ supplier_inn: '5000000002', supplier: 'Плохой', created_at: `2026-09-1${i} 11:00:00`, edited_lines: 5 })),
      // три накладные, умеренно
      ...Array.from({ length: 3 }, (_, i) => inv({ supplier_inn: '5000000003', supplier: 'Средний', created_at: `2026-09-1${i} 12:00:00`, edited_lines: i === 0 ? 3 : 0 })),
      inv({ supplier_inn: null, supplier: 'Новенький', edited_lines: 10 }),
    ];
    const { suppliers } = buildSupplierQuality(list);
    expect(suppliers.map(s => s.name)).toEqual(['Плохой', 'Средний', 'Хороший', 'Новенький']);
    expect(suppliers[0].verdict).toBe('bad');
    expect(suppliers[1].verdict).toBe('warn');
    expect(suppliers[2].verdict).toBe('good');
    expect(suppliers[3].verdict).toBeNull();
    expect(suppliers[0].worst_score).toBeGreaterThan(suppliers[1].worst_score);
    expect([...suppliers].sort(compareWorstFirst).map(s => s.name)).toEqual(suppliers.map(s => s.name));
  });

  it('итоги по компании', () => {
    const { totals } = buildSupplierQuality(rows(), { trackingSince: SINCE });
    expect(totals).toMatchObject({
      suppliers: 2, invoices: 6, tracked_invoices: 5, lines: 54, tracked_lines: 44,
      edited_lines: 6, deleted_lines: 1, flagged_lines: 1, mapping_issue_lines: 2, unmapped_lines: 1,
      header_edited_invoices: 1, mismatch_invoices: 1, misaligned_invoices: 0, sent_invoices: 4, total_sum: 4800,
    });
    expect(totals.edited_share).toBeCloseTo(7 / 45);
    expect(totals.sent_share).toBeCloseTo(4 / 6);
    expect(totals.median_days_to_1c).toBe(1.5);
  });

  it('пустой период — пустой отчёт без деления на ноль', () => {
    const { totals, suppliers } = buildSupplierQuality([]);
    expect(suppliers).toEqual([]);
    expect(totals.invoices).toBe(0);
    expect(totals.edited_share).toBeNull();
    expect(totals.mismatch_share).toBeNull();
    expect(totals.median_days_to_1c).toBeNull();
  });

  it('накладная без строк и накладные до журнала не ломают доли', () => {
    const r = buildSupplierQuality([inv({ line_count: 0 })]).suppliers[0];
    expect(r.edited_share).toBeNull();
    expect(r.tones.edited).toBeNull();
    const old = buildSupplierQuality([inv({ created_at: '2026-08-01 10:00:00' })], { trackingSince: '2026-09-29 00:00:00' }).suppliers[0];
    expect(old.tracked_invoices).toBe(0);
    expect(old.edited_share).toBeNull();
    expect(old.flagged_share).toBeNull();
    expect(old.header_edit_share).toBeNull();
    expect(old.clean_streak).toBeNull();
    expect(old.mismatch_share).toBe(0);
  });
});

describe('SQL — только компания вызывающего', () => {
  it('loadQualityRows: владелец в обоих местах запроса, период — в INTERVAL, поля правок — из списков', async () => {
    allMock.mockResolvedValue([]);
    await loadQualityRows(7, 30);
    const sql = String(prepareMock.mock.calls[0][0]);
    expect(allMock).toHaveBeenCalledWith(7, 7);
    expect(sql).toMatch(/f\.owner_user_id = \?/);
    expect(sql).toMatch(/i\.owner_user_id = \?/);
    expect(sql).toMatch(/INTERVAL 30 DAY/);
    expect(sql).toMatch(/i\.status IN \('processed', 'sent_to_1c'\)/);
    expect(sql).toMatch(/duplicate_of IS NULL/);
    expect(sql).toMatch(/items_total_mismatch/);
    // правка строки — исправление распознанного; своё название 1С — нет
    expect(sql).toMatch(/e\.field IN \('quantity', 'unit', 'price', 'total', 'vat_rate', 'reconvert', 'revert_raw'\)/);
    expect(sql).not.toMatch(/name_overridden/);
    expect(sql).not.toMatch(/'mapped_name'/);
    // шапка: откат из снимка и сумма платёжки Сбера — не правка распознанного
    expect(sql).toMatch(/NOT LIKE '%restored_from%'/);
    expect(sql).not.toMatch(/sber_amount/);
    expect(sql).toMatch(/e\.field = 'deleted'/);
    // LINES — зарезервированное слово MySQL/MariaDB: «AS lines» — синтаксическая ошибка
    expect(sql).not.toMatch(/\bAS\s+lines\b/i);
    expect(sql).not.toMatch(/\.lines\b/);
    // «?» только под параметры владельца: литералов с вопросом в запросе нет
    expect(sql.match(/\?/g)).toHaveLength(2);
  });

  it('loadQualityItemRows: строки «как напечатано» только компании, по порядку строк', async () => {
    allMock.mockResolvedValue([]);
    await loadQualityItemRows(7, 90);
    const sql = String(prepareMock.mock.calls[0][0]);
    expect(allMock).toHaveBeenCalledWith(7);
    expect(sql).toMatch(/i\.owner_user_id = \?/);
    expect(sql).toMatch(/COALESCE\(ii\.raw_quantity, ii\.quantity\)/);
    expect(sql).toMatch(/ORDER BY ii\.invoice_id, COALESCE\(ii\.row_no, 1000000\), ii\.id/);
  });

  it('loadTrackingSince: дата миграций журнала правок и флагов; ошибка — null', async () => {
    getMock.mockResolvedValue({ since: '2026-09-29 18:40:00' });
    expect(await loadTrackingSince()).toBe('2026-09-29 18:40:00');
    expect(String(prepareMock.mock.calls[0][0])).toMatch(/FROM migration_history WHERE version IN \(64, 67\)/);
    getMock.mockResolvedValue({ since: null });
    expect(await loadTrackingSince()).toBeNull();
    getMock.mockRejectedValue(new Error('no table'));
    expect(await loadTrackingSince()).toBeNull();
  });

  it('getSupplierQuality собирает отчёт из трёх запросов', async () => {
    const first = inv({ created_at: '2026-09-20 10:00:00', edited_lines: 1 });
    const old = inv({ created_at: '2026-09-01 10:00:00', edited_lines: 5 });
    prepareMock.mockImplementation((sql: string) => ({
      all: String(sql).includes('COALESCE(ii.raw_quantity')
        ? vi.fn().mockResolvedValue([item(first.id, 'Мука', 0, 0, 0, 1), item(first.id, 'Сахар', 1, 70, 70, 2)])
        : vi.fn().mockResolvedValue([first, old]),
      get: vi.fn().mockResolvedValue({ since: '2026-09-10 00:00:00' }),
      run: vi.fn(),
    }));
    const r = await getSupplierQuality(3, 90);
    expect(r.period_days).toBe(90);
    expect(r.tracking_since).toBe('2026-09-10 00:00:00');
    expect(r.thresholds.edited).toEqual({ good: 0.05, warn: 0.15 });
    expect(r.suppliers).toHaveLength(1);
    expect(r.suppliers[0].edited_lines).toBe(1);
    expect(r.suppliers[0].misaligned_invoices).toBe(1);
    expect(r.truncated).toBe(false);
  });
});
