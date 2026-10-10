import { canonUnit } from '../mapping/unitConverter';
import { newItemGroupKey } from './newItems';

/**
 * «Очередь в 1С» — чистые правила (без БД), общие для списка очереди и
 * карточки накладной на странице #/queue (public/js/queue.js).
 *
 * Очередь — накладные компании, которые распознаны, но в 1С ещё не ушли
 * (sent_at IS NULL) и не помечены дубликатом. Одобренные к отправке, но ещё не
 * забранные 1С, в очереди остаются — с отметкой «одобрена, ждёт 1С»: пока 1С
 * их не забрала, в учёте их нет.
 *
 * Менять строки (перераспознавание, подбор ИИ) можно только у НЕ одобренных:
 * одобренную 1С может забрать в любой момент (GET /api/invoices/pending), и
 * выгрузка не должна увидеть строки на полпути. Сначала «Отозвать» в карточке.
 *
 * Готовность к 1С — причины гейта автопилота (src/automation/qualityGate.ts,
 * evaluateInvoiceQuality) плюс то, чего гейт не проверяет, а 1С без этого
 * накладную не примет или примет с ошибкой (см. queueReasons).
 *
 * Строка «с замечанием» — та, где ошибка чаще всего доходила до 1С:
 *   - qty_flag         — пересчёт единиц v2 не уверен (цена выбивается,
 *                         единица не сходится с 1С, нужен фактический вес);
 *   - unit_mismatch    — единица строки не совпадает с единицей позиции 1С
 *                         (у строк до v2 флага нет — это их главный признак);
 *   - unit_to_kg       — «Всё в кг»: строка в кг, а позиция 1С в штуках/литрах.
 *                         Не ошибка: обработка 1С при загрузке переведёт позицию
 *                         на кг, но остаток в прежней единице надо проверить;
 *   - price_outlier    — цена за единицу в 3 раза и больше отличается от
 *                         обычной цены позиции (для строк без qty_flag: у
 *                         строк до v2 проверка цены не выполнялась);
 *   - low_confidence   — позиция 1С подобрана с уверенностью ниже 0,8;
 *   - new_item         — позиции 1С нет, 1С создаст новую (если человек не
 *                         задал своё название и нет заявки «Создать в 1С»).
 */

/** SQL-условие очереди для таблицы invoices с псевдонимом i. Владелец — отдельным параметром. */
export const QUEUE_SQL = `i.status = 'processed' AND i.sent_at IS NULL AND i.duplicate_of IS NULL`;

/** Накладные очереди, строки которых можно менять: ещё не одобрены для 1С. */
export const WORKABLE_SQL = `${QUEUE_SQL} AND i.approved_for_1c = 0`;

export interface QueueStateLike {
  status: string;
  approved_for_1c: number | boolean | null;
  sent_at: string | null;
  duplicate_of: number | null;
}

/** Накладная в очереди (то же, что QUEUE_SQL, но для уже загруженной строки). */
export function isInQueue(inv: QueueStateLike): boolean {
  return inv.status === 'processed' && inv.sent_at == null && inv.duplicate_of == null;
}

/** В очереди и не одобрена — строки можно менять (то же, что WORKABLE_SQL). */
export function isWorkable(inv: QueueStateLike): boolean {
  return isInQueue(inv) && !Number(inv.approved_for_1c ?? 0);
}

export const LOW_CONFIDENCE = 0.8;
/** Во сколько раз цена должна отличаться от обычной, чтобы строка считалась подозрительной. */
export const PRICE_OUTLIER_RATIO = 3;
/** Сколько поставок нужно, чтобы «обычной» цене можно было верить (как в GET /invoices/:id). */
export const MEDIAN_MIN_SAMPLES = 3;

export type LineRiskCode = 'qty_flag' | 'unit_mismatch' | 'unit_to_kg' | 'price_outlier' | 'low_confidence' | 'new_item';
export const LINE_RISK_CODES: readonly LineRiskCode[] = ['qty_flag', 'unit_mismatch', 'unit_to_kg', 'price_outlier', 'low_confidence', 'new_item'];

/** Флаги движков, от которых зависят замечания: all_kg — «Всё в кг». */
export interface RiskOptions {
  allKg?: boolean;
}

export interface LineRisk {
  code: LineRiskCode;
  /** qty_flag: price_outlier | unit_mismatch | needs_weight. */
  flag?: string;
  note?: string | null;
  /** unit_mismatch, unit_to_kg: единица позиции 1С. */
  onec_unit?: string | null;
  /** price_outlier: цена / обычная цена. */
  ratio?: number;
  median_price?: number;
  /** low_confidence: уверенность подбора. */
  confidence?: number;
}

