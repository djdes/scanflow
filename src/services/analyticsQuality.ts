/**
 * Аналитика, «Качество поставщиков» (п.7): как часто накладные каждого
 * поставщика компании приходится исправлять руками — за период.
 *
 * SQL отдаёт по строке на накладную (счётчики строк и правок) и строки «как
 * напечатано» для проверки сдвига; группировка по поставщику, доли, медиана
 * «дней до 1С», серия «без правок», подсказки и порядок «сначала худшие» — в
 * чистой buildSupplierQuality (её и проверяют тесты без БД).
 *
 * Берутся распознанные накладные компании (processed / sent_to_1c, без дублей),
 * загруженные за период. Показатели:
 *   • «правили строки» — у строки исправляли распознанное: количество, единицу,
 *     цену, сумму, ставку НДС, пересчёт (журнал правок, entity='item'), или
 *     строка ручная (conv_source='manual': своё количество, «как в накладной»,
 *     добавлена руками), или строку удалили (лишняя, «Итого» как товар). Своё
 *     название для 1С и выбор позиции — не исправление распознанного: это
 *     сопоставление, у него свой показатель;
 *   • «пересчёт под вопросом» — строки с флагом пересчёта единиц (qty_flag);
 *   • «правили шапку» — номер, дату, поставщика, реквизиты, сумму, НДС (журнал
 *     правок, entity='invoice'); откат из снимка и сумма платёжки Сбера — нет;
 *   • «сумма не сходится» — сумма строк расходится с итогом (items_total_mismatch);
 *   • «строки сдвинуты» — признаки сдвига названий относительно чисел по
 *     сохранённым строкам: rowAlignmentProblems, та же проверка, что держит
 *     автопилот (rows_misaligned). Проверку цен по истории (priceShiftProblems)
 *     для отчёта не зовём — она ходит в БД за историей по каждой накладной;
 *   • «без позиции 1С / неуверенно» — нет onec_guid или уверенность < 0,8;
 *   • «ушло в 1С» — есть sent_at; «дней до 1С» — медиана sent_at − created_at.
 *
 * Журнал правок и флаги пересчёта появились вместе (миграции 64 и 67, пакет v2).
 * Накладные, загруженные раньше, в долях правок и флагов не участвуют: отсутствие
 * записей там — не «правок не было», а «правки не записывались». Момент начала —
 * applied_at этих миграций в migration_history (tracking_since в ответе).
 */
import { getDb } from '../database/db';
import { rowAlignmentProblems } from '../ocr/invoiceValidator';
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
  edited: { good: 0.05, warn: 0.15 },     // меньше — лучше, доля строк
  flagged: { good: 0.02, warn: 0.10 },    // меньше — лучше, доля строк
  header: { good: 0.10, warn: 0.30 },     // меньше — лучше, доля накладных
  mismatch: { good: 0.05, warn: 0.15 },   // меньше — лучше, доля накладных
  misaligned: { good: 0.02, warn: 0.10 }, // меньше — лучше, доля накладных
  mapping: { good: 0.05, warn: 0.20 },    // меньше — лучше, доля строк
  sent: { good: 0.90, warn: 0.60 },       // больше — лучше
  days: { good: 2, warn: 7 },             // меньше — лучше
  streak: { good: 5, warn: 2 },           // больше — лучше
} as const;

/** Показатели, из которых складывается общий вывод и порядок «сначала худшие». */
export const VERDICT_METRICS = ['edited', 'flagged', 'header', 'mismatch', 'misaligned', 'mapping'] as const;
type VerdictMetric = (typeof VERDICT_METRICS)[number];

/** Меньше стольких накладных — вывод «мало данных», а не «хорошо/плохо». */
export const MIN_INVOICES_FOR_VERDICT = 3;

