/**
 * Аналитика, «Закупочные цены» (п.11): цена за единицу 1С по каждой позиции
 * каталога компании — динамика, сравнение поставщиков, «у кого дешевле» и
 * экономия при недавнем объёме, подорожания за период и за неделю.
 *
 * Источник — строки распознанных накладных компании (processed / sent_to_1c,
 * без дублей) с позицией 1С (onec_guid) и итоговыми, уже пересчитанными
 * (правило 22: пересчёт только convertInvoiceLine от raw_*), price/unit.
 * Сравниваются только закупки в одной единице: в единице позиции 1С, если такие
 * закупки есть, иначе — в самой частой. Не учитываются: строки с флагом
 * пересчёта (qty_flag), строки в другой единице, явные ошибки цены (в 5 раз
 * дальше медианы — как у «обычной цены»).
 *
 * «Обычная цена» — готовая медиана из nomenclature_price_stat_cards (та же, что
 * подсвечивает цены в карточке накладной и шлёт elevated_prices) — здесь она не
 * пересчитывается, а показывается рядом. Все прочие медианы — src/pricing/medianOf.
 *
 * Вся арифметика — в чистых функциях (group/summarize/find*), SQL — в load*.
 */
import { getDb } from '../database/db';
import { medianOf } from '../pricing/medianOf';
import { canonUnit } from '../mapping/unitConverter';
import {
  type AnalyticsPeriod,
  buildSupplierKeyResolver,
  dayMinus,
  dropPriceOutliers,
  effectiveDate,
  isoDayShift,
  pctChange,
  periodChangePct,
  pickCheapest,
  roundTo,
  savingVsCheapest,
} from './analyticsMath';

/** По скольким последним закупкам поставщика считается его «текущая» цена. */
export const RECENT_PURCHASES = 5;
/** Окно «недавнего объёма» для экономии, дней (не больше периода). */
export const SAVING_WINDOW_DAYS = 30;
/** Рост цены, с которого закупка считается подорожанием, %. */
export const RISE_THRESHOLD_PCT = 5;
/** Сколько дней истории до недели сводки берётся для «прошлой цены». */
export const WEEKLY_LOOKBACK_DAYS = 90;

const MAX_LINES = 20000;
const MAX_ITEMS = 500;
const MAX_RISES = 300;
const MAX_POINTS = 400;
const SPARK_POINTS = 12;
const MAX_QUERY_LEN = 100;

/** Строка SQL: строка накладной с позицией 1С. */
export interface PriceLineRow {
  item_id: number;
  onec_guid: string;
  price: number;
  unit: string | null;
  quantity: number | null;
  total: number | null;
  mapped_name: string | null;
  invoice_id: number;
  invoice_number: string | null;
  invoice_date: string | null;
  created_at: string;
  supplier: string | null;
  supplier_inn: string | null;
  catalog_name: string | null;
  catalog_unit: string | null;
  ref_median: number | null;
  ref_unit: string | null;
  ref_samples: number | null;
}

/** Строка SQL: поставщик из накладных периода (для ключей и названий). */
export interface SupplierDirectoryRow {
  supplier: string | null;
  supplier_inn: string | null;
  card_name: string | null;
  last_at: string | null;
}

export interface SupplierRef {
  key: string;
  name: string;
  inn: string | null;
}

export interface SupplierDirectory {
  keyOf: (row: { supplier_inn: unknown; supplier: unknown }) => string;
  get: (key: string) => SupplierRef;
}

/** Одна закупка позиции = одна накладная (несколько строк одной позиции сливаются). */
export interface PricePurchase {
  invoice_id: number;
  invoice_number: string | null;
  /** Дата закупки, YYYY-MM-DD (дата документа, если правдоподобна). */
  date: string;
  /** Когда накладную загрузили (created_at, часы БД). */
  uploaded_at: string;
  supplier_key: string;
  price: number;
  qty: number | null;
  total: number | null;
}

export interface PriceReference {
  median_price: number;
  unit: string;
  samples: number;
}

