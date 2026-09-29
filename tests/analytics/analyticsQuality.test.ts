import { describe, it, expect, vi, beforeEach } from 'vitest';

// Отчёт качества по поставщикам (п.7): группировка и показатели — чистая
// функция; SQL проверяем только на область компании (getDb замокан, БД нет).
const allMock = vi.fn();
const prepareMock = vi.fn((_sql: string) => ({ all: allMock, get: vi.fn(), run: vi.fn() }));
vi.mock('../../src/database/db', () => ({ getDb: () => ({ prepare: prepareMock }) }));

import {
  buildSupplierQuality,
  isCleanInvoice,
  loadQualityRows,
  getSupplierQuality,
  MIN_INVOICES_FOR_VERDICT,
  type QualityInvoiceRow,
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
    line_count: 10,
    flagged_lines: 0,
    edited_lines: 0,
    unmapped_lines: 0,
    low_conf_lines: 0,
    item_edit_rows: 0,
    header_edits: 0,
    ...p,
  };
}

beforeEach(() => {
  nextId = 1;
  allMock.mockReset();
  prepareMock.mockClear();
});

describe('isCleanInvoice', () => {
  it('чистая — без правок строк и шапки и без флагов пересчёта', () => {
    expect(isCleanInvoice(inv({}))).toBe(true);
    expect(isCleanInvoice(inv({ edited_lines: 1 }))).toBe(false);
    // правка строки, которую потом удалили: строки нет, запись в журнале есть
    expect(isCleanInvoice(inv({ item_edit_rows: 1 }))).toBe(false);
    expect(isCleanInvoice(inv({ header_edits: 2 }))).toBe(false);
    expect(isCleanInvoice(inv({ flagged_lines: 1 }))).toBe(false);
  });
});

