/**
 * Аналитика, вкладка «Поставщики» (п.7): отчёт качества накладных по каждому
 * поставщику компании за период.
 *
 * SQL отдаёт по строке на накладную (счётчики строк и правок), а группировка по
 * поставщику, медиана «дней до 1С», серия «без правок» и цветовые подсказки —
 * в чистой buildSupplierQuality (её и проверяют тесты без БД).
 *
 * Что считается (всё — по распознанным накладным компании: processed /
 * sent_to_1c, без дублей, загружены за период):
 *   • «пересчёт под вопросом» — строки с флагом пересчёта единиц (qty_flag);
 *   • «правили руками» — строка есть в журнале правок (edit_log, entity='item')
 *     ИЛИ количество исправлено вручную (conv_source='manual') ИЛИ задано своё
 *     название (name_overridden). Журнал ведётся только с 29.09.2026, поэтому
 *     два последних признака — чтобы старые накладные не выглядели «чистыми»;
 *   • «без позиции 1С / неуверенно» — нет onec_guid или уверенность < 0,8;
 *   • «правки шапки» — накладные с правкой номера/даты/суммы/реквизитов
 *     (edit_log, entity='invoice'); откат из снимка правкой не считается;
 *   • «ушло в 1С» — есть sent_at; «дней до 1С» — медиана sent_at − created_at;
 *   • «подряд без правок» — сколько последних накладных подряд обошлись без
 *     единой ручной правки и без строк с сомнительным пересчётом.
 */
import { getDb } from '../database/db';
import {
  type AnalyticsPeriod,
  type Tone,
  buildSupplierKeyResolver,
  cleanStreak,
  medianDaysToSend,
  roundTo,
  share,
  toneHigherBetter,
  toneLowerBetter,
  worstTone,
} from './analyticsMath';

/** Пороги подсказок: доли — 0…1, дни — медиана, серия — число накладных. */
export const QUALITY_THRESHOLDS = {
  flagged: { good: 0.02, warn: 0.10 },   // меньше — лучше
  edited: { good: 0.05, warn: 0.15 },    // меньше — лучше
  mapping: { good: 0.05, warn: 0.20 },   // меньше — лучше
  header: { good: 0.10, warn: 0.30 },    // меньше — лучше
  sent: { good: 0.90, warn: 0.60 },      // больше — лучше
  days: { good: 2, warn: 7 },            // меньше — лучше
  streak: { good: 5, warn: 2 },          // больше — лучше
} as const;

/** Меньше стольких накладных — вывод «мало данных», а не «хорошо/плохо». */
export const MIN_INVOICES_FOR_VERDICT = 3;

const MAX_INVOICES = 5000;
const MAX_SUPPLIERS = 200;
const RECENT_PER_SUPPLIER = 10;

/** Строка SQL: одна накладная со счётчиками. */
export interface QualityInvoiceRow {
  id: number;
  invoice_number: string | null;
  invoice_date: string | null;
  supplier: string | null;
  supplier_inn: string | null;
  card_name: string | null;
  total_sum: number | null;
  status: string;
  created_at: string;
  sent_at: string | null;
  /** Строк в накладной. Не `lines`: LINES — зарезервированное слово MySQL/MariaDB. */
  line_count: number;
  flagged_lines: number;
  edited_lines: number;
  unmapped_lines: number;
  low_conf_lines: number;
  item_edit_rows: number;
  header_edits: number;
}

export interface RecentInvoice {
  id: number;
  invoice_number: string | null;
  invoice_date: string | null;
  created_at: string;
  total_sum: number | null;
  lines: number;
  flagged_lines: number;
  edited_lines: number;
  header_edits: number;
  sent_at: string | null;
  clean: boolean;
}

export interface QualityTones {
  flagged: Tone | null;
  edited: Tone | null;
  mapping: Tone | null;
  header: Tone | null;
  sent: Tone | null;
  days: Tone | null;
  streak: Tone | null;
}