/** Правки строки, которые исправляют распознанное (edit_log.field при entity='item'). */
export const ITEM_FIX_FIELDS = ['quantity', 'unit', 'price', 'total', 'vat_rate', 'reconvert', 'revert_raw'] as const;
/** Всё, что говорит «с этой накладной работали руками» по строкам (в т.ч. удаление и НДС всем строкам). */
export const ITEM_WORK_FIELDS = [...ITEM_FIX_FIELDS, 'added', 'deleted', 'vat_rate_all'] as const;
/** Поля шапки, правка которых — исправление распознанного (edit_log.field при entity='invoice'). */
export const HEADER_FIX_FIELDS = [
  'invoice_number', 'invoice_type', 'invoice_date', 'supplier', 'supplier_inn', 'supplier_kpp',
  'supplier_bik', 'supplier_account', 'supplier_corr_account', 'supplier_address', 'total_sum', 'vat_sum',
] as const;

const MAX_INVOICES = 5000;
const MAX_ITEM_ROWS = 100_000;
const MAX_SUPPLIERS = 200;
const RECENT_PER_SUPPLIER = 10;
/** Миграции, с которых ведутся журнал правок (64) и флаги пересчёта (67). */
const TRACKING_MIGRATIONS = [64, 67];

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
  items_total_mismatch: number;
  /** Строк в накладной. Не `lines`: LINES — зарезервированное слово MySQL/MariaDB. */
  line_count: number;
  flagged_lines: number;
  edited_lines: number;
  deleted_lines: number;
  unmapped_lines: number;
  low_conf_lines: number;
  item_edit_rows: number;
  header_edits: number;
}

/** Строка SQL для проверки сдвига: значения «как напечатано». */
export interface QualityItemRow {
  invoice_id: number;
  original_name: string | null;
  q: number | null;
  u: string | null;
  p: number | null;
  t: number | null;
  row_no: number | null;
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
  deleted_lines: number;
  header_edits: number;
  mismatch: boolean;
  misaligned: boolean;
  sent_at: string | null;
  /** Загружена после начала журнала правок — правки и флаги по ней известны. */
  tracked: boolean;
  /** true — ни одной правки и проблемы; false — были; null — правки не записывались, проблем не видно. */
  clean: boolean | null;
}

export type QualityTones = Record<VerdictMetric | 'sent' | 'days' | 'streak', Tone | null>;

export interface SupplierQuality {
  key: string;
  inn: string | null;
  name: string;
  /** Что искать в списке накладных, чтобы увидеть все накладные поставщика. */
  search: string;
  invoices: number;
  tracked_invoices: number;
  lines: number;
  tracked_lines: number;
  edited_lines: number;
  deleted_lines: number;
  edited_share: number | null;
  flagged_lines: number;
  flagged_share: number | null;
  header_edited_invoices: number;
  header_edits: number;
  header_edit_share: number | null;
  mismatch_invoices: number;
  mismatch_share: number | null;
  misaligned_invoices: number;
  misaligned_share: number | null;
  unmapped_lines: number;
  low_conf_lines: number;
  mapping_issue_share: number | null;
  sent_invoices: number;
  sent_share: number | null;
  median_days_to_1c: number | null;
  /** Сколько последних накладных (из загруженных после начала журнала) подряд — без правок и проблем. */
  clean_streak: number | null;
  total_sum: number;
  first_invoice_at: string;
  last_invoice_at: string;
  tones: QualityTones;
  /** Общий вывод по качеству распознавания; null — мало накладных для вывода. */
  verdict: Tone | null;
  /** Чем больше, тем хуже: сумма показателей в долях их порога «присмотреться». */
  worst_score: number;
  recent_invoices: RecentInvoice[];
}