export interface PriceItemGroup {
  guid: string;
  name: string;
  /** Единица, в которой сравниваются цены (каноническое написание). */
  unit: string;
  /** Единица позиции в справочнике 1С; null — не выгружена. */
  catalog_unit: string | null;
  /** Цены — в единице позиции 1С (иначе в самой частой единице накладных). */
  in_catalog_unit: boolean;
  reference: PriceReference | null;
  /** По дате закупки, старые первыми. */
  purchases: PricePurchase[];
  excluded: { other_unit: number; outliers: number };
}

export interface SupplierPriceStats {
  key: string;
  name: string;
  inn: string | null;
  purchases: number;
  first_price: number;
  first_date: string;
  last_price: number;
  last_date: string;
  last_invoice_id: number;
  prev_price: number | null;
  /** Последняя закупка к предыдущей у этого поставщика, %. */
  change_pct: number | null;
  /** Последняя закупка к первой за период у этого поставщика, %. */
  period_change_pct: number | null;
  min_price: number;
  max_price: number;
  median_price: number;
  /** Медиана последних RECENT_PURCHASES закупок — по ней «у кого дешевле». */
  recent_median: number;
  qty: number;
  spend: number;
  is_cheapest: boolean;
}

export interface PriceItemSummary {
  guid: string;
  name: string;
  unit: string;
  catalog_unit: string | null;
  in_catalog_unit: boolean;
  purchases: number;
  suppliers: number;
  last_price: number;
  last_date: string;
  last_supplier: string;
  last_supplier_key: string;
  last_invoice_id: number;
  prev_price: number | null;
  last_change_pct: number | null;
  period_change_pct: number | null;
  last_vs_reference_pct: number | null;
  min_price: number;
  max_price: number;
  median_price: number;
  spend: number;
  qty: number;
  reference: PriceReference | null;
  cheapest: { key: string; name: string; recent_median: number } | null;
  saving: { rub: number; pct: number; volume: number; window_days: number } | null;
  spark: number[];
  excluded: { other_unit: number; outliers: number };
}

/** Подорожание у поставщика за период: первая закупка периода → последняя. */
export interface PeriodRise {
  guid: string;
  name: string;
  unit: string;
  supplier_key: string;
  supplier: string;
  from_price: number;
  from_date: string;
  from_invoice_id: number;
  from_invoice_number: string | null;
  to_price: number;
  to_date: string;
  to_invoice_id: number;
  to_invoice_number: string | null;
  change_pct: number;
  purchases: number;
  /** Переплата к цене первой закупки по всем следующим закупкам, ₽; null — количество неизвестно. */
  extra_rub: number | null;
}

export interface WeeklyRise {
  guid: string;
  name: string;
  unit: string;
  supplier_key: string;
  supplier: string;
  from_price: number;
  from_date: string;
  to_price: number;
  to_date: string;
  change_pct: number;
  qty: number | null;
  impact_rub: number | null;
}

/** Неделя сводки по часам БД: [from, to), даты YYYY-MM-DD (to — следующий понедельник). */
export interface DigestWindow {
  from: string;
  to: string;
}

// ─── Поставщики ──────────────────────────────────────────────────────────────

/**
 * Ключи и названия поставщиков по накладным периода. Название — из карточки
 * справочника (supplier_cards), иначе как в самой свежей накладной.
 */
export function buildSupplierDirectory(rows: readonly SupplierDirectoryRow[]): SupplierDirectory {
  const keyOf = buildSupplierKeyResolver(rows);
  const byKey = new Map<string, { card: string | null; name: string | null; at: string }>();
  for (const r of rows) {
    const key = keyOf(r);
    const cur = byKey.get(key) ?? { card: null, name: null, at: '' };
    if (!cur.card && r.card_name && r.card_name.trim()) cur.card = r.card_name.trim();
    // Название без карточки — из самой свежей накладной поставщика.
    const at = r.last_at ?? '';
    if (r.supplier && r.supplier.trim() && (!cur.name || at > cur.at)) {
      cur.name = r.supplier.trim();
      cur.at = at;
    }
    byKey.set(key, cur);
  }
  return {
    keyOf,
    get(key: string): SupplierRef {
      const inn = key.startsWith('inn:') ? key.slice(4) : null;
      const e = byKey.get(key);
      return { key, inn, name: e?.card || e?.name || (inn ? `ИНН ${inn}` : 'Поставщик не указан') };
    },
  };
}

