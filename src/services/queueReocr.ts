import fs from 'fs';
import crypto from 'crypto';
import { config } from '../config';
import { logger } from '../utils/logger';
import { invoiceRepo, type Invoice, type InvoiceItem, type ItemConversionColumns } from '../database/repositories/invoiceRepo';
import { queueRepo, QueueReplaceConflict, type ReocrRow, type ReocrListRow, type ReplacementLine } from '../database/repositories/queueRepo';
import { onecNomenclatureRepo, type OnecNomenclatureRow } from '../database/repositories/onecNomenclatureRepo';
import { mappingRepo } from '../database/repositories/mappingRepo';
import { ocrCorrectionRepo } from '../database/repositories/ocrCorrectionRepo';
import { makeSupplierKey } from '../database/repositories/supplierMappingRepo';
import { logEdit } from '../database/repositories/editLogRepo';
import { OcrManager } from '../ocr/ocrManager';
import { analyzeImageWithVerification, analyzeMultiPageTextWithVerification, type CatalogEntry } from '../ocr/claudeApiAnalyzer';
import { isGptModel, visionModelFor } from '../ocr/gptVision';
import type { ParsedInvoiceData } from '../ocr/types';
import { buildSupplierMemory } from '../learning/supplierMemory';
import type { MappingResult, NomenclatureMapper } from '../mapping/nomenclatureMapper';
import { itemNameKey } from '../mapping/nameKey';
import { sanitizeInvoiceVat, sanitizeItemVatPerItem, sanitizeItemArithmetic } from '../parser/itemSanitizer';
import { normalizeInvoiceNumber } from '../utils/invoiceNumber';
import { toNumber, toText, normalizeDate, normalizeInn } from '../golden/compare';
import { isXmlInvoice } from '../xml';
import { locateGoldenPhoto } from '../golden/goldenRunner';
import { recomputeMedianForGuids } from '../pricing/priceStats';
import { convertInvoiceLine } from './lineConversion';
import { getEngineFlags } from './engineFlags';
import { checkLlmPick } from './llmPickGuard';
import { isWorkable, sameUnit, invoiceFiles } from './queue';
import { startQueueJob, assertQueueJobFree, activeQueueJob, viewQueueJob, QueueStartError, type QueueJobResult, type QueueJobView } from './queueJobs';

/**
 * «Перераспознать очередь» (агент A, п.4 дизайна 2026-09-29).
 *
 * Строки накладных очереди записаны старым кодом (conv_source='legacy_stored'),
 * их значениям «как в накладной» доверять нельзя. Здесь фото накладной заново
 * распознаётся ТЕКУЩИМ боевым путём (claude_api: предобработка → Claude с
 * каталогом 1С и памяткой поставщиков → проверка и до-чтение), а из ответа
 * тем же конвейером, что при приёме (санитайзеры НДС и арифметики → подбор
 * позиции 1С с проверками v2 → пересчёт единиц convertInvoiceLine), строятся
 * ПРЕДЛОЖЕННЫЕ строки. Они сравниваются с текущими и лежат в
 * queue_reocr_results до решения человека.
 *
 * Жёсткие правила:
 *   - шапку накладной (номер, дата, поставщик, ИНН, суммы, НДС) перераспознавание
 *     не меняет никогда — расхождения шапки только показываются;
 *   - строки заменяются только по кнопке «Применить» для одной накладной,
 *     одной транзакцией, с журналом правок; прежние строки сохраняются
 *     (queue_reocr_results.replaced) и возвращаются кнопкой «Вернуть прежние»;
 *   - накладные, уже одобренные или отправленные в 1С, не трогаем;
 *   - строго по одной накладной, одна задача на сервер (src/services/queueJobs.ts);
 *   - фото удалено по сроку хранения → «фото нет», накладная пропускается.
 * Предложения не учат систему (не пишут выученных сопоставлений), кроме
 * того, что делает сам NomenclatureMapper.map при любом подборе.
 */

export const PAGE_SEPARATOR = '\n\n--- СТРАНИЦА ---\n\n';

export type MapperLike = Pick<NomenclatureMapper, 'map' | 'mapSupplierOverride'>;

export interface ProposedLine {
  original_name: string;
  mapped_name: string | null;
  onec_guid: string | null;
  mapping_confidence: number;
  mapping_source: MappingResult['source'];
  quantity: number | null;
  unit: string | null;
  price: number | null;
  total: number | null;
  vat_rate: number | null;
  conversion: ItemConversionColumns;
}

// ── Строки из ответа модели ─────────────────────────────────────────────────

export interface ProposalInvoice {
  owner_user_id: number | null;
  supplier_inn: string | null;
  supplier: string | null;
  total_sum: number | null;
  vat_sum: number | null;
}

function resolveCatalogIdx(
  idx: number | null | undefined,
  catalog: ReadonlyArray<Pick<OnecNomenclatureRow, 'guid' | 'name' | 'unit'>> | null,
): { guid: string; name: string } | undefined {
  if (!catalog || idx == null || !Number.isFinite(idx)) return undefined;
  const row = catalog[idx - 1];
  return row ? { guid: row.guid, name: row.name } : undefined;
}

/**
 * Позиция 1С, которую Claude выбрал при распознавании, — как
 * FileWatcher.pickWithLlm, но без записи выученного правила и счётчиков:
 * это пока только предложение.
 */
async function proposeLlmPick(
  name: string,
  pick: { guid: string; name: string },
  ownerUserId: number,
  context: { supplierInn: string | null; supplierName: string | null },
  mapper: MapperLike,
  mappingV2: boolean,
): Promise<MappingResult> {
  if (mappingV2) {
    const verdict = await checkLlmPick(name, pick, ownerUserId);
    if (verdict.kind === 'confirmed') {
      return {
        original_name: name, mapped_name: verdict.name, onec_guid: verdict.guid, confidence: 1,
        source: 'learned', mapping_id: verdict.mappingId, pack_size: verdict.packSize, pack_unit: verdict.packUnit,
      };
    }
    if (verdict.kind !== 'accept') return mapper.map(name, ownerUserId, context);
  }
  const existing = await mappingRepo.getByScannedName(name, ownerUserId);
  return {
    original_name: name, mapped_name: pick.name, onec_guid: pick.guid, confidence: 1, source: 'learned',
    mapping_id: existing?.id ?? null, pack_size: existing?.pack_size ?? null, pack_unit: existing?.pack_unit ?? null,
  };
}