export interface RiskLine {
  original_name: string | null;
  onec_guid: string | null;
  mapping_confidence: number | null;
  name_overridden?: number | null;
  unit: string | null;
  price: number | null;
  qty_flag?: string | null;
  qty_flag_note?: string | null;
  conv_source?: string | null;
  /** Единица позиции 1С (JOIN каталога компании). */
  onec_unit?: string | null;
  median_price?: number | null;
  median_price_unit?: string | null;
  median_samples?: number | null;
}

function looseUnit(u: string | null | undefined): string {
  return String(u ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\(.*?\)/g, '').replace(/[.\s]+/g, '').trim();
}

/** Одна и та же единица? «шт.» = «шт», «уп» = «упак», «гр» = «г»; неизвестные — по написанию. */
export function sameUnit(a: string | null | undefined, b: string | null | undefined): boolean {
  const ca = canonUnit(a);
  const cb = canonUnit(b);
  if (ca && cb) return ca.unit === cb.unit;
  return looseUnit(a) === looseUnit(b);
}

/** Строка записана до пакета v2 (или не его конвейером): её «как в накладной» ненадёжно. */
export function isLegacyLine(line: { conv_source?: string | null }): boolean {
  return line.conv_source == null || line.conv_source === 'legacy_stored';
}

/**
 * Отклонение цены строки от обычной, % — по тому же правилу, что и
 * GET /api/invoices/:id: обычной цене верим при ≥3 поставках, единицы совпадают,
 * цена положительная. null — сравнивать не с чем.
 */
export function priceDeviationPct(line: RiskLine): number | null {
  const median = Number(line.median_price);
  const price = Number(line.price);
  if (line.median_price == null || !(median > 0)) return null;
  if ((line.median_samples ?? 0) < MEDIAN_MIN_SAMPLES) return null;
  if (line.price == null || !(price > 0)) return null;
  if (!line.unit || !line.median_price_unit || !sameUnit(line.unit, line.median_price_unit)) return null;
  return ((price - median) / median) * 100;
}

/**
 * Замечания по строке. pendingNewItemKeys — ключи товаров с ждущей заявкой
 * «Создать в 1С» (newItemGroupKey): такая строка без позиции не «новая
 * неизвестная», 1С создаст её как попросили.
 */
export function lineRisks(line: RiskLine, pendingNewItemKeys: ReadonlySet<string> = new Set(), opts: RiskOptions = {}): LineRisk[] {
  const risks: LineRisk[] = [];
  const flag = line.qty_flag ? String(line.qty_flag) : '';
  if (flag) risks.push({ code: 'qty_flag', flag, note: line.qty_flag_note ?? null });

  if (!flag && line.onec_guid && line.onec_unit && line.unit && !sameUnit(line.unit, line.onec_unit)) {
    const toKg = opts.allKg && sameUnit(line.unit, 'кг');
    risks.push({ code: toKg ? 'unit_to_kg' : 'unit_mismatch', onec_unit: line.onec_unit });
  }

  if (!flag && line.onec_guid) {
    const pct = priceDeviationPct(line);
    if (pct != null) {
      const ratio = Number(line.price) / Number(line.median_price);
      if (ratio >= PRICE_OUTLIER_RATIO || ratio <= 1 / PRICE_OUTLIER_RATIO) {
        risks.push({ code: 'price_outlier', ratio: Math.round(ratio * 100) / 100, median_price: Number(line.median_price) });
      }
    }
  }

  if (line.onec_guid) {
    const conf = Number(line.mapping_confidence ?? 0);
    if (conf < LOW_CONFIDENCE) risks.push({ code: 'low_confidence', confidence: Math.round(conf * 100) / 100 });
  } else if (!Number(line.name_overridden ?? 0)) {
    const key = newItemGroupKey(line.original_name);
    if (!key || !pendingNewItemKeys.has(key)) risks.push({ code: 'new_item' });
  }
  return risks;
}

export interface QueueLineSummary {
  lines: number;
  /** Строки без позиции 1С (как считает гейт: onec_guid пуст). */
  unmapped: number;
  /** Из них без своего названия для 1С (и без «Создать в 1С») — их берёт подбор ИИ. */
  unmapped_open: number;
  /** Строки с флагом пересчёта единиц (qty_flag). */
  flagged: number;
  risky_lines: number;
  legacy_lines: number;
  risk_counts: Record<LineRiskCode, number>;
}