// ─── Группировка строк в закупки ─────────────────────────────────────────────

function unitKey(raw: string | null | undefined): string {
  if (!raw || !String(raw).trim()) return '';
  return canonUnit(raw)?.unit ?? String(raw).trim().toLowerCase();
}

function dominantUnit(units: readonly string[], catalogUnit: string, latestUnit: string): string {
  const counts = new Map<string, number>();
  for (const u of units) counts.set(u, (counts.get(u) ?? 0) + 1);
  let best = -1;
  let tied: string[] = [];
  for (const [u, c] of counts) {
    if (c > best) { best = c; tied = [u]; } else if (c === best) tied.push(u);
  }
  if (tied.length === 1) return tied[0];
  if (catalogUnit && tied.includes(catalogUnit)) return catalogUnit;
  if (tied.includes(latestUnit)) return latestUnit;
  return [...tied].sort()[0];
}

function positive(v: number | null | undefined): number | null {
  const n = Number(v);
  return v != null && Number.isFinite(n) && n > 0 ? n : null;
}

function mergeInvoiceLines(lines: readonly PriceLineRow[]): { price: number; qty: number | null; total: number | null } {
  if (lines.length === 1) {
    const l = lines[0];
    return { price: Number(l.price), qty: positive(l.quantity), total: positive(l.total) };
  }
  const qtys = lines.map(l => positive(l.quantity));
  const totals = lines.map(l => positive(l.total));
  const qty = qtys.some(q => q != null) ? qtys.reduce<number>((s, q) => s + (q ?? 0), 0) : null;
  const total = totals.some(t => t != null) ? totals.reduce<number>((s, t) => s + (t ?? 0), 0) : null;
  const complete = qtys.every(q => q != null) && totals.every(t => t != null);
  const price = complete && qty && total ? total / qty : (medianOf(lines.map(l => Number(l.price))) ?? Number(lines[0].price));
  return { price, qty, total };
}

/**
 * Строки → закупки по позициям. `sinceDate` (YYYY-MM-DD) отсекает закупки
 * раньше начала периода (SQL выбирает с запасом по дате загрузки).
 */