/**
 * Предложенные строки — тем же путём, что строки при приёме фото
 * (FileWatcher.processFile / reprocessInvoice). Отличия намеренные:
 * поставщик для подбора и правил — из шапки накладной (она остаётся, и
 * привязана к справочнику), а суммы для санитайзеров НДС — из распознанного
 * (как при приёме), с запасным значением из шапки.
 */
export async function buildProposedLines(
  parsed: ParsedInvoiceData,
  invoice: ProposalInvoice,
  deps: { mapper: MapperLike; catalog: ReadonlyArray<Pick<OnecNomenclatureRow, 'guid' | 'name' | 'unit'>> | null },
): Promise<ProposedLine[]> {
  const owner = invoice.owner_user_id ?? -1;
  const items = Array.isArray(parsed.items) ? parsed.items.filter(it => it != null && typeof it === 'object') : [];
  const docTotal = toNumber(parsed.total_sum) ?? invoice.total_sum;
  const docVat = toNumber(parsed.vat_sum) ?? invoice.vat_sum;

  const vatSanity = sanitizeInvoiceVat(
    items.map(i => ({ quantity: i.quantity, unit: i.unit, price: i.price, total: i.total })),
    docTotal,
    docVat,
  );
  const perItemVat = sanitizeItemVatPerItem(
    vatSanity.items.map((i, k) => ({ quantity: i.quantity, unit: i.unit, price: i.price, total: i.total, vat_rate: items[k]?.vat_rate })),
    docTotal,
  );

  const mappingV2 = (await getEngineFlags()).mapping_v2;
  const context = { supplierInn: invoice.supplier_inn, supplierName: invoice.supplier };
  const supplierKey = makeSupplierKey(invoice.supplier_inn, invoice.supplier);
  const out: ProposedLine[] = [];
  for (let k = 0; k < items.length; k++) {
    const orig = items[k];
    if (!orig.name) continue;
    const sanity = sanitizeItemArithmetic({
      quantity: orig.quantity,
      unit: orig.unit,
      price: perItemVat.items[k]?.price ?? orig.price,
      total: perItemVat.items[k]?.total ?? orig.total,
    });

    let mapping: MappingResult;
    const override = await deps.mapper.mapSupplierOverride(orig.name, owner, context);
    if (override) {
      mapping = override;
    } else {
      const pick = resolveCatalogIdx(orig.catalog_idx, deps.catalog);
      mapping = pick
        ? await proposeLlmPick(orig.name, pick, owner, context, deps.mapper, mappingV2)
        : await deps.mapper.map(orig.name, owner, context);
    }

    const conv = await convertInvoiceLine({
      ownerUserId: owner > 0 ? owner : null,
      supplierKey,
      name: orig.name,
      raw: {
        quantity: sanity.item.quantity ?? null,
        unit: sanity.item.unit ?? null,
        price: sanity.item.price ?? null,
        total: sanity.item.total ?? null,
      },
      onecGuid: mapping.onec_guid ?? null,
      mappedName: mapping.mapped_name ?? null,
      mapping: { mapping_id: mapping.mapping_id ?? null, pack_size: mapping.pack_size ?? null, pack_unit: mapping.pack_unit ?? null },
      llmPackHint: orig.pack_size ?? null,
    });

    out.push({
      original_name: orig.name,
      mapped_name: mapping.mapped_name ?? null,
      onec_guid: mapping.onec_guid ?? null,
      mapping_confidence: Number(mapping.confidence) || 0,
      mapping_source: mapping.source,
      quantity: conv.quantity,
      unit: conv.unit,
      price: conv.price,
      total: conv.total,
      vat_rate: toNumber(orig.vat_rate),
      conversion: conv.conversion,
    });
  }
  return out;
}

// ── Сравнение ────────────────────────────────────────────────────────────────

export type HeaderField = 'invoice_number' | 'invoice_date' | 'supplier_inn' | 'total_sum' | 'vat_sum';

export interface HeaderDiffEntry {
  field: HeaderField;
  stored: string | number | null;
  recognized: string | number | null;
}

export interface HeaderLike {
  invoice_number: string | null;
  invoice_date: string | null;
  supplier_inn: string | null;
  total_sum: number | null;
  vat_sum: number | null;
}

const MONEY_TOL = 0.01;
const QTY_TOL = 0.001;
const EPS = 1e-9;

function numClose(a: unknown, b: unknown, tol: number): boolean {
  const x = toNumber(a);
  const y = toNumber(b);
  if (x == null || y == null) return x == null && y == null;
  return Math.abs(x - y) <= tol + EPS;
}

/**
 * Чем распознанная шапка отличается от сохранённой — только для показа.
 * Пустое в распознанном расхождением не считается (модель могла не прочитать).
 */
export function headerDiff(stored: HeaderLike, parsed: ParsedInvoiceData): HeaderDiffEntry[] {
  const out: HeaderDiffEntry[] = [];
  const num = toText(parsed.invoice_number);
  if (num && normalizeInvoiceNumber(num) !== normalizeInvoiceNumber(stored.invoice_number)) {
    out.push({ field: 'invoice_number', stored: stored.invoice_number ?? null, recognized: num });
  }
  const date = toText(parsed.invoice_date);
  if (date && normalizeDate(date) !== normalizeDate(toText(stored.invoice_date))) {
    out.push({ field: 'invoice_date', stored: stored.invoice_date ?? null, recognized: date });
  }
  const inn = toText(parsed.supplier_inn);
  if (inn && normalizeInn(inn) !== normalizeInn(stored.supplier_inn)) {
    out.push({ field: 'supplier_inn', stored: stored.supplier_inn ?? null, recognized: inn });
  }
  for (const f of ['total_sum', 'vat_sum'] as const) {
    const rec = toNumber(parsed[f]);
    if (rec != null && !numClose(stored[f], rec, MONEY_TOL)) out.push({ field: f, stored: toNumber(stored[f]), recognized: rec });
  }
  return out;
}