describe('buildSupplierQuality', () => {
  const rows = (): QualityInvoiceRow[] => [
    // Ромашка: 4 накладные с ИНН (самая свежая — первая по дате) …
    inv({ created_at: '2026-09-20 10:00:00', sent_at: null, line_count: 10, card_name: 'ООО Ромашка (карточка)' }),
    inv({ created_at: '2026-09-18 10:00:00', sent_at: '2026-09-19 10:00:00', line_count: 10 }),
    inv({ created_at: '2026-09-15 10:00:00', sent_at: '2026-09-18 10:00:00', line_count: 10, edited_lines: 2, flagged_lines: 1 }),
    inv({ created_at: '2026-09-10 10:00:00', sent_at: '2026-09-12 10:00:00', line_count: 10, header_edits: 1, unmapped_lines: 1, low_conf_lines: 1 }),
    // … и одна без ИНН, но с тем же названием — должна прийти к ней же
    inv({ created_at: '2026-09-05 10:00:00', supplier_inn: null, supplier: 'Ромашка ООО', sent_at: '2026-09-06 10:00:00', line_count: 10, total_sum: 500 }),
    // Лютик: одна накладная без ИНН — мало данных для вывода
    inv({ created_at: '2026-09-21 10:00:00', supplier_inn: null, supplier: 'ИП Лютик', line_count: 4, edited_lines: 4, total_sum: 300 }),
  ];

  it('группирует по ИНН, подтягивает накладную без ИНН по названию', () => {
    const { suppliers } = buildSupplierQuality(rows());
    expect(suppliers.map(s => s.key)).toEqual(['inn:7707083893', 'name:лютик']);
    const r = suppliers[0];
    expect(r.name).toBe('ООО Ромашка (карточка)');
    expect(r.inn).toBe('7707083893');
    expect(r.invoices).toBe(5);
    expect(r.lines).toBe(50);
    expect(r.total_sum).toBe(4500);
  });

  it('доли строк, шапки, отправки и медиана дней до 1С', () => {
    const r = buildSupplierQuality(rows()).suppliers[0];
    expect(r.flagged_lines).toBe(1);
    expect(r.flagged_share).toBeCloseTo(0.02);
    expect(r.edited_lines).toBe(2);
    expect(r.edited_share).toBeCloseTo(0.04);
    expect(r.unmapped_lines).toBe(1);
    expect(r.low_conf_lines).toBe(1);
    expect(r.mapping_issue_share).toBeCloseTo(0.04);
    expect(r.header_edited_invoices).toBe(1);
    expect(r.header_edit_share).toBeCloseTo(0.2);
    expect(r.sent_invoices).toBe(4);
    expect(r.sent_share).toBeCloseTo(0.8);
    // 1, 3, 2, 1 день → медиана 1,5
    expect(r.median_days_to_1c).toBe(1.5);
    expect(r.first_invoice_at).toBe('2026-09-05 10:00:00');
    expect(r.last_invoice_at).toBe('2026-09-20 10:00:00');
  });

  it('серия «подряд без правок» — с самой свежей до первой правки', () => {
    const r = buildSupplierQuality(rows()).suppliers[0];
    expect(r.clean_streak).toBe(2);
    expect(r.recent_invoices.map(x => x.clean)).toEqual([true, true, false, false, true]);
    expect(r.recent_invoices[0].created_at).toBe('2026-09-20 10:00:00');
  });

  it('подсказки и общий вывод; меньше трёх накладных — без вывода', () => {
    const [r, few] = buildSupplierQuality(rows()).suppliers;
    expect(r.tones).toEqual({
      flagged: 'good',   // 2% — на границе нормы
      edited: 'good',    // 4%
      mapping: 'good',   // 4%
      header: 'warn',    // 20%
      sent: 'warn',      // 80%
      days: 'good',      // 1,5 дня
      streak: 'warn',    // 2 подряд
    });
    expect(r.verdict).toBe('warn');
    expect(few.invoices).toBeLessThan(MIN_INVOICES_FOR_VERDICT);
    expect(few.verdict).toBeNull();
    expect(few.tones.streak).toBeNull();
    expect(few.tones.edited).toBe('bad'); // 4 из 4 строк
    expect(few.name).toBe('ИП Лютик');
  });

  it('итоги по компании', () => {
    const { totals } = buildSupplierQuality(rows());
    expect(totals).toMatchObject({
      suppliers: 2, invoices: 6, lines: 54,
      flagged_lines: 1, edited_lines: 6, mapping_issue_lines: 2,
      header_edited_invoices: 1, sent_invoices: 4, total_sum: 4800,
    });
    expect(totals.sent_share).toBeCloseTo(4 / 6);
    expect(totals.median_days_to_1c).toBe(1.5);
  });

  it('пустой период — пустой отчёт без деления на ноль', () => {
    const { totals, suppliers } = buildSupplierQuality([]);
    expect(suppliers).toEqual([]);
    expect(totals.invoices).toBe(0);
    expect(totals.edited_share).toBeNull();
    expect(totals.median_days_to_1c).toBeNull();
  });

  it('накладная без строк не ломает доли', () => {
    const r = buildSupplierQuality([inv({ line_count: 0 })]).suppliers[0];
    expect(r.edited_share).toBeNull();
    expect(r.tones.edited).toBeNull();
  });
});

describe('SQL — только компания вызывающего', () => {
  it('loadQualityRows: владелец в обоих местах запроса, период — в INTERVAL', async () => {
    allMock.mockResolvedValue([]);
    await loadQualityRows(7, 30);
    const sql = String(prepareMock.mock.calls[0][0]);
    expect(allMock).toHaveBeenCalledWith(7, 7);
    expect(sql).toMatch(/f\.owner_user_id = \?/);
    expect(sql).toMatch(/i\.owner_user_id = \?/);
    expect(sql).toMatch(/INTERVAL 30 DAY/);
    expect(sql).toMatch(/i\.status IN \('processed', 'sent_to_1c'\)/);
    expect(sql).toMatch(/duplicate_of IS NULL/);
    // LINES — зарезервированное слово MySQL/MariaDB: «AS lines» — синтаксическая ошибка
    expect(sql).not.toMatch(/\bAS\s+lines\b/i);
    expect(sql).not.toMatch(/\.lines\b/);
  });

  it('getSupplierQuality отдаёт период, пороги и отчёт', async () => {
    allMock.mockResolvedValue([inv({})]);
    const r = await getSupplierQuality(3, 90);
    expect(allMock).toHaveBeenCalledWith(3, 3);
    expect(r.period_days).toBe(90);
    expect(r.thresholds.edited).toEqual({ good: 0.05, warn: 0.15 });
    expect(r.suppliers).toHaveLength(1);
    expect(r.truncated).toBe(false);
  });
});