export function summarizeLines(lines: RiskLine[], pendingNewItemKeys: ReadonlySet<string> = new Set(), opts: RiskOptions = {}): QueueLineSummary {
  const counts = Object.fromEntries(LINE_RISK_CODES.map(c => [c, 0])) as Record<LineRiskCode, number>;
  let risky = 0;
  let legacy = 0;
  for (const l of lines) {
    const r = lineRisks(l, pendingNewItemKeys, opts);
    if (r.length) risky++;
    for (const x of r) counts[x.code]++;
    if (isLegacyLine(l)) legacy++;
  }
  return {
    lines: lines.length,
    unmapped: lines.filter(l => !l.onec_guid).length,
    unmapped_open: lines.filter(l => !l.onec_guid && !Number(l.name_overridden ?? 0)).length,
    flagged: lines.filter(l => !!l.qty_flag).length,
    risky_lines: risky,
    legacy_lines: legacy,
    risk_counts: counts,
  };
}

// ── Готовность к 1С ──────────────────────────────────────────────────────────

export interface QueueReason {
  code: string;
  message: string;
  /**
   * Одобрить нельзя: 1С такую накладную не примет (нет реквизитов или строк)
   * или одобрение требует согласования по сумме. Массовое одобрение со
   * страницы очереди такие пропускает; остальные — после подтверждения.
   */
  hard: boolean;
}

/** Причины гейта автопилота, которые к ручной отправке не относятся. */
const AUTOPILOT_ONLY = new Set(['amount_limit']);

/** Коды причин, при которых накладную нельзя одобрить из очереди (см. QueueReason.hard). */
export const HARD_REASONS: ReadonlySet<string> = new Set([
  'status', 'duplicate', 'invoice_number', 'invoice_date', 'supplier', 'supplier_inn', 'total', 'items',
  'approval_required', 'incomplete_pages',
]);

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

const nLines = (n: number) => `${n} ${plural(n, 'строка', 'строки', 'строк')}`;

export interface QueueReasonInput {
  /** Причины evaluateInvoiceQuality (как их видит автопилот). */
  gate: ReadonlyArray<{ code: string; message: string }>;
  supplier_inn: string | null;
  /** invoices.onec_status / onec_error — что ответила 1С при прошлой загрузке. */
  onec_status?: string | null;
  onec_error?: string | null;
  risk_counts: Record<LineRiskCode, number>;
}

/**
 * Что держит накладную: причины гейта автопилота (без чисто «автопилотных»,
 * например лимита суммы автоотправки) + то, чего гейт не проверяет:
 *   - нет ИНН поставщика — 1С не найдёт и не создаст контрагента
 *     (форма «Дозаполните реквизиты» в карточке требует его же);
 *   - 1С вернула ошибку при прошлой загрузке;
 *   - единица строки не совпадает с единицей позиции 1С и цена выбивается в
 *     разы — так выглядели строки до v2, из-за которых в 1С уходило
 *     «60 шт батона → 1440 кг».
 */
export function queueReasons(input: QueueReasonInput): QueueReason[] {
  const out: QueueReason[] = [];
  const add = (code: string, message: string) => out.push({ code, message, hard: HARD_REASONS.has(code) });
  for (const r of input.gate) {
    if (AUTOPILOT_ONLY.has(r.code)) continue;
    add(r.code, r.message);
  }
  if (!String(input.supplier_inn ?? '').trim()) add('supplier_inn', 'Нет ИНН поставщика — 1С не примет накладную');
  if (input.onec_status === 'error' || input.onec_status === 'rejected') {
    const detail = String(input.onec_error ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    add('onec_error', `1С вернула ошибку при загрузке${detail ? `: ${detail}` : ''}`);
  }
  const um = input.risk_counts.unit_mismatch ?? 0;
  if (um > 0) add('unit_mismatch', `Единица не совпадает с единицей позиции 1С: ${nLines(um)} — проверьте количество`);
  const tk = input.risk_counts.unit_to_kg ?? 0;
  if (tk > 0) add('unit_to_kg', `1С переведёт позицию на кг: ${nLines(tk)} — остаток в прежней единице проверьте инвентаризацией`);
  const po = input.risk_counts.price_outlier ?? 0;
  if (po > 0) add('price_outlier', `Цена за единицу в 3 раза и больше отличается от обычной: ${nLines(po)}`);
  return out;
}

export type QueueState = 'ready' | 'blocked' | 'approved';

/** Одобрена и ждёт 1С / готова (замечаний нет) / есть замечания. */
export function queueState(inv: { approved_for_1c: number | boolean | null }, reasons: ReadonlyArray<QueueReason>): QueueState {
  if (Number(inv.approved_for_1c ?? 0)) return 'approved';
  return reasons.length ? 'blocked' : 'ready';
}

/** Файлы накладной: file_name — список через запятую (многостраничная). */
export function invoiceFiles(fileName: string | null | undefined): string[] {
  return String(fileName ?? '').split(',').map(s => s.trim()).filter(Boolean);
}