export interface CurrentLineLike {
  id: number;
  original_name: string | null;
  mapped_name: string | null;
  onec_guid: string | null;
  quantity: number | null;
  unit: string | null;
  price: number | null;
  total: number | null;
  vat_rate: number | null;
  conv_source?: string | null;
  name_overridden?: number | null;
}

export type DiffField = 'name' | 'quantity' | 'unit' | 'price' | 'total' | 'vat_rate' | 'onec';

export interface DiffCurrent {
  id: number;
  original_name: string | null;
  mapped_name: string | null;
  onec_guid: string | null;
  quantity: number | null;
  unit: string | null;
  price: number | null;
  total: number | null;
  vat_rate: number | null;
  /** Строку правили руками (количество/своё название) — при применении правка пропадёт. */
  manual: boolean;
}

export interface DiffProposed {
  index: number;
  original_name: string;
  mapped_name: string | null;
  onec_guid: string | null;
  quantity: number | null;
  unit: string | null;
  price: number | null;
  total: number | null;
  vat_rate: number | null;
  mapping_source: string;
  mapping_confidence: number;
  raw_quantity: number | null;
  raw_unit: string | null;
  conv_note: string | null;
  qty_flag: string | null;
  qty_flag_note: string | null;
}

export interface DiffRow {
  kind: 'same' | 'changed' | 'added' | 'removed';
  current: DiffCurrent | null;
  proposed: DiffProposed | null;
  fields: DiffField[];
}

export interface LinesDiffSummary {
  current: number;
  proposed: number;
  same: number;
  changed: number;
  added: number;
  removed: number;
  manual_lines: number;
  sum_current: number;
  sum_proposed: number;
}