export function groupPriceLines(
  rows: readonly PriceLineRow[],
  directory: SupplierDirectory,
  sinceDate: string | null,
): Map<string, PriceItemGroup> {
  const byGuid = new Map<string, Array<PriceLineRow & { _date: string; _unit: string }>>();
  for (const r of rows) {
    if (!r.onec_guid || !(Number(r.price) > 0)) continue;
    const date = effectiveDate(r.invoice_date, r.created_at);
    if (!date || (sinceDate && date < sinceDate)) continue;
    const list = byGuid.get(r.onec_guid) ?? [];
    list.push({ ...r, _date: date, _unit: unitKey(r.unit) });
    byGuid.set(r.onec_guid, list);
  }

  const out = new Map<string, PriceItemGroup>();
  for (const [guid, lines] of byGuid) {
    // Самая свежая строка — по дате закупки, затем по загрузке.
    const latest = lines.reduce((a, b) => (b._date > a._date || (b._date === a._date && b.created_at > a.created_at) ? b : a));
    const withUnit = lines.filter(l => l._unit);
    if (!withUnit.length) continue;
    // Сравнение — в единице позиции 1С, если в ней есть закупки (строки,
    // пересчитанные в единицу 1С); иначе — в самой частой единице накладных.
    const catalogUnit = unitKey(lines.find(l => l.catalog_unit && String(l.catalog_unit).trim())?.catalog_unit);
    const inCatalogUnit = !!catalogUnit && withUnit.some(l => l._unit === catalogUnit);
    const unit = inCatalogUnit ? catalogUnit : dominantUnit(withUnit.map(l => l._unit), catalogUnit, latest._unit);
    const same = withUnit.filter(l => l._unit === unit);

    const byInvoice = new Map<number, typeof same>();
    for (const l of same) {
      const list = byInvoice.get(l.invoice_id) ?? [];
      list.push(l);
      byInvoice.set(l.invoice_id, list);
    }
    const purchases: PricePurchase[] = [];
    for (const [invoiceId, invLines] of byInvoice) {
      const first = invLines[0];
      const merged = mergeInvoiceLines(invLines);
      if (!(merged.price > 0)) continue;
      purchases.push({
        invoice_id: invoiceId,
        invoice_number: first.invoice_number,
        date: first._date,
        uploaded_at: first.created_at,
        supplier_key: directory.keyOf(first),
        price: merged.price,
        qty: merged.qty,
        total: merged.total,
      });
    }
    const { kept, dropped } = dropPriceOutliers(purchases, p => p.price);
    if (!kept.length) continue;
    kept.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.invoice_id - b.invoice_id));

    const catalogName = lines.find(l => l.catalog_name && l.catalog_name.trim())?.catalog_name?.trim();
    const refLine = lines.find(l => l.ref_median != null);
    const refMedian = positive(refLine?.ref_median);
    const reference = refMedian != null && unitKey(refLine?.ref_unit) === unit
      ? { median_price: refMedian, unit, samples: Number(refLine?.ref_samples ?? 0) }
      : null;

    out.set(guid, {
      guid,
      name: catalogName || latest.mapped_name?.trim() || guid,
      unit,
      catalog_unit: catalogUnit || null,
      in_catalog_unit: inCatalogUnit,
      reference,
      purchases: kept,
      excluded: { other_unit: lines.length - same.length, outliers: dropped },
    });
  }
  return out;
}

// ─── Сводки ──────────────────────────────────────────────────────────────────

function spendOf(p: PricePurchase): number {
  if (p.total != null) return p.total;
  return p.qty != null ? p.price * p.qty : 0;
}

const r2 = (n: number): number => roundTo(n, 2) ?? 0;
const r1 = (n: number | null): number | null => roundTo(n, 1);

/** Закупки позиции по поставщикам, в хронологическом порядке. */
function bySupplier(purchases: readonly PricePurchase[]): Map<string, PricePurchase[]> {
  const m = new Map<string, PricePurchase[]>();
  for (const p of purchases) {
    const list = m.get(p.supplier_key) ?? [];
    list.push(p);
    m.set(p.supplier_key, list);
  }
  return m;
}

/** Показатели поставщиков позиции; самые частые — первыми. */
export function supplierStats(group: PriceItemGroup, directory: SupplierDirectory): SupplierPriceStats[] {
  const stats: SupplierPriceStats[] = [];
  for (const [key, list] of bySupplier(group.purchases)) {
    const prices = list.map(p => p.price);
    const first = list[0];
    const last = list[list.length - 1];
    const prev = list.length > 1 ? list[list.length - 2] : null;
    const ref = directory.get(key);
    stats.push({
      key,
      name: ref.name,
      inn: ref.inn,
      purchases: list.length,
      first_price: r2(first.price),
      first_date: first.date,
      last_price: r2(last.price),
      last_date: last.date,
      last_invoice_id: last.invoice_id,
      prev_price: prev ? r2(prev.price) : null,
      change_pct: r1(pctChange(prev?.price, last.price)),
      period_change_pct: list.length > 1 ? r1(pctChange(first.price, last.price)) : null,
      min_price: r2(Math.min(...prices)),
      max_price: r2(Math.max(...prices)),
      median_price: r2(medianOf(prices) ?? last.price),
      recent_median: r2(medianOf(prices.slice(-RECENT_PURCHASES)) ?? last.price),
      qty: roundTo(list.reduce((s, p) => s + (p.qty ?? 0), 0), 3) ?? 0,
      spend: r2(list.reduce((s, p) => s + spendOf(p), 0)),
      is_cheapest: false,
    });
  }
  stats.sort((a, b) => b.purchases - a.purchases || b.spend - a.spend || a.name.localeCompare(b.name, 'ru'));
  return stats;
}