export interface QualityTotals {
  suppliers: number;
  invoices: number;
  tracked_invoices: number;
  lines: number;
  tracked_lines: number;
  edited_lines: number;
  deleted_lines: number;
  edited_share: number | null;
  flagged_lines: number;
  flagged_share: number | null;
  header_edited_invoices: number;
  header_edit_share: number | null;
  mismatch_invoices: number;
  mismatch_share: number | null;
  misaligned_invoices: number;
  misaligned_share: number | null;
  unmapped_lines: number;
  mapping_issue_lines: number;
  mapping_issue_share: number | null;
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

/** Накладная загружена, когда правки уже записывались. Даты — строки БД одного формата. */
export function isTracked(createdAt: string, trackingSince: string | null): boolean {
  return trackingSince == null || String(createdAt) >= trackingSince;
}

/** Есть проблемы, видные по данным самой накладной (без журнала правок). */
function hasVisibleProblem(r: QualityInvoiceRow, misaligned: ReadonlySet<number>): boolean {
  return num(r.items_total_mismatch) === 1 || misaligned.has(r.id);
}

/** Накладная «без правок»: ни одной ручной правки строк и шапки, ни флага пересчёта, ни видимой проблемы. */
export function isCleanInvoice(
  r: Pick<QualityInvoiceRow, 'edited_lines' | 'deleted_lines' | 'item_edit_rows' | 'header_edits' | 'flagged_lines' | 'items_total_mismatch'>,
  misaligned = false,
): boolean {
  return num(r.edited_lines) === 0 && num(r.deleted_lines) === 0 && num(r.item_edit_rows) === 0
    && num(r.header_edits) === 0 && num(r.flagged_lines) === 0 && num(r.items_total_mismatch) !== 1 && !misaligned;
}

/**
 * Сдвиг названий относительно чисел по сохранённым строкам — как
 * storedAlignmentProblems в src/automation/qualityGate.ts (значения «как
 * напечатано», 0 = «нет числа», порядок — по номеру строки), но для всех
 * накладных отчёта одним запросом. `rows` отсортированы по накладной и порядку.
 */
export function misalignedInvoiceIds(rows: readonly QualityItemRow[]): Set<number> {
  const byInvoice = new Map<number, QualityItemRow[]>();
  for (const r of rows) {
    const list = byInvoice.get(r.invoice_id) ?? [];
    list.push(r);
    byInvoice.set(r.invoice_id, list);
  }
  const numOrUndef = (v: unknown): number | undefined => (v == null || Number(v) === 0 || !Number.isFinite(Number(v)) ? undefined : Number(v));
  const out = new Set<number>();
  for (const [id, list] of byInvoice) {
    const items = list.map(r => ({
      name: String(r.original_name ?? ''),
      quantity: numOrUndef(r.q),
      unit: r.u ?? undefined,
      price: numOrUndef(r.p),
      total: numOrUndef(r.t),
      row_no: numOrUndef(r.row_no),
    }));
    if (rowAlignmentProblems(items).length > 0) out.add(id);
  }
  return out;
}

const VERDICT_RANK: Record<Tone, number> = { bad: 3, warn: 2, good: 1 };

type SupplierBase = Omit<SupplierQuality, 'tones' | 'verdict' | 'worst_score' | 'recent_invoices'>;

function metricValue(s: SupplierBase, m: VerdictMetric): number | null {
  switch (m) {
    case 'edited': return s.edited_share;
    case 'flagged': return s.flagged_share;
    case 'header': return s.header_edit_share;
    case 'mismatch': return s.mismatch_share;
    case 'misaligned': return s.misaligned_share;
    case 'mapping': return s.mapping_issue_share;
  }
}

function tonesFor(s: SupplierBase): QualityTones {
  const T = QUALITY_THRESHOLDS;
  const lower = (m: VerdictMetric) => toneLowerBetter(metricValue(s, m), T[m].good, T[m].warn);
  return {
    edited: lower('edited'),
    flagged: lower('flagged'),
    header: lower('header'),
    mismatch: lower('mismatch'),
    misaligned: lower('misaligned'),
    mapping: lower('mapping'),
    sent: toneHigherBetter(s.sent_share, T.sent.good, T.sent.warn),
    days: toneLowerBetter(s.median_days_to_1c, T.days.good, T.days.warn),
    // Серия по одной-двум накладным ничего не говорит.
    streak: s.clean_streak != null && s.tracked_invoices >= MIN_INVOICES_FOR_VERDICT
      ? toneHigherBetter(s.clean_streak, T.streak.good, T.streak.warn)
      : null,
  };
}

/** Сумма показателей в долях порога «присмотреться» (каждый — не больше 3): порядок внутри одного вывода. */
export function worstScore(s: SupplierBase): number {
  let score = 0;
  for (const m of VERDICT_METRICS) {
    const v = metricValue(s, m);
    if (v == null || !Number.isFinite(v)) continue;
    score += Math.min(3, v / QUALITY_THRESHOLDS[m].warn);
  }
  return roundTo(score, 3) ?? 0;
}

/** «Сначала худшие»: вывод (проблема → присмотреться → норма → мало данных), затем баллы, затем объём. */
export function compareWorstFirst(a: SupplierQuality, b: SupplierQuality): number {
  const ra = a.verdict ? VERDICT_RANK[a.verdict] : 0;
  const rb = b.verdict ? VERDICT_RANK[b.verdict] : 0;
  return rb - ra || b.worst_score - a.worst_score || b.invoices - a.invoices || a.name.localeCompare(b.name, 'ru');
}

interface Aggregate {
  invoices: number;
  tracked_invoices: number;
  lines: number;
  tracked_lines: number;
  edited_lines: number;
  deleted_lines: number;
  flagged_lines: number;
  header_edited_invoices: number;
  header_edits: number;
  mismatch_invoices: number;
  misaligned_invoices: number;
  unmapped_lines: number;
  low_conf_lines: number;
  sent: QualityInvoiceRow[];
  total_sum: number;
}

function aggregate(list: readonly QualityInvoiceRow[], trackingSince: string | null, misaligned: ReadonlySet<number>): Aggregate {
  const a: Aggregate = {
    invoices: list.length, tracked_invoices: 0, lines: 0, tracked_lines: 0, edited_lines: 0, deleted_lines: 0,
    flagged_lines: 0, header_edited_invoices: 0, header_edits: 0, mismatch_invoices: 0, misaligned_invoices: 0,
    unmapped_lines: 0, low_conf_lines: 0, sent: [], total_sum: 0,
  };
  for (const r of list) {
    const lines = num(r.line_count);
    a.lines += lines;
    a.unmapped_lines += num(r.unmapped_lines);
    a.low_conf_lines += num(r.low_conf_lines);
    if (num(r.items_total_mismatch) === 1) a.mismatch_invoices++;
    if (misaligned.has(r.id)) a.misaligned_invoices++;
    if (r.sent_at) a.sent.push(r);
    a.total_sum += num(r.total_sum);
    if (!isTracked(r.created_at, trackingSince)) continue;
    a.tracked_invoices++;
    a.tracked_lines += lines;
    a.edited_lines += num(r.edited_lines);
    a.deleted_lines += num(r.deleted_lines);
    a.flagged_lines += num(r.flagged_lines);
    a.header_edits += num(r.header_edits);
    if (num(r.header_edits) > 0) a.header_edited_invoices++;
  }
  return a;
}

/** Доля строк, которые правили: удалённые строки тоже были распознаны — они и в числителе, и в знаменателе. */
function editedShare(a: Aggregate): number | null {
  return share(a.edited_lines + a.deleted_lines, a.tracked_lines + a.deleted_lines);
}

/**
 * Сгруппировать накладные по поставщику и посчитать показатели. `rows` —
 * накладные компании за период в любом порядке; `misaligned` — id накладных
 * с признаками сдвига строк; `trackingSince` — с какого момента ведётся журнал
 * правок (null — с самого начала).
 */
export function buildSupplierQuality(
  rows: readonly QualityInvoiceRow[],
  opts: { trackingSince?: string | null; misaligned?: ReadonlySet<number> } = {},
): SupplierQualityReport {
  const trackingSince = opts.trackingSince ?? null;
  const misaligned = opts.misaligned ?? new Set<number>();
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
  const cleanOf = (r: QualityInvoiceRow): boolean => isCleanInvoice(r, misaligned.has(r.id));

  const suppliers: SupplierQuality[] = [];
  for (const [key, list] of groups) {
    list.sort(newestFirst);
    const inn = key.startsWith('inn:') ? key.slice(4) : null;
    const name = list.find(r => r.card_name && r.card_name.trim())?.card_name?.trim()
      || list.find(r => r.supplier && r.supplier.trim())?.supplier?.trim()
      || (inn ? `ИНН ${inn}` : 'Поставщик не указан');
    const a = aggregate(list, trackingSince, misaligned);
    const tracked = list.filter(r => isTracked(r.created_at, trackingSince));

    const base: SupplierBase = {
      key,
      inn,
      name,
      search: inn ?? (list.find(r => r.supplier && r.supplier.trim())?.supplier?.trim() ?? ''),
      invoices: a.invoices,
      tracked_invoices: a.tracked_invoices,
      lines: a.lines,
      tracked_lines: a.tracked_lines,
      edited_lines: a.edited_lines,
      deleted_lines: a.deleted_lines,
      edited_share: editedShare(a),
      flagged_lines: a.flagged_lines,
      flagged_share: share(a.flagged_lines, a.tracked_lines),
      header_edited_invoices: a.header_edited_invoices,
      header_edits: a.header_edits,
      header_edit_share: share(a.header_edited_invoices, a.tracked_invoices),
      mismatch_invoices: a.mismatch_invoices,
      mismatch_share: share(a.mismatch_invoices, a.invoices),
      misaligned_invoices: a.misaligned_invoices,
      misaligned_share: share(a.misaligned_invoices, a.invoices),
      unmapped_lines: a.unmapped_lines,
      low_conf_lines: a.low_conf_lines,
      mapping_issue_share: share(a.unmapped_lines + a.low_conf_lines, a.lines),
      sent_invoices: a.sent.length,
      sent_share: share(a.sent.length, a.invoices),
      median_days_to_1c: roundTo(medianDaysToSend(a.sent), 1),
      clean_streak: tracked.length ? cleanStreak(tracked, cleanOf) : null,
      total_sum: roundTo(a.total_sum, 2) ?? 0,
      first_invoice_at: list[list.length - 1].created_at,
      last_invoice_at: list[0].created_at,
    };
    const tones = tonesFor(base);
    const enough = base.invoices >= MIN_INVOICES_FOR_VERDICT;
    suppliers.push({
      ...base,
      tones,
      verdict: enough ? worstTone(VERDICT_METRICS.map(m => tones[m])) : null,
      worst_score: worstScore(base),
      recent_invoices: list.slice(0, RECENT_PER_SUPPLIER).map(r => {
        const isTr = isTracked(r.created_at, trackingSince);
        const visible = hasVisibleProblem(r, misaligned);
        return {
          id: r.id,
          invoice_number: r.invoice_number,
          invoice_date: r.invoice_date,
          created_at: r.created_at,
          total_sum: r.total_sum,
          lines: num(r.line_count),
          flagged_lines: isTr ? num(r.flagged_lines) : 0,
          edited_lines: isTr ? num(r.edited_lines) : 0,
          deleted_lines: isTr ? num(r.deleted_lines) : 0,
          header_edits: isTr ? num(r.header_edits) : 0,
          mismatch: num(r.items_total_mismatch) === 1,
          misaligned: misaligned.has(r.id),
          sent_at: r.sent_at,
          tracked: isTr,
          clean: isTr ? cleanOf(r) : (visible ? false : null),
        };
      }),
    });
  }

  suppliers.sort(compareWorstFirst);

  const t = aggregate(rows, trackingSince, misaligned);
  return {
    totals: {
      suppliers: suppliers.length,
      invoices: t.invoices,
      tracked_invoices: t.tracked_invoices,
      lines: t.lines,
      tracked_lines: t.tracked_lines,
      edited_lines: t.edited_lines,
      deleted_lines: t.deleted_lines,
      edited_share: editedShare(t),
      flagged_lines: t.flagged_lines,
      flagged_share: share(t.flagged_lines, t.tracked_lines),
      header_edited_invoices: t.header_edited_invoices,
      header_edit_share: share(t.header_edited_invoices, t.tracked_invoices),
      mismatch_invoices: t.mismatch_invoices,
      mismatch_share: share(t.mismatch_invoices, t.invoices),
      misaligned_invoices: t.misaligned_invoices,
      misaligned_share: share(t.misaligned_invoices, t.invoices),
      unmapped_lines: t.unmapped_lines,
      mapping_issue_lines: t.unmapped_lines + t.low_conf_lines,
      mapping_issue_share: share(t.unmapped_lines + t.low_conf_lines, t.lines),
      sent_invoices: t.sent.length,
      sent_share: share(t.sent.length, t.invoices),
      median_days_to_1c: roundTo(medianDaysToSend(t.sent), 1),
      total_sum: roundTo(t.total_sum, 2) ?? 0,
    },
    suppliers: suppliers.slice(0, MAX_SUPPLIERS),
  };
}

// ─── SQL ─────────────────────────────────────────────────────────────────────

/** Константный список значений для IN (…). Только из списков выше — не из запроса. */
function sqlList(values: readonly string[]): string {
  for (const v of values) if (!/^[a-z0-9_]+$/.test(v)) throw new Error(`analyticsQuality: bad SQL constant ${v}`);
  return values.map(v => `'${v}'`).join(', ');
}

const BASE_FILTER = (alias: string, d: number): string => `
       ${alias}.owner_user_id = ?
   AND ${alias}.created_at >= (NOW() - INTERVAL ${d} DAY)
   AND ${alias}.status IN ('processed', 'sent_to_1c')
   AND ${alias}.duplicate_of IS NULL`;

const clampDays = (days: number): number => Math.max(1, Math.min(366, Math.trunc(days)));

/**
 * Накладные компании за период со счётчиками. Строки агрегируются одним
 * производным запросом по invoice_items (индекс invoice_id), журнал правок —
 * коррелированными подзапросами по idx_edit_log_invoice. GROUP BY — только по
 * колонке группировки: так запрос одинаково работает на MySQL 9.6 и MariaDB
 * 10.11 при любом sql_mode.
 */
export async function loadQualityRows(ownerUserId: number, days: AnalyticsPeriod): Promise<QualityInvoiceRow[]> {
  const d = clampDays(days);
  const itemFix = sqlList(ITEM_FIX_FIELDS);
  const itemWork = sqlList(ITEM_WORK_FIELDS);
  const headerFix = sqlList(HEADER_FIX_FIELDS);
  return getDb().prepare(`
    SELECT i.id, i.invoice_number, i.invoice_date, i.supplier, i.supplier_inn,
           sc.name AS card_name,
           i.total_sum, i.status, i.created_at, i.sent_at,
           COALESCE(i.items_total_mismatch, 0) AS items_total_mismatch,
           COALESCE(a.line_count, 0) AS line_count,
           COALESCE(a.flagged, 0)  AS flagged_lines,
           COALESCE(a.edited, 0)   AS edited_lines,
           COALESCE(a.unmapped, 0) AS unmapped_lines,
           COALESCE(a.low_conf, 0) AS low_conf_lines,
           (SELECT COUNT(DISTINCT e.item_id) FROM edit_log e
             WHERE e.invoice_id = i.id AND e.entity = 'item' AND e.field = 'deleted') AS deleted_lines,
           (SELECT COUNT(*) FROM edit_log e
             WHERE e.invoice_id = i.id AND e.entity = 'item' AND e.field IN (${itemWork})) AS item_edit_rows,
           (SELECT COUNT(*) FROM edit_log e
             WHERE e.invoice_id = i.id AND e.entity = 'invoice' AND e.field IN (${headerFix})
               AND (e.context IS NULL OR e.context NOT LIKE '%restored_from%')) AS header_edits
      FROM invoices i
      LEFT JOIN supplier_cards sc
             ON sc.owner_user_id = i.owner_user_id AND sc.inn = i.supplier_inn
      LEFT JOIN (
        SELECT ii.invoice_id,
               COUNT(*) AS line_count,
               SUM(CASE WHEN ii.qty_flag IS NOT NULL AND ii.qty_flag <> '' THEN 1 ELSE 0 END) AS flagged,
               SUM(CASE WHEN ii.conv_source = 'manual'
                          OR EXISTS (SELECT 1 FROM edit_log e
                                      WHERE e.invoice_id = ii.invoice_id AND e.item_id = ii.id
                                        AND e.entity = 'item' AND e.field IN (${itemFix}))
                        THEN 1 ELSE 0 END) AS edited,
               SUM(CASE WHEN ii.onec_guid IS NULL OR ii.onec_guid = '' THEN 1 ELSE 0 END) AS unmapped,
               SUM(CASE WHEN ii.onec_guid IS NOT NULL AND ii.onec_guid <> ''
                         AND COALESCE(ii.mapping_confidence, 0) < 0.8 THEN 1 ELSE 0 END) AS low_conf
          FROM invoice_items ii
          JOIN invoices f ON f.id = ii.invoice_id
         WHERE ${BASE_FILTER('f', d)}
         GROUP BY ii.invoice_id
      ) a ON a.invoice_id = i.id
     WHERE ${BASE_FILTER('i', d)}
     ORDER BY i.created_at DESC, i.id DESC
     LIMIT ${MAX_INVOICES}
  `).all<QualityInvoiceRow>(ownerUserId, ownerUserId);
}

/** Строки накладных периода «как напечатано» — для проверки сдвига. */
export async function loadQualityItemRows(ownerUserId: number, days: AnalyticsPeriod): Promise<QualityItemRow[]> {
  const d = clampDays(days);
  return getDb().prepare(`
    SELECT ii.invoice_id, ii.original_name,
           COALESCE(ii.raw_quantity, ii.quantity) AS q, COALESCE(ii.raw_unit, ii.unit) AS u,
           COALESCE(ii.raw_price, ii.price) AS p, COALESCE(ii.raw_total, ii.total) AS t, ii.row_no
      FROM invoice_items ii
      JOIN invoices i ON i.id = ii.invoice_id
     WHERE ${BASE_FILTER('i', d)}
     ORDER BY ii.invoice_id, COALESCE(ii.row_no, 1000000), ii.id
     LIMIT ${MAX_ITEM_ROWS}
  `).all<QualityItemRow>(ownerUserId);
}

/**
 * С какого момента ведутся журнал правок и флаги пересчёта (дата применения
 * миграций 64 и 67 в формате БД). null — не удалось узнать: тогда считаем, что
 * с самого начала (как до этого отчёта).
 */
export async function loadTrackingSince(): Promise<string | null> {
  try {
    const row = await getDb().prepare(
      `SELECT MAX(applied_at) AS since FROM migration_history WHERE version IN (${TRACKING_MIGRATIONS.join(', ')})`,
    ).get<{ since: string | null }>();
    return row?.since ? String(row.since) : null;
  } catch {
    return null;
  }
}

export async function getSupplierQuality(ownerUserId: number, days: AnalyticsPeriod): Promise<SupplierQualityReport & {
  period_days: AnalyticsPeriod;
  generated_at: string;
  tracking_since: string | null;
  thresholds: typeof QUALITY_THRESHOLDS;
  min_invoices_for_verdict: number;
  truncated: boolean;
}> {
  const [rows, items, trackingSince] = await Promise.all([
    loadQualityRows(ownerUserId, days),
    loadQualityItemRows(ownerUserId, days),
    loadTrackingSince(),
  ]);
  return {
    period_days: days,
    generated_at: new Date().toISOString(),
    tracking_since: trackingSince,
    thresholds: QUALITY_THRESHOLDS,
    min_invoices_for_verdict: MIN_INVOICES_FOR_VERDICT,
    truncated: rows.length >= MAX_INVOICES || items.length >= MAX_ITEM_ROWS,
    ...buildSupplierQuality(rows, { trackingSince, misaligned: misalignedInvoiceIds(items) }),
  };
}