export interface LinesDiff {
  rows: DiffRow[];
  summary: LinesDiffSummary;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const normName = (s: string | null | undefined) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

function keyTokens(name: string | null | undefined): { key: string; tokens: Set<string> } {
  const key = itemNameKey(String(name ?? ''));
  return { key, tokens: new Set(key ? key.split(' ') : []) };
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Один и тот же товар в двух чтениях: тот же ключ названия или ≥60% общих слов. */
function sameItem(a: { key: string; tokens: Set<string> }, b: { key: string; tokens: Set<string> }): boolean {
  if (a.key && a.key === b.key) return true;
  return jaccard(a.tokens, b.tokens) >= 0.6;
}

function sameOnec(c: { onec_guid: string | null; mapped_name: string | null }, p: { onec_guid: string | null; mapped_name: string | null }): boolean {
  // Строка без позиции уходит в 1С «новой» под своим названием — тогда важно название.
  if (c.onec_guid || p.onec_guid) return (c.onec_guid || null) === (p.onec_guid || null);
  return normName(c.mapped_name) === normName(p.mapped_name);
}

function toCurrent(c: CurrentLineLike): DiffCurrent {
  return {
    id: c.id,
    original_name: c.original_name ?? null,
    mapped_name: c.mapped_name ?? null,
    onec_guid: c.onec_guid ?? null,
    quantity: toNumber(c.quantity),
    unit: c.unit ?? null,
    price: toNumber(c.price),
    total: toNumber(c.total),
    vat_rate: toNumber(c.vat_rate),
    manual: c.conv_source === 'manual' || Number(c.name_overridden ?? 0) === 1,
  };
}

function toProposed(p: ProposedLine, index: number): DiffProposed {
  return {
    index,
    original_name: p.original_name,
    mapped_name: p.mapped_name,
    onec_guid: p.onec_guid,
    quantity: toNumber(p.quantity),
    unit: p.unit,
    price: toNumber(p.price),
    total: toNumber(p.total),
    vat_rate: toNumber(p.vat_rate),
    mapping_source: p.mapping_source,
    mapping_confidence: p.mapping_confidence,
    raw_quantity: toNumber(p.conversion?.raw_quantity),
    raw_unit: p.conversion?.raw_unit ?? null,
    conv_note: p.conversion?.conv_note ?? null,
    qty_flag: p.conversion?.qty_flag ?? null,
    qty_flag_note: p.conversion?.qty_flag_note ?? null,
  };
}

function compareLines(c: DiffCurrent, p: DiffProposed, sameName: boolean): DiffRow {
  const fields: DiffField[] = [];
  if (!sameName) fields.push('name');
  if (!numClose(c.quantity, p.quantity, QTY_TOL)) fields.push('quantity');
  if (!(c.unit == null && p.unit == null) && !(c.unit != null && p.unit != null && sameUnit(c.unit, p.unit))) fields.push('unit');
  if (!numClose(c.price, p.price, MONEY_TOL)) fields.push('price');
  if (!numClose(c.total, p.total, MONEY_TOL)) fields.push('total');
  if (!numClose(c.vat_rate, p.vat_rate, QTY_TOL)) fields.push('vat_rate');
  if (!sameOnec(c, p)) fields.push('onec');
  return { kind: fields.length ? 'changed' : 'same', current: c, proposed: p, fields };
}

/**
 * Сравнить текущие строки с предложенными. Строки сопоставляются по порядку
 * через наибольшую общую подпоследовательность «того же товара» (ключ
 * названия или ≥60% общих слов); между опорными парами оставшиеся строки
 * сводятся по позиции (товар прочитан иначе — «изменено: название»), лишние —
 * «удалена» / «новая».
 */
export function diffLines(currentLines: CurrentLineLike[], proposedLines: ProposedLine[]): LinesDiff {
  const cur = currentLines.map(toCurrent);
  const prop = proposedLines.map(toProposed);
  const ck = currentLines.map(c => keyTokens(c.original_name));
  const pk = proposedLines.map(p => keyTokens(p.original_name));
  const n = cur.length;
  const m = prop.length;

  const dp: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = sameItem(ck[i], pk[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const anchors: Array<[number, number]> = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (sameItem(ck[i], pk[j]) && dp[i][j] === dp[i + 1][j + 1] + 1) {
      anchors.push([i, j]);
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }

  const rows: DiffRow[] = [];
  let ci = 0;
  let pj = 0;
  for (const [ai, aj] of [...anchors, [n, m] as [number, number]]) {
    const gapC = ai - ci;
    const gapP = aj - pj;
    const paired = Math.min(gapC, gapP);
    for (let t = 0; t < paired; t++) rows.push(compareLines(cur[ci + t], prop[pj + t], false));
    for (let t = paired; t < gapC; t++) rows.push({ kind: 'removed', current: cur[ci + t], proposed: null, fields: [] });
    for (let t = paired; t < gapP; t++) rows.push({ kind: 'added', current: null, proposed: prop[pj + t], fields: [] });
    if (ai < n && aj < m) rows.push(compareLines(cur[ai], prop[aj], true));
    ci = ai + 1;
    pj = aj + 1;
  }

  const count = (k: DiffRow['kind']) => rows.filter(r => r.kind === k).length;
  return {
    rows,
    summary: {
      current: n,
      proposed: m,
      same: count('same'),
      changed: count('changed'),
      added: count('added'),
      removed: count('removed'),
      manual_lines: cur.filter(c => c.manual).length,
      sum_current: round2(cur.reduce((s, c) => s + (c.total ?? 0), 0)),
      sum_proposed: round2(prop.reduce((s, p) => s + (p.total ?? 0), 0)),
    },
  };
}

/**
 * Отпечаток строк накладной: по нему видно, что строки изменили после
 * сравнения, и «Применить» не заменит строки, которых человек не видел.
 */
export function linesFingerprint(items: CurrentLineLike[]): string {
  const rows = [...items]
    .sort((a, b) => a.id - b.id)
    .map(i => [i.id, i.original_name ?? null, i.mapped_name ?? null, i.onec_guid ?? null,
      toNumber(i.quantity), i.unit ?? null, toNumber(i.price), toNumber(i.total), toNumber(i.vat_rate)]);
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

export function parseProposed(json: string | null | undefined): ProposedLine[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter(x => x && typeof x === 'object' && typeof x.original_name === 'string') as ProposedLine[] : [];
  } catch {
    return [];
  }
}

function parseJson<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try { return JSON.parse(json) as T; } catch { return fallback; }
}

export interface ReocrSummary extends LinesDiffSummary {
  header_diff: number;
}

export interface ReocrView {
  id: number;
  status: ReocrRow['status'];
  model: string | null;
  pages: number | null;
  started_at: string;
  finished_at: string | null;
  applied_at: string | null;
  error: string | null;
  /** Итоги сравнения на момент перераспознавания. */
  summary: ReocrSummary | null;
  header_diff: HeaderDiffEntry[];
  /** Строки накладной меняли после перераспознавания (сравнение ниже — уже с текущими). */
  stale: boolean;
  /** Живое сравнение с текущими строками (только в карточке накладной). */
  diff?: LinesDiff;
  /** Отпечаток текущих строк — вернуть в POST …/reocr/apply и …/reocr/revert. */
  fingerprint?: string;
  can_apply?: boolean;
  /** Применено, прежние строки сохранены, накладная ещё не одобрена — можно вернуть. */
  can_revert?: boolean;
  /** Сколько строк вернёт «Вернуть прежние строки» и на какую сумму. */
  replaced_summary?: { lines: number; sum: number };
}

/**
 * Результат для API. currentItems — текущие строки накладной (для живого
 * сравнения и stale); workable — накладная не одобрена и не ушла в 1С (иначе
 * строки не меняем: ни применить, ни вернуть).
 */
export function reocrView(
  row: ReocrRow | ReocrListRow | undefined,
  currentItems?: CurrentLineLike[],
  opts: { withDiff?: boolean; workable?: boolean } = {},
): ReocrView | null {
  if (!row) return null;
  const fingerprint = currentItems ? linesFingerprint(currentItems) : undefined;
  const view: ReocrView = {
    id: row.id,
    status: row.status,
    model: row.model,
    pages: row.pages,
    started_at: row.started_at,
    finished_at: row.finished_at,
    applied_at: row.applied_at,
    error: row.error,
    summary: parseJson<ReocrSummary | null>(row.summary, null),
    header_diff: parseJson<HeaderDiffEntry[]>(row.header_diff, []),
    stale: row.status === 'done' && !row.applied_at && fingerprint != null && row.lines_fingerprint != null
      && fingerprint !== row.lines_fingerprint,
  };
  if (opts.withDiff && currentItems && row.status === 'done' && 'proposed' in row) {
    const diff = diffLines(currentItems, parseProposed(row.proposed));
    view.diff = diff;
    view.fingerprint = fingerprint;
    const s = diff.summary;
    view.can_apply = !row.applied_at && opts.workable !== false && s.proposed > 0 && (s.changed + s.added + s.removed) > 0;
    if (row.applied_at) {
      const previous = parseReplaced(row.replaced);
      view.replaced_summary = { lines: previous.length, sum: round2(previous.reduce((acc, p) => acc + (toNumber(p.total) ?? 0), 0)) };
      view.can_revert = opts.workable !== false && previous.length > 0;
    }
  }
  return view;
}

/** Прежние строки, сохранённые при применении (полные строки invoice_items). */
export function parseReplaced(json: string | null | undefined): InvoiceItem[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter(x => x && typeof x === 'object' && typeof x.original_name === 'string') as InvoiceItem[] : [];
  } catch {
    return [];
  }
}

// ── Перераспознавание одной накладной ────────────────────────────────────────

export interface RecognizeContext {
  apiKey: string;
  model: string;
  memory: string;
  /** Каталог 1С в том порядке, в каком он ушёл в запрос ([] — подбор ИИ выключен). */
  catalog: CatalogEntry[];
}

export interface ReocrDeps {
  /** Найти фото на диске (только чтение). null — файла нет. */
  locatePhoto: (fileName: string, filePath: string | null) => string | null;
  loadCatalog: (ownerUserId: number) => Promise<OnecNomenclatureRow[]>;
  /** Одна страница: боевой путь claude_api. Бросает, если распознать не удалось. */
  recognizePage: (photoPath: string, rc: RecognizeContext) => Promise<{ text: string; parsed: ParsedInvoiceData }>;
  /** Многостраничная: сшить ответы страниц (как FileWatcher.reprocessInvoice). */
  mergePages: (combinedText: string, pageCount: number, rc: RecognizeContext) => Promise<ParsedInvoiceData>;
  /** Подождать, пока распознаются новые загрузки: очередь им уступает (правило 21 — память). */
  waitForIdle?: () => Promise<void>;
}

const IDLE_POLL_MS = 5_000;
const IDLE_MAX_WAIT_MS = 10 * 60_000;

/**
 * Фоновая задача очереди идёт час и дольше, а новые загрузки распознаются тут же,
 * в том же процессе: два распознавания разом приближают пик памяти к лимиту PM2
 * (правило 21). Поэтому перед каждой накладной очередь ждёт, пока текущие
 * распознавания закончатся (не дольше 10 минут — зависшую строку подметёт
 * markStaleAsFailed).
 */
async function waitForRecognitionIdle(): Promise<void> {
  const deadline = Date.now() + IDLE_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const busy = await invoiceRepo.countRecognizing(10).catch(() => 0);
    if (busy === 0) return;
    await new Promise(r => setTimeout(r, IDLE_POLL_MS));
  }
}

export interface ReocrRunContext {
  ownerUserId: number;
  startedBy: number | null;
  apiKey: string;
  model: string;
  memory: string;
  llmMapperEnabled: boolean;
  mapper: MapperLike;
}

// Свой OcrManager — ради preprocessImage (EXIF + поворот + resize/sharpen),
// как в прогоне эталонов. Движки внутри ленивые.
let sharedOcr: OcrManager | null = null;
function ocrManager(): OcrManager {
  if (!sharedOcr) sharedOcr = new OcrManager();
  return sharedOcr;
}

/** OcrManager.recognizeWithClaudeApi, но каталог — тот же массив, по которому потом читаем catalog_idx. */
async function recognizePageWithClaude(photoPath: string, rc: RecognizeContext): Promise<{ text: string; parsed: ParsedInvoiceData }> {
  const prepared = await ocrManager().preprocessImage(photoPath);
  try {
    const result = await analyzeImageWithVerification(prepared, rc.apiKey, rc.model, rc.catalog, rc.memory);
    if (!result.success || !result.data) throw new Error(result.error || 'Image analysis failed');
    return { text: result.rawText || JSON.stringify(result.data, null, 2), parsed: result.data };
  } finally {
    if (prepared !== photoPath) {
      try { fs.unlinkSync(prepared); } catch { /* временный файл — не критично */ }
    }
  }
}

/** OcrManager.analyzeMultiPageText с тем же каталогом. */
async function mergePagesWithClaude(combinedText: string, pageCount: number, rc: RecognizeContext): Promise<ParsedInvoiceData> {
  const result = await analyzeMultiPageTextWithVerification(combinedText, rc.apiKey, pageCount, rc.model, rc.catalog, rc.memory);
  if (!result.success || !result.data) throw new Error(result.error || 'Multi-page text analysis failed');
  return result.data;
}

export const defaultReocrDeps: ReocrDeps = {
  locatePhoto: locateGoldenPhoto,
  loadCatalog: (ownerUserId) => onecNomenclatureRepo.listItems({ ownerUserId, excludeFolders: true }),
  recognizePage: recognizePageWithClaude,
  mergePages: mergePagesWithClaude,
  waitForIdle: waitForRecognitionIdle,
};

/**
 * Выученные исправления OCR компании — как при приёме. Поставщик для ключа —
 * из шапки накладной (она остаётся). Копия: распознанное нужно и нетронутым.
 */
async function applyOcrCorrections(parsed: ParsedInvoiceData, inv: Invoice): Promise<ParsedInvoiceData> {
  const copy = {
    ...parsed,
    supplier_inn: inv.supplier_inn ?? parsed.supplier_inn,
    supplier: inv.supplier ?? parsed.supplier,
    items: (Array.isArray(parsed.items) ? parsed.items : []).map(i => ({ ...i })),
  };
  return await ocrCorrectionRepo.apply(copy as unknown as Record<string, unknown>, inv.owner_user_id ?? -1) as unknown as ParsedInvoiceData;
}

/** Одна накладная. Никогда не бросает: ошибка — результат со status 'error'. */
export async function reocrInvoice(invoiceId: number, ctx: ReocrRunContext, deps: ReocrDeps = defaultReocrDeps): Promise<QueueJobResult> {
  const base = { invoice_id: invoiceId };
  let rowId: number | null = null;
  try {
    const inv = await invoiceRepo.getById(invoiceId);
    if (!inv || inv.owner_user_id !== ctx.ownerUserId) return { ...base, status: 'skipped', reason: 'not_found' };
    const files = invoiceFiles(inv.file_name);
    if (!isWorkable(inv)) {
      await queueRepo.recordReocrOutcome({
        ownerUserId: ctx.ownerUserId, invoiceId, startedBy: ctx.startedBy, status: 'skipped', pages: files.length,
        error: 'Накладная уже не в очереди — одобрена или отправлена в 1С',
      });
      return { ...base, status: 'skipped', reason: 'not_in_queue' };
    }
    // Электронный документ: числа взяты из самого XML, распознавать нечего.
    if (isXmlInvoice(inv)) {
      await queueRepo.recordReocrOutcome({
        ownerUserId: ctx.ownerUserId, invoiceId, startedBy: ctx.startedBy, status: 'skipped', pages: files.length,
        error: 'Электронный документ (XML) — строки взяты из самого документа, перераспознавать нечего',
      });
      return { ...base, status: 'skipped', reason: 'xml' };
    }
    const photos = files.map(f => deps.locatePhoto(f, inv.file_path ?? null));
    const found = photos.filter((p): p is string => !!p);
    if (!files.length || found.length < files.length) {
      const error = !files.length ? 'У накладной нет фото'
        : found.length ? `Нет фото ${files.length - found.length} из ${files.length} страниц — удалены по сроку хранения`
          : 'Фото нет — удалено по сроку хранения';
      await queueRepo.recordReocrOutcome({ ownerUserId: ctx.ownerUserId, invoiceId, startedBy: ctx.startedBy, status: 'no_photo', pages: files.length, error });
      return { ...base, status: 'no_photo', error };
    }

    if (deps.waitForIdle) await deps.waitForIdle();
    rowId = await queueRepo.startReocr({ ownerUserId: ctx.ownerUserId, invoiceId, startedBy: ctx.startedBy, model: ctx.model, pages: found.length });
    const catalogRows = ctx.llmMapperEnabled ? await deps.loadCatalog(ctx.ownerUserId) : null;
    const rc: RecognizeContext = {
      apiKey: ctx.apiKey,
      model: ctx.model,
      memory: ctx.memory,
      catalog: (catalogRows ?? []).map(r => ({ guid: r.guid, name: r.name, unit: r.unit })),
    };
    let parsed: ParsedInvoiceData;
    if (found.length === 1) {
      parsed = (await deps.recognizePage(found[0], rc)).parsed;
    } else {
      const texts: string[] = [];
      for (const p of found) texts.push((await deps.recognizePage(p, rc)).text);
      parsed = await deps.mergePages(texts.join(PAGE_SEPARATOR), found.length, rc);
    }

    const corrected = await applyOcrCorrections(parsed, inv);
    const proposed = await buildProposedLines(corrected, inv, { mapper: ctx.mapper, catalog: catalogRows });
    const current = await invoiceRepo.getItems(invoiceId);
    const diff = diffLines(current, proposed);
    const header = headerDiff(inv, parsed);
    const summary: ReocrSummary = { ...diff.summary, header_diff: header.length };
    await queueRepo.finishReocr(rowId, {
      status: 'done', linesFingerprint: linesFingerprint(current), summary, headerDiff: header, proposed,
    });
    logger.info('Queue re-OCR: invoice compared', { invoiceId, ...summary });
    return {
      ...base, status: 'done',
      changed: summary.changed, added: summary.added, removed: summary.removed, header_diff: summary.header_diff,
    };
  } catch (err) {
    const message = ((err as Error).message || String(err)).slice(0, 500);
    logger.warn('Queue re-OCR: invoice failed', { invoiceId, error: message });
    if (rowId != null) {
      try {
        await queueRepo.finishReocr(rowId, { status: 'error', error: message });
      } catch (e) {
        logger.error('Queue re-OCR: could not record failure', { invoiceId, error: (e as Error).message });
      }
    }
    return { ...base, status: 'error', error: message };
  }
}

// ── Запуск ───────────────────────────────────────────────────────────────────

/**
 * Строки 'running', которые никто не выполняет (перезапуск процесса посреди
 * прогона), — в ошибку. Пока у компании идёт своё перераспознавание — не трогаем:
 * процесс один (PM2 instances: 1), поэтому «не идёт здесь» = «оборвано».
 */
export async function reconcileInterruptedReocr(ownerUserId: number): Promise<number> {
  const job = activeQueueJob();
  if (job && job.kind === 'reocr' && job.ownerUserId === ownerUserId) return 0;
  return queueRepo.markInterruptedReocr(ownerUserId);
}

/**
 * Запустить перераспознавание очереди компании (или выбранных накладных из
 * неё) в фоне. Модель, ключ и памятка поставщиков берутся один раз на прогон.
 *
 * Без invoiceIds — вся очередь, кроме накладных, у которых последнее
 * перераспознавание уже дало результат (предложение, применено, нет фото):
 * так прогон, оборванный перезапуском сервера (выкладка — каждый push в main),
 * продолжается, а не начинается заново. redo — всё равно заново всю очередь.
 * С invoiceIds — ровно выбранные (человек сам попросил ещё раз).
 */
export async function startQueueReocr(
  opts: { ownerUserId: number; startedBy: number | null; invoiceIds?: number[] | null; redo?: boolean; mapper: MapperLike },
  deps: ReocrDeps = defaultReocrDeps,
): Promise<{ job: QueueJobView; planned: number }> {
  assertQueueJobFree(opts.ownerUserId);
  const cfg = await invoiceRepo.getAnalyzerConfig();
  // Та же модель, что читает фото в бою: в режиме gpt — GPT через шлюз ProjectsFlow.
  const { modelId, apiKey } = visionModelFor(cfg);
  if (!apiKey && !isGptModel(modelId)) throw new QueueStartError(400, 'Не задан API-ключ Anthropic — перераспознавание идёт через Anthropic API');
  const selected = opts.invoiceIds != null;
  const ids = await queueRepo.queueIds(opts.ownerUserId, selected
    ? { ids: opts.invoiceIds }
    : { skipDecided: !opts.redo });
  if (!ids.length) {
    throw new QueueStartError(400, selected
      ? 'Среди выбранных нет накладных, которые можно перераспознать: одобренные для 1С и отправленные не трогаем'
      : (opts.redo
        ? 'В очереди в 1С нет неодобренных накладных'
        : 'Перераспознавать нечего: у неодобренных накладных очереди уже есть результат — чтобы повторить, выберите накладные'));
  }
  await reconcileInterruptedReocr(opts.ownerUserId);
  const memory = await buildSupplierMemory(opts.ownerUserId);
  const ctx: ReocrRunContext = {
    ownerUserId: opts.ownerUserId,
    startedBy: opts.startedBy,
    apiKey,
    model: modelId,
    memory,
    llmMapperEnabled: cfg.llm_mapper_enabled,
    mapper: opts.mapper,
  };
  const { job } = startQueueJob({
    kind: 'reocr',
    ownerUserId: opts.ownerUserId,
    startedBy: opts.startedBy,
    invoiceIds: ids,
    meta: { model: modelId },
    worker: (invoiceId) => reocrInvoice(invoiceId, ctx, deps),
  });
  return { job: viewQueueJob(job), planned: ids.length };
}

// ── Применение и возврат ─────────────────────────────────────────────────────

export class ReocrApplyError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = 'ReocrApplyError';
  }
}