/** Сводка по позиции: цены, изменения, «у кого дешевле», экономия. */
export function summarizeItem(
  group: PriceItemGroup,
  directory: SupplierDirectory,
  opts: { now: Date; periodDays: number },
): { summary: PriceItemSummary; suppliers: SupplierPriceStats[] } {
  const ps = group.purchases;
  const prices = ps.map(p => p.price);
  const last = ps[ps.length - 1];
  const prev = ps.length > 1 ? ps[ps.length - 2] : null;
  const suppliers = supplierStats(group, directory);

  const cheapest = pickCheapest(suppliers);
  if (cheapest) cheapest.is_cheapest = true;
  const windowDays = Math.min(SAVING_WINDOW_DAYS, opts.periodDays);
  const windowStart = dayMinus(opts.now, windowDays);
  const saving = cheapest
    ? savingVsCheapest(ps.filter(p => p.date >= windowStart), { key: cheapest.key, recent_median: cheapest.recent_median })
    : null;

  const summary: PriceItemSummary = {
    guid: group.guid,
    name: group.name,
    unit: group.unit,
    catalog_unit: group.catalog_unit,
    in_catalog_unit: group.in_catalog_unit,
    purchases: ps.length,
    suppliers: suppliers.length,
    last_price: r2(last.price),
    last_date: last.date,
    last_supplier: directory.get(last.supplier_key).name,
    last_supplier_key: last.supplier_key,
    last_invoice_id: last.invoice_id,
    prev_price: prev ? r2(prev.price) : null,
    last_change_pct: r1(pctChange(prev?.price, last.price)),
    period_change_pct: r1(periodChangePct(prices)),
    last_vs_reference_pct: r1(pctChange(group.reference?.median_price, last.price)),
    min_price: r2(Math.min(...prices)),
    max_price: r2(Math.max(...prices)),
    median_price: r2(medianOf(prices) ?? last.price),
    spend: r2(ps.reduce((s, p) => s + spendOf(p), 0)),
    qty: roundTo(ps.reduce((s, p) => s + (p.qty ?? 0), 0), 3) ?? 0,
    reference: group.reference,
    cheapest: cheapest ? { key: cheapest.key, name: cheapest.name, recent_median: cheapest.recent_median } : null,
    saving: saving
      ? { rub: r2(saving.rub), pct: r1(saving.pct) ?? 0, volume: roundTo(saving.volume, 3) ?? 0, window_days: windowDays }
      : null,
    spark: ps.slice(-SPARK_POINTS).map(p => r2(p.price)),
    excluded: group.excluded,
  };
  return { summary, suppliers };
}

/**
 * Подорожания за период: по каждой паре «позиция + поставщик» с двумя и больше
 * закупками — последняя закупка периода против первой. Рост от
 * RISE_THRESHOLD_PCT. Сначала — где переплата в ₽ больше, затем по проценту.
 */
export function findPeriodRises(groups: Iterable<PriceItemGroup>, directory: SupplierDirectory): PeriodRise[] {
  const rises: PeriodRise[] = [];
  for (const group of groups) {
    for (const [key, list] of bySupplier(group.purchases)) {
      if (list.length < 2) continue;
      const from = list[0];
      const to = list[list.length - 1];
      const pct = pctChange(from.price, to.price);
      if (pct == null || pct < RISE_THRESHOLD_PCT) continue;
      const after = list.slice(1).filter(p => p.qty != null);
      rises.push({
        guid: group.guid,
        name: group.name,
        unit: group.unit,
        supplier_key: key,
        supplier: directory.get(key).name,
        from_price: r2(from.price),
        from_date: from.date,
        from_invoice_id: from.invoice_id,
        from_invoice_number: from.invoice_number,
        to_price: r2(to.price),
        to_date: to.date,
        to_invoice_id: to.invoice_id,
        to_invoice_number: to.invoice_number,
        change_pct: r1(pct) ?? 0,
        purchases: list.length,
        extra_rub: after.length ? r2(after.reduce((s, p) => s + (p.price - from.price) * (p.qty ?? 0), 0)) : null,
      });
    }
  }
  return rises.sort((a, b) => (b.extra_rub ?? -Infinity) - (a.extra_rub ?? -Infinity) || b.change_pct - a.change_pct);
}