export interface SupplierQuality {
  key: string;
  inn: string | null;
  name: string;
  invoices: number;
  lines: number;
  flagged_lines: number;
  flagged_share: number | null;
  edited_lines: number;
  edited_share: number | null;
  unmapped_lines: number;
  low_conf_lines: number;
  mapping_issue_share: number | null;
  header_edited_invoices: number;
  header_edits: number;
  header_edit_share: number | null;
  sent_invoices: number;
  sent_share: number | null;
  median_days_to_1c: number | null;
  clean_streak: number;
  total_sum: number;
  first_invoice_at: string;
  last_invoice_at: string;
  tones: QualityTones;
  /** Общий вывод по качеству распознавания; null — мало накладных для вывода. */
  verdict: Tone | null;
  recent_invoices: RecentInvoice[];
}

export interface QualityTotals {
  suppliers: number;
  invoices: number;
  lines: number;
  flagged_lines: number;
  flagged_share: number | null;
  edited_lines: number;
  edited_share: number | null;
  mapping_issue_lines: number;
  mapping_issue_share: number | null;
  header_edited_invoices: number;
  header_edit_share: number | null;
  sent_invoices: number;
  sent_share: number | null;
  median_days_to_1c: number | null;
  total_sum: number;
}

export interface SupplierQualityReport {
  totals: QualityTotals;
  suppliers: SupplierQuality[];
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Накладная «без правок»: ни одной ручной правки строк и шапки, ни одного флага пересчёта. */
export function isCleanInvoice(r: Pick<QualityInvoiceRow, 'edited_lines' | 'item_edit_rows' | 'header_edits' | 'flagged_lines'>): boolean {
  return num(r.edited_lines) === 0 && num(r.item_edit_rows) === 0 && num(r.header_edits) === 0 && num(r.flagged_lines) === 0;
}

function tonesFor(s: Omit<SupplierQuality, 'tones' | 'verdict' | 'recent_invoices'>): QualityTones {
  const T = QUALITY_THRESHOLDS;
  const enough = s.invoices >= MIN_INVOICES_FOR_VERDICT;
  return {
    flagged: toneLowerBetter(s.flagged_share, T.flagged.good, T.flagged.warn),
    edited: toneLowerBetter(s.edited_share, T.edited.good, T.edited.warn),
    mapping: toneLowerBetter(s.mapping_issue_share, T.mapping.good, T.mapping.warn),
    header: toneLowerBetter(s.header_edit_share, T.header.good, T.header.warn),
    sent: toneHigherBetter(s.sent_share, T.sent.good, T.sent.warn),
    days: toneLowerBetter(s.median_days_to_1c, T.days.good, T.days.warn),
    // Серия у поставщика с одной-двумя накладными ничего не говорит.
    streak: enough ? toneHigherBetter(s.clean_streak, T.streak.good, T.streak.warn) : null,
  };
}

/**
 * Сгруппировать накладные по поставщику и посчитать показатели. `rows` —
 * накладные компании за период в любом порядке.
 */
export function buildSupplierQuality(rows: readonly QualityInvoiceRow[]): SupplierQualityReport {
  const keyOf = buildSupplierKeyResolver(rows);
  const groups = new Map<string, QualityInvoiceRow[]>();
  for (const r of rows) {
    const k = keyOf(r);
    const list = groups.get(k) ?? [];
    list.push(r);
    groups.set(k, list);
  }

  const newestFirst = (a: QualityInvoiceRow, b: QualityInvoiceRow): number =>
    (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id);

  const suppliers: SupplierQuality[] = [];
  for (const [key, list] of groups) {
    list.sort(newestFirst);
    const inn = key.startsWith('inn:') ? key.slice(4) : null;
    const name = list.find(r => r.card_name && r.card_name.trim())?.card_name?.trim()
      || list.find(r => r.supplier && r.supplier.trim())?.supplier?.trim()
      || (inn ? `ИНН ${inn}` : 'Поставщик не указан');

    const lines = list.reduce((s, r) => s + num(r.line_count), 0);
    const flagged = list.reduce((s, r) => s + num(r.flagged_lines), 0);
    const edited = list.reduce((s, r) => s + num(r.edited_lines), 0);
    const unmapped = list.reduce((s, r) => s + num(r.unmapped_lines), 0);
    const lowConf = list.reduce((s, r) => s + num(r.low_conf_lines), 0);
    const headerEdits = list.reduce((s, r) => s + num(r.header_edits), 0);
    const headerInvoices = list.filter(r => num(r.header_edits) > 0).length;
    const sent = list.filter(r => !!r.sent_at);

    const base = {
      key,
      inn,
      name,
      invoices: list.length,
      lines,
      flagged_lines: flagged,
      flagged_share: share(flagged, lines),
      edited_lines: edited,
      edited_share: share(edited, lines),
      unmapped_lines: unmapped,
      low_conf_lines: lowConf,
      mapping_issue_share: share(unmapped + lowConf, lines),
      header_edited_invoices: headerInvoices,
      header_edits: headerEdits,
      header_edit_share: share(headerInvoices, list.length),
      sent_invoices: sent.length,
      sent_share: share(sent.length, list.length),
      median_days_to_1c: roundTo(medianDaysToSend(sent), 1),
      clean_streak: cleanStreak(list, isCleanInvoice),
      total_sum: roundTo(list.reduce((s, r) => s + num(r.total_sum), 0), 2) ?? 0,
      first_invoice_at: list[list.length - 1].created_at,
      last_invoice_at: list[0].created_at,
    };
    const tones = tonesFor(base);
    suppliers.push({
      ...base,
      tones,
      verdict: base.invoices >= MIN_INVOICES_FOR_VERDICT
        ? worstTone([tones.flagged, tones.edited, tones.mapping, tones.header])
        : null,
      recent_invoices: list.slice(0, RECENT_PER_SUPPLIER).map(r => ({
        id: r.id,
        invoice_number: r.invoice_number,
        invoice_date: r.invoice_date,
        created_at: r.created_at,
        total_sum: r.total_sum,
        lines: num(r.line_count),
        flagged_lines: num(r.flagged_lines),
        edited_lines: num(r.edited_lines),
        header_edits: num(r.header_edits),
        sent_at: r.sent_at,
        clean: isCleanInvoice(r),
      })),
    });
  }

  suppliers.sort((a, b) => b.invoices - a.invoices || b.total_sum - a.total_sum || a.name.localeCompare(b.name, 'ru'));

  const lines = rows.reduce((s, r) => s + num(r.line_count), 0);
  const flagged = rows.reduce((s, r) => s + num(r.flagged_lines), 0);
  const edited = rows.reduce((s, r) => s + num(r.edited_lines), 0);
  const mappingIssues = rows.reduce((s, r) => s + num(r.unmapped_lines) + num(r.low_conf_lines), 0);
  const headerInvoices = rows.filter(r => num(r.header_edits) > 0).length;
  const sent = rows.filter(r => !!r.sent_at);
  return {
    totals: {
      suppliers: suppliers.length,
      invoices: rows.length,
      lines,
      flagged_lines: flagged,
      flagged_share: share(flagged, lines),
      edited_lines: edited,
      edited_share: share(edited, lines),
      mapping_issue_lines: mappingIssues,
      mapping_issue_share: share(mappingIssues, lines),
      header_edited_invoices: headerInvoices,
      header_edit_share: share(headerInvoices, rows.length),
      sent_invoices: sent.length,
      sent_share: share(sent.length, rows.length),
      median_days_to_1c: roundTo(medianDaysToSend(sent), 1),
      total_sum: roundTo(rows.reduce((s, r) => s + num(r.total_sum), 0), 2) ?? 0,
    },
    suppliers: suppliers.slice(0, MAX_SUPPLIERS),
  };
}

/**
 * Накладные компании за период со счётчиками. Строки агрегируются одним
 * производным запросом по invoice_items (индекс invoice_id), журнал правок —
 * коррелированными подзапросами по idx_edit_log_invoice. GROUP BY — только по
 * колонке группировки: так запрос одинаково работает на MySQL 9.6 и MariaDB
 * 10.11 при любом sql_mode.
 */
export async function loadQualityRows(ownerUserId: number, days: AnalyticsPeriod): Promise<QualityInvoiceRow[]> {
  const d = Math.max(1, Math.min(366, Math.trunc(days)));
  const rows = await getDb().prepare(`
    SELECT i.id, i.invoice_number, i.invoice_date, i.supplier, i.supplier_inn,
           sc.name AS card_name,
           i.total_sum, i.status, i.created_at, i.sent_at,
           COALESCE(a.line_count, 0) AS line_count,
           COALESCE(a.flagged, 0)  AS flagged_lines,
           COALESCE(a.edited, 0)   AS edited_lines,
           COALESCE(a.unmapped, 0) AS unmapped_lines,
           COALESCE(a.low_conf, 0) AS low_conf_lines,
           (SELECT COUNT(*) FROM edit_log e
             WHERE e.invoice_id = i.id AND e.entity = 'item') AS item_edit_rows,
           (SELECT COUNT(*) FROM edit_log e
             WHERE e.invoice_id = i.id AND e.entity = 'invoice'
               AND (e.context IS NULL OR e.context NOT LIKE '%restored_from%')) AS header_edits
      FROM invoices i
      LEFT JOIN supplier_cards sc
             ON sc.owner_user_id = i.owner_user_id AND sc.inn = i.supplier_inn
      LEFT JOIN (
        SELECT ii.invoice_id,
               COUNT(*) AS line_count,
               SUM(CASE WHEN ii.qty_flag IS NOT NULL AND ii.qty_flag <> '' THEN 1 ELSE 0 END) AS flagged,
               SUM(CASE WHEN ii.conv_source = 'manual' OR ii.name_overridden = 1
                          OR EXISTS (SELECT 1 FROM edit_log e
                                      WHERE e.invoice_id = ii.invoice_id AND e.item_id = ii.id
                                        AND e.entity = 'item')
                        THEN 1 ELSE 0 END) AS edited,
               SUM(CASE WHEN ii.onec_guid IS NULL OR ii.onec_guid = '' THEN 1 ELSE 0 END) AS unmapped,
               SUM(CASE WHEN ii.onec_guid IS NOT NULL AND ii.onec_guid <> ''
                         AND COALESCE(ii.mapping_confidence, 0) < 0.8 THEN 1 ELSE 0 END) AS low_conf
          FROM invoice_items ii
          JOIN invoices f ON f.id = ii.invoice_id
         WHERE f.owner_user_id = ?
           AND f.created_at >= (NOW() - INTERVAL ${d} DAY)
         GROUP BY ii.invoice_id
      ) a ON a.invoice_id = i.id
     WHERE i.owner_user_id = ?
       AND i.created_at >= (NOW() - INTERVAL ${d} DAY)
       AND i.status IN ('processed', 'sent_to_1c')
       AND i.duplicate_of IS NULL
     ORDER BY i.created_at DESC, i.id DESC
     LIMIT ${MAX_INVOICES}
  `).all<QualityInvoiceRow>(ownerUserId, ownerUserId);
  return rows;
}

export async function getSupplierQuality(ownerUserId: number, days: AnalyticsPeriod): Promise<SupplierQualityReport & {
  period_days: AnalyticsPeriod;
  generated_at: string;
  thresholds: typeof QUALITY_THRESHOLDS;
  min_invoices_for_verdict: number;
  truncated: boolean;
}> {
  const rows = await loadQualityRows(ownerUserId, days);
  return {
    period_days: days,
    generated_at: new Date().toISOString(),
    thresholds: QUALITY_THRESHOLDS,
    min_invoices_for_verdict: MIN_INVOICES_FOR_VERDICT,
    truncated: rows.length >= MAX_INVOICES,
    ...buildSupplierQuality(rows),
  };
}