function toReplacementLine(p: ProposedLine): ReplacementLine {
  return {
    original_name: p.original_name,
    mapped_name: p.mapped_name,
    quantity: toNumber(p.quantity),
    unit: p.unit,
    price: toNumber(p.price),
    total: toNumber(p.total),
    vat_rate: toNumber(p.vat_rate),
    mapping_confidence: p.mapping_confidence,
    onec_guid: p.onec_guid,
    row_no: null,
    name_overridden: 0,
    conversion: {
      raw_quantity: toNumber(p.conversion?.raw_quantity),
      raw_unit: p.conversion?.raw_unit ?? null,
      raw_price: toNumber(p.conversion?.raw_price),
      raw_total: toNumber(p.conversion?.raw_total),
      conv_factor: toNumber(p.conversion?.conv_factor),
      conv_note: p.conversion?.conv_note ?? null,
      conv_source: p.conversion?.conv_source ?? null,
      qty_flag: p.conversion?.qty_flag ?? null,
      qty_flag_note: p.conversion?.qty_flag_note ?? null,
    },
  };
}

/** Сохранённая строка invoice_items → строка для вставки: все значения как были. */
function fromStoredItem(i: InvoiceItem): ReplacementLine {
  return {
    original_name: i.original_name,
    mapped_name: i.mapped_name ?? null,
    quantity: toNumber(i.quantity),
    unit: i.unit ?? null,
    price: toNumber(i.price),
    total: toNumber(i.total),
    vat_rate: toNumber(i.vat_rate),
    mapping_confidence: toNumber(i.mapping_confidence) ?? 0,
    onec_guid: i.onec_guid ?? null,
    row_no: toNumber(i.row_no),
    name_overridden: Number(i.name_overridden ?? 0) ? 1 : 0,
    conversion: {
      raw_quantity: toNumber(i.raw_quantity),
      raw_unit: i.raw_unit ?? null,
      raw_price: toNumber(i.raw_price),
      raw_total: toNumber(i.raw_total),
      conv_factor: toNumber(i.conv_factor),
      conv_note: i.conv_note ?? null,
      conv_source: i.conv_source ?? null,
      qty_flag: i.qty_flag ?? null,
      qty_flag_note: i.qty_flag_note ?? null,
    },
  };
}