/** Строка поиска: регистр, «ё», лишние пробелы не важны. */
export function normalizeQuery(s: unknown): string {
  return String(s ?? '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_LEN);
}

export interface PriceOverview {
  recent_days: number;
  /** Строк за период больше предела выборки — самые старые не вошли. */
  truncated: boolean;
  /** Позиций больше, чем показано (показаны с наибольшей суммой закупок). */
  items_truncated: boolean;
  rises_truncated: boolean;
  totals: { items: number; purchases: number; spend: number; rising_items: number; rises: number; saving_rub: number };
  items: PriceItemSummary[];
  rises: PeriodRise[];
}

export function buildPriceOverview(
  rows: readonly PriceLineRow[],
  directory: SupplierDirectory,
  opts: { now: Date; periodDays: number; q?: string },
): PriceOverview {
  const groups = groupPriceLines(rows, directory, dayMinus(opts.now, opts.periodDays));
  const needle = normalizeQuery(opts.q);
  const matching = [...groups.values()].filter(g => !needle || normalizeQuery(g.name).includes(needle));
  const items = matching
    .map(g => summarizeItem(g, directory, opts).summary)
    .sort((a, b) => b.spend - a.spend || a.name.localeCompare(b.name, 'ru'));
  const rises = findPeriodRises(matching, directory);
  return {
    recent_days: Math.min(SAVING_WINDOW_DAYS, opts.periodDays),
    truncated: rows.length >= MAX_LINES,
    items_truncated: items.length > MAX_ITEMS,
    rises_truncated: rises.length > MAX_RISES,
    totals: {
      items: items.length,
      purchases: items.reduce((s, i) => s + i.purchases, 0),
      spend: r2(items.reduce((s, i) => s + i.spend, 0)),
      rising_items: new Set(rises.map(r => r.guid)).size,
      rises: rises.length,
      saving_rub: r2(items.reduce((s, i) => s + (i.saving?.rub ?? 0), 0)),
    },
    items: items.slice(0, MAX_ITEMS),
    rises: rises.slice(0, MAX_RISES),
  };
}

export interface PriceItemDetail {
  recent_days: number;
  recent_purchases: number;
  truncated: boolean;
  item: PriceItemSummary;
  suppliers: SupplierPriceStats[];
  points: Array<{
    date: string;
    price: number;
    qty: number | null;
    total: number | null;
    supplier_key: string;
    invoice_id: number;
    invoice_number: string | null;
  }>;
  points_truncated: boolean;
}

export function buildPriceDetail(
  rows: readonly PriceLineRow[],
  directory: SupplierDirectory,
  guid: string,
  opts: { now: Date; periodDays: number },
): PriceItemDetail | null {
  const groups = groupPriceLines(rows.filter(r => r.onec_guid === guid), directory, dayMinus(opts.now, opts.periodDays));
  const group = groups.get(guid);
  if (!group) return null;
  const { summary, suppliers } = summarizeItem(group, directory, opts);
  const pts = group.purchases.slice(-MAX_POINTS);
  return {
    recent_days: Math.min(SAVING_WINDOW_DAYS, opts.periodDays),
    recent_purchases: RECENT_PURCHASES,
    truncated: rows.length >= MAX_LINES,
    item: summary,
    suppliers,
    points: pts.map(p => ({
      date: p.date,
      price: r2(p.price),
      qty: p.qty,
      total: p.total,
      supplier_key: p.supplier_key,
      invoice_id: p.invoice_id,
      invoice_number: p.invoice_number,
    })),
    points_truncated: group.purchases.length > pts.length,
  };
}

/**
 * Подорожания за неделю сводки: по каждой паре «позиция + поставщик», у которой
 * за неделю [from, to) (по времени загрузки, часы БД) загружены накладные, —
 * самая поздняя новая цена против последней закупки у того же поставщика,
 * загруженной до недели. Рост от RISE_THRESHOLD_PCT; сначала — где подорожание
 * обошлось дороже всего в ₽. Даты загрузки — строки БД «YYYY-MM-DD HH:MM:SS»,
 * сравниваются как строки с датами окна.
 */
export function findWeeklyRises(
  groups: ReadonlyMap<string, PriceItemGroup>,
  directory: SupplierDirectory,
  window: DigestWindow,
): WeeklyRise[] {
  const inWeek = (p: PricePurchase): boolean => p.uploaded_at >= window.from && p.uploaded_at < window.to;
  const beforeWeek = (p: PricePurchase): boolean => p.uploaded_at < window.from;
  const later = (a: PricePurchase, b: PricePurchase): PricePurchase =>
    (b.date > a.date || (b.date === a.date && b.invoice_id > a.invoice_id) ? b : a);

  const rises: WeeklyRise[] = [];
  for (const group of groups.values()) {
    for (const [key, list] of bySupplier(group.purchases)) {
      const fresh = list.filter(inWeek);
      if (!fresh.length) continue;
      const to = fresh.reduce(later);
      const older = list.filter(p => beforeWeek(p) && p.date <= to.date);
      if (!older.length) continue;
      const from = older.reduce(later);
      const pct = pctChange(from.price, to.price);
      if (pct == null || pct < RISE_THRESHOLD_PCT) continue;
      const qty = fresh.some(p => p.qty != null) ? fresh.reduce((s, p) => s + (p.qty ?? 0), 0) : null;
      rises.push({
        guid: group.guid,
        name: group.name,
        unit: group.unit,
        supplier_key: key,
        supplier: directory.get(key).name,
        from_price: r2(from.price),
        from_date: from.date,
        to_price: r2(to.price),
        to_date: to.date,
        change_pct: r1(pct) ?? 0,
        qty: qty != null ? roundTo(qty, 3) : null,
        impact_rub: qty ? r2((to.price - from.price) * qty) : null,
      });
    }
  }
  return rises.sort((a, b) => (b.impact_rub ?? -1) - (a.impact_rub ?? -1) || b.change_pct - a.change_pct);
}

// ─── SQL ─────────────────────────────────────────────────────────────────────

/** Строки с позицией 1С компании, загруженные за последние `sinceDays` дней. */
export async function loadPriceLines(ownerUserId: number, sinceDays: number, guid?: string): Promise<PriceLineRow[]> {
  const d = Math.max(1, Math.min(400, Math.trunc(sinceDays)));
  const params: unknown[] = [ownerUserId];
  let guidClause = '';
  if (guid) { guidClause = 'AND ii.onec_guid = ?'; params.push(guid); }
  return getDb().prepare(`
    SELECT ii.id AS item_id, ii.onec_guid, ii.price, ii.unit, ii.quantity, ii.total, ii.mapped_name,
           i.id AS invoice_id, i.invoice_number, i.invoice_date, i.created_at,
           i.supplier, i.supplier_inn,
           n.name AS catalog_name, n.unit AS catalog_unit,
           ps.median_price AS ref_median, ps.price_unit AS ref_unit, ps.samples AS ref_samples
      FROM invoice_items ii
      JOIN invoices i ON i.id = ii.invoice_id
      LEFT JOIN onec_nomenclature_cards n
             ON n.owner_user_id = i.owner_user_id AND n.guid = ii.onec_guid
      LEFT JOIN nomenclature_price_stat_cards ps
             ON ps.owner_user_id = i.owner_user_id AND ps.onec_guid = ii.onec_guid
     WHERE i.owner_user_id = ?
       AND i.created_at >= (NOW() - INTERVAL ${d} DAY)
       AND i.status IN ('processed', 'sent_to_1c')
       AND i.duplicate_of IS NULL
       AND ii.onec_guid IS NOT NULL AND ii.onec_guid <> ''
       AND ii.qty_flag IS NULL
       AND ii.price > 0
       ${guidClause}
     ORDER BY i.created_at DESC, ii.id DESC
     LIMIT ${MAX_LINES}
  `).all<PriceLineRow>(...params);
}

/** Поставщики накладных компании за `sinceDays` дней — для ключей и названий. */
export async function loadSupplierDirectory(ownerUserId: number, sinceDays: number): Promise<SupplierDirectory> {
  const d = Math.max(1, Math.min(400, Math.trunc(sinceDays)));
  const rows = await getDb().prepare(`
    SELECT i.supplier, i.supplier_inn, sc.name AS card_name, MAX(i.created_at) AS last_at
      FROM invoices i
      LEFT JOIN supplier_cards sc
             ON sc.owner_user_id = i.owner_user_id AND sc.inn = i.supplier_inn
     WHERE i.owner_user_id = ?
       AND i.created_at >= (NOW() - INTERVAL ${d} DAY)
       AND i.status IN ('processed', 'sent_to_1c')
       AND i.duplicate_of IS NULL
     GROUP BY i.supplier, i.supplier_inn, sc.name
     LIMIT 5000
  `).all<SupplierDirectoryRow>(ownerUserId);
  return buildSupplierDirectory(rows);
}

// Запас к периоду по дате загрузки: дата закупки может быть на неделю позже неё.
const SQL_SLACK_DAYS = 7;

export async function getPriceOverview(
  ownerUserId: number,
  days: AnalyticsPeriod,
  now = new Date(),
  q?: string,
): Promise<PriceOverview & {
  period_days: AnalyticsPeriod;
  generated_at: string;
  rise_threshold_pct: number;
  q: string;
}> {
  const since = days + SQL_SLACK_DAYS;
  const [rows, directory] = await Promise.all([
    loadPriceLines(ownerUserId, since),
    loadSupplierDirectory(ownerUserId, since),
  ]);
  const query = normalizeQuery(q);
  return {
    period_days: days,
    generated_at: now.toISOString(),
    rise_threshold_pct: RISE_THRESHOLD_PCT,
    q: query,
    ...buildPriceOverview(rows, directory, { now, periodDays: days, q: query }),
  };
}

export async function getPriceItemDetail(ownerUserId: number, guid: string, days: AnalyticsPeriod, now = new Date()): Promise<(PriceItemDetail & {
  period_days: AnalyticsPeriod;
  generated_at: string;
}) | null> {
  const since = days + SQL_SLACK_DAYS;
  const [rows, directory] = await Promise.all([
    loadPriceLines(ownerUserId, since, guid),
    loadSupplierDirectory(ownerUserId, since),
  ]);
  const detail = buildPriceDetail(rows, directory, guid, { now, periodDays: days });
  return detail ? { period_days: days, generated_at: now.toISOString(), ...detail } : null;
}

/**
 * Подорожания за неделю сводки для владельца. Окно — не дальше двух недель
 * назад (прошлая календарная неделя), история до неё — WEEKLY_LOOKBACK_DAYS.
 */
export async function getWeeklyPriceRises(ownerUserId: number, window: DigestWindow): Promise<WeeklyRise[]> {
  const since = 14 + WEEKLY_LOOKBACK_DAYS + SQL_SLACK_DAYS;
  const [rows, directory] = await Promise.all([
    loadPriceLines(ownerUserId, since),
    loadSupplierDirectory(ownerUserId, since),
  ]);
  const groups = groupPriceLines(rows, directory, isoDayShift(window.from, -WEEKLY_LOOKBACK_DAYS));
  return findWeeklyRises(groups, directory, window);
}