type LineForLog = {
  original_name: string | null; mapped_name: string | null; onec_guid: string | null;
  quantity: number | null; unit: string | null; price: number | null; total: number | null; vat_rate: number | null;
};

function compactLine(l: LineForLog) {
  return {
    name: l.original_name, mapped: l.mapped_name, guid: l.onec_guid,
    qty: l.quantity, unit: l.unit, price: l.price, total: l.total, vat: l.vat_rate,
  };
}

const sumTotals = (list: Array<{ total: number | null }>) => round2(list.reduce((s, l) => s + (toNumber(l.total) ?? 0), 0));

function rateKey(rates: Array<number | null>): string {
  return [...new Set(rates.map(r => (r == null ? 'null' : String(Number(r)))))].sort().join(',');
}

/**
 * После замены строк: флаг «сумма строк расходится с итогом», отметка «ставка
 * НДС сверена», статистика цен. Шапку (итог, НДС) не пишет: keepVat — НДС
 * документа остаётся, а итог документа recalculateTotal не меняет, пока и он,
 * и сумма строк больше нуля. Иначе не зовём вовсе — итог «вывелся» бы из строк
 * (флаг расхождения тогда остаётся прежним — осторожная сторона).
 */
async function afterLinesReplaced(
  inv: Invoice,
  before: Array<{ onec_guid: string | null; vat_rate: number | null }>,
  after: Array<{ onec_guid: string | null; vat_rate: number | null; total: number | null }>,
): Promise<void> {
  if ((inv.total_sum ?? 0) > 0 && sumTotals(after) > 0) {
    await invoiceRepo.recalculateTotal(inv.id, { keepVat: true });
  }
  // Ставки НДС строк поменялись — отметка «ставка сверена с фото» больше не про них.
  if (rateKey(before.map(b => toNumber(b.vat_rate))) !== rateKey(after.map(a => toNumber(a.vat_rate)))) {
    await invoiceRepo.resetAttrChecks(inv.id, ['vat_rate']);
  }
  if (inv.owner_user_id != null) {
    const guids = [...before.map(b => b.onec_guid), ...after.map(a => a.onec_guid)];
    void recomputeMedianForGuids(guids, inv.owner_user_id).catch(() => { /* logged inside */ });
  }
}

function conflictToError(err: unknown): never {
  if (err instanceof QueueReplaceConflict) throw new ReocrApplyError(err.code === 'not_found' ? 404 : 409, err.code, err.message);
  throw err;
}

const NOT_WORKABLE = 'Накладная уже одобрена или отправлена в 1С — её строки не меняем. Чтобы поправить, отзовите одобрение в карточке накладной.';
const STALE = 'Строки накладной изменились после показа сравнения — обновите и проверьте ещё раз';

/**
 * Заменить строки накладной строками последнего перераспознавания. Шапка
 * (номер, дата, поставщик, ИНН, сумма, НДС) не записывается. fingerprint —
 * отпечаток строк, с которыми человек видел сравнение: если их с тех пор
 * меняли — отказ. Прежние строки ложатся в queue_reocr_results.replaced.
 */
export async function applyQueueReocr(opts: {
  ownerUserId: number;
  invoiceId: number;
  userId: number | null;
  fingerprint: string;
}): Promise<{ deleted: number; inserted: number; invoice: Invoice | undefined }> {
  const inv = await invoiceRepo.getById(opts.invoiceId);
  if (!inv || inv.owner_user_id !== opts.ownerUserId) throw new ReocrApplyError(404, 'not_found', 'Накладная не найдена');
  if (!isWorkable(inv)) throw new ReocrApplyError(409, 'not_in_queue', NOT_WORKABLE);
  const row = await queueRepo.latestReocr(opts.ownerUserId, opts.invoiceId);
  if (!row || row.status !== 'done') throw new ReocrApplyError(409, 'no_result', 'Для этой накладной нет готового перераспознавания');
  if (row.applied_at) throw new ReocrApplyError(409, 'already_applied', 'Это перераспознавание уже применено');
  const proposed = parseProposed(row.proposed);
  if (!proposed.length) throw new ReocrApplyError(409, 'empty', 'Перераспознавание не нашло строк — применять нечего');
  const sumProposed = sumTotals(proposed);
  if ((inv.total_sum ?? 0) > 0 && !(sumProposed > 0)) {
    throw new ReocrApplyError(409, 'no_totals', 'У строк перераспознавания нет сумм — применять нельзя');
  }
  const guids = proposed.map(p => p.onec_guid).filter((g): g is string => !!g);
  const existing = await queueRepo.existingGuids(opts.ownerUserId, guids);
  if (guids.some(g => !existing.has(g))) {
    throw new ReocrApplyError(409, 'catalog_changed', 'Каталог 1С изменился после перераспознавания — перераспознайте накладную ещё раз');
  }

  let before: InvoiceItem[] = [];
  try {
    ({ before } = await queueRepo.replaceItems({
      ownerUserId: opts.ownerUserId,
      invoiceId: opts.invoiceId,
      resultId: row.id,
      userId: opts.userId,
      mark: 'apply',
      lines: proposed.map(toReplacementLine),
      check: (state, items) => {
        if (!isWorkable(state)) throw new QueueReplaceConflict('not_in_queue', NOT_WORKABLE);
        if (linesFingerprint(items) !== opts.fingerprint) throw new QueueReplaceConflict('stale', STALE);
      },
    }));
  } catch (err) {
    conflictToError(err);
  }

  await afterLinesReplaced(inv, before, proposed);
  // newValue несёт номер результата: logEdit пропускает запись, если «было» и
  // «стало» совпадают, а число строк и сумма при исправлении единиц часто те же.
  await logEdit({
    ownerUserId: inv.owner_user_id, userId: opts.userId, invoiceId: opts.invoiceId,
    entity: 'item', field: 'reocr_apply',
    oldValue: { lines: before.length, sum: sumTotals(before) },
    newValue: { lines: proposed.length, sum: sumProposed, reocr_result: row.id },
    context: {
      result_id: row.id, model: row.model,
      supplier: inv.supplier, supplier_inn: inv.supplier_inn,
      before: before.map(compactLine),
      after: proposed.map(compactLine),
    },
  });
  logger.info('Queue re-OCR applied', { invoiceId: opts.invoiceId, resultId: row.id, deleted: before.length, inserted: proposed.length });
  return { deleted: before.length, inserted: proposed.length, invoice: await invoiceRepo.getById(opts.invoiceId) };
}

/**
 * Вернуть строки, которые были до применения перераспознавания (рычаг отката
 * без ручного SQL): последний результат применён, накладная ещё не одобрена.
 * Правки строк, сделанные после применения, тоже пропадут — поэтому человек
 * видит, что вернётся, и подтверждает отпечатком текущих строк.
 */
export async function revertQueueReocr(opts: {
  ownerUserId: number;
  invoiceId: number;
  userId: number | null;
  fingerprint: string;
}): Promise<{ deleted: number; inserted: number; invoice: Invoice | undefined }> {
  const inv = await invoiceRepo.getById(opts.invoiceId);
  if (!inv || inv.owner_user_id !== opts.ownerUserId) throw new ReocrApplyError(404, 'not_found', 'Накладная не найдена');
  if (!isWorkable(inv)) throw new ReocrApplyError(409, 'not_in_queue', NOT_WORKABLE);
  const row = await queueRepo.latestReocr(opts.ownerUserId, opts.invoiceId);
  if (!row || row.status !== 'done' || !row.applied_at) {
    throw new ReocrApplyError(409, 'not_applied', 'Возвращать нечего: последнее перераспознавание этой накладной не применялось');
  }
  const previous = parseReplaced(row.replaced);
  if (!previous.length) throw new ReocrApplyError(409, 'nothing_saved', 'Прежние строки не сохранились — вернуть нечего');

  let before: InvoiceItem[] = [];
  try {
    ({ before } = await queueRepo.replaceItems({
      ownerUserId: opts.ownerUserId,
      invoiceId: opts.invoiceId,
      resultId: row.id,
      userId: opts.userId,
      mark: 'revert',
      lines: previous.map(fromStoredItem),
      check: (state, items) => {
        if (!isWorkable(state)) throw new QueueReplaceConflict('not_in_queue', NOT_WORKABLE);
        if (linesFingerprint(items) !== opts.fingerprint) throw new QueueReplaceConflict('stale', STALE);
      },
    }));
  } catch (err) {
    conflictToError(err);
  }

  await afterLinesReplaced(inv, before, previous);
  await logEdit({
    ownerUserId: inv.owner_user_id, userId: opts.userId, invoiceId: opts.invoiceId,
    entity: 'item', field: 'reocr_revert',
    oldValue: { lines: before.length, sum: sumTotals(before), reocr_result: row.id },
    newValue: { lines: previous.length, sum: sumTotals(previous) },
    context: {
      result_id: row.id,
      supplier: inv.supplier, supplier_inn: inv.supplier_inn,
      before: before.map(compactLine),
      after: previous.map(compactLine),
    },
  });
  logger.info('Queue re-OCR reverted', { invoiceId: opts.invoiceId, resultId: row.id, deleted: before.length, inserted: previous.length });
  return { deleted: before.length, inserted: previous.length, invoice: await invoiceRepo.getById(opts.invoiceId) };
}
