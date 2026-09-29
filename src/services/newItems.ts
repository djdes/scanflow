import { itemNameKey } from '../mapping/nameKey';
import { canonUnit, type UnitClass } from '../mapping/unitConverter';
import { cleanItemName } from '../mapping/nameCleaner';

/**
 * «Новые товары» (пакет v2, п.12) — чистая логика, без БД.
 *
 * Строки без позиции 1С (onec_guid IS NULL) из неотправленных накладных
 * группируются по ключу товара (itemNameKey): «Капуста морская (3 кг)» и
 * «КАПУСТА МОРСКАЯ 3кг» — одна группа. По группе человек решает один раз:
 * сопоставить с существующей позицией 1С или попросить 1С создать новую с
 * нужными названием, единицей и группой (заявка new_item_requests; в выгрузке
 * /pending строка несёт item.new_item). До v2 модуль 1С создавал такие позиции
 * по mapped_name и всегда с единицей «кг».
 */

/** Единицы, которые можно выбрать для новой позиции (каноническое написание unitConverter). */
export const NEW_ITEM_UNITS = ['шт', 'кг', 'л', 'упак'] as const;
export type NewItemUnit = typeof NEW_ITEM_UNITS[number];

/** Наименование в 1С обрезается до 150 символов (Лев(Имя, 150) в модуле обработки). */
export const NEW_ITEM_NAME_MAX = 150;
/** new_item_requests.name_key — VARCHAR(191) (индекс utf8mb4). */
export const NEW_ITEM_KEY_MAX = 191;
/** Страница показывает не больше стольких групп (самые массовые — первыми). */
export const NEW_ITEM_GROUPS_MAX = 300;

const NAMES_MAX = 5;
const SUPPLIERS_MAX = 3;

export type NewItemRequestStatus = 'pending' | 'created' | 'cancelled';

export function isNewItemUnit(u: unknown): u is NewItemUnit {
  return typeof u === 'string' && (NEW_ITEM_UNITS as readonly string[]).includes(u);
}

/** Ключ группы — тот же itemNameKey, что у правил сопоставления, в пределах колонки. */
export function newItemGroupKey(originalName: string | null | undefined): string {
  return itemNameKey(originalName ?? '').slice(0, NEW_ITEM_KEY_MAX);
}

/** Название для 1С: без управляющих символов, пробелы схлопнуты. */
export function normalizeNewItemName(s: string | null | undefined): string {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Сравнение названий позиций: без учёта регистра и лишних пробелов, ё = е. */
export function comparableItemName(s: string | null | undefined): string {
  return normalizeNewItemName(s).toLowerCase().replace(/ё/g, 'е');
}

/**
 * Единица новой позиции по единице строк накладной: г→кг, мл→л,
 * кор/ящ/блок/упак→упак, прочий счёт (шт, пач, бут…)→шт. null — не распознана.
 */
export function suggestNewItemUnit(raw: string | null | undefined): NewItemUnit | null {
  const c = canonUnit(raw);
  if (!c) return null;
  if (c.unit === 'упак' || c.isCase) return 'упак';
  if (c.cls === 'mass') return 'кг';
  if (c.cls === 'volume') return 'л';
  return 'шт';
}

// ─── Группы строк ────────────────────────────────────────────────────────────

/** Строка без позиции 1С из неотправленной накладной (newItemRequestRepo.unsentUnmappedLines). */
export interface UnmappedLine {
  id: number;
  invoice_id: number;
  original_name: string;
  mapped_name: string | null;
  name_overridden: number | null;
  unit: string | null;
  raw_unit: string | null;
  price: number | null;
  raw_price: number | null;
  supplier: string | null;
}

/** Заявка «Создать в 1С» (строка new_item_requests). */
export interface NewItemRequestLike {
  id: number;
  name_key: string;
  name: string;
  unit: string;
  parent_guid: string | null;
  status: string;
  onec_guid: string | null;
}

export interface NewItemGroupRequest {
  id: number;
  status: NewItemRequestStatus;
  name: string;
  unit: string;
  parent_guid: string | null;
  onec_guid: string | null;
}

export interface NewItemGroup {
  name_key: string;
  /** Самое частое написание в накладных. */
  sample_name: string;
  /** Разные написания, самые частые первыми (не больше 5). */
  names: string[];
  lines: number;
  invoices: number[];
  /** Поставщики, самые частые первыми (не больше 3); всего — supplier_count. */
  suppliers: string[];
  supplier_count: number;
  /** Самая частая единица строк «как в накладной» (raw_unit ?? unit). */
  unit: string | null;
  /** Класс этой единицы (счёт/масса/объём) — UI предупреждает, если новая позиция в другом. */
  unit_class: UnitClass | null;
  /** Подсказки для формы «Создать в 1С». */
  suggested_unit: NewItemUnit;
  suggested_name: string;
  /** Цена из самой свежей строки и её единица. */
  last_price: number | null;
  last_price_unit: string | null;
  /**
   * Строки, пришедшие ПОСЛЕ заявки и не получившие её название (только для
   * pending). Такие строки 1С создаст под их собственным названием — повторное
   * «Создать в 1С» присвоит им название из заявки.
   */
  lines_without_request_name: number;
  request: NewItemGroupRequest | null;
}

function bump<T>(m: Map<T, number>, k: T): void {
  m.set(k, (m.get(k) ?? 0) + 1);
}

/** Самое частое значение; при равенстве — вставленное раньше (строки идут от новых к старым). */
function mostCommon<T>(counts: Map<T, number>): T | null {
  let best: T | null = null;
  let bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN) { best = k; bestN = n; }
  }
  return best;
}

function byFrequency<T>(counts: Map<T, number>): T[] {
  return Array.from(counts.entries())
    .map(([k, n], i) => ({ k, n, i }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .map(x => x.k);
}

function toGroupRequest(r: NewItemRequestLike): NewItemGroupRequest {
  return {
    id: r.id,
    status: r.status as NewItemRequestStatus,
    name: r.name,
    unit: r.unit,
    parent_guid: r.parent_guid || null,
    onec_guid: r.onec_guid || null,
  };
}

interface GroupAcc {
  key: string;
  newestId: number;
  lines: number;
  names: Map<string, number>;
  customNames: Map<string, number>;
  units: Map<string, number>;
  invoices: Set<number>;
  suppliers: Map<string, number>;
  lastPrice: number | null;
  lastPriceUnit: string | null;
  withoutRequestName: number;
}

/**
 * Группы строк без позиции 1С по ключу товара. Отменённые заявки не
 * показываются (группа снова «без заявки»). Сортировка: больше строк — выше,
 * при равенстве — где строка свежее. Строки с пустым ключом (одна пунктуация)
 * в группы не попадают.
 */
export function buildNewItemGroups(
  lines: UnmappedLine[],
  requests: NewItemRequestLike[],
  maxGroups: number = NEW_ITEM_GROUPS_MAX,
): NewItemGroup[] {
  const reqByKey = new Map<string, NewItemRequestLike>();
  for (const r of requests) {
    if (r.status === 'pending' || r.status === 'created') reqByKey.set(r.name_key, r);
  }

  const groups = new Map<string, GroupAcc>();
  const sorted = [...lines].sort((a, b) => b.id - a.id); // от новых к старым
  for (const l of sorted) {
    const original = String(l.original_name ?? '').trim();
    const key = newItemGroupKey(original);
    if (!key) continue;
    let g = groups.get(key);
    if (!g) {
      g = {
        key, newestId: l.id, lines: 0, names: new Map(), customNames: new Map(), units: new Map(),
        invoices: new Set(), suppliers: new Map(), lastPrice: null, lastPriceUnit: null, withoutRequestName: 0,
      };
      groups.set(key, g);
    }
    g.lines++;
    bump(g.names, original);
    const mapped = normalizeNewItemName(l.mapped_name);
    if (Number(l.name_overridden) === 1 && mapped) bump(g.customNames, mapped);
    const unit = String(l.raw_unit ?? l.unit ?? '').trim();
    if (unit) bump(g.units, unit);
    g.invoices.add(l.invoice_id);
    const supplier = String(l.supplier ?? '').trim();
    if (supplier) bump(g.suppliers, supplier);
    if (g.lastPrice == null) {
      const usesPrice = l.price != null && Number.isFinite(Number(l.price));
      const p = usesPrice ? Number(l.price) : (l.raw_price != null ? Number(l.raw_price) : NaN);
      if (Number.isFinite(p)) {
        g.lastPrice = p;
        g.lastPriceUnit = (usesPrice ? (l.unit ?? l.raw_unit) : (l.raw_unit ?? l.unit)) ?? null;
      }
    }
    const req = reqByKey.get(key);
    if (req && req.status === 'pending' && comparableItemName(l.mapped_name) !== comparableItemName(req.name)) {
      g.withoutRequestName++;
    }
  }

  const ordered = Array.from(groups.values())
    .sort((a, b) => b.lines - a.lines || b.newestId - a.newestId || a.key.localeCompare(b.key))
    .slice(0, Math.max(0, maxGroups));
  return ordered.map((g): NewItemGroup => {
    const sample = mostCommon(g.names) ?? '';
    const unit = mostCommon(g.units);
    const req = reqByKey.get(g.key) ?? null;
    const suggestedName = (req ? normalizeNewItemName(req.name) : '')
      || mostCommon(g.customNames)
      || normalizeNewItemName(cleanItemName(sample));
    return {
      name_key: g.key,
      sample_name: sample,
      names: byFrequency(g.names).slice(0, NAMES_MAX),
      lines: g.lines,
      invoices: Array.from(g.invoices),
      suppliers: byFrequency(g.suppliers).slice(0, SUPPLIERS_MAX),
      supplier_count: g.suppliers.size,
      unit,
      unit_class: canonUnit(unit)?.cls ?? null,
      suggested_unit: (req && isNewItemUnit(req.unit) ? req.unit : null) ?? suggestNewItemUnit(unit) ?? 'шт',
      suggested_name: suggestedName.slice(0, NEW_ITEM_NAME_MAX),
      last_price: g.lastPrice,
      last_price_unit: g.lastPriceUnit,
      lines_without_request_name: g.withoutRequestName,
      request: req ? toGroupRequest(req) : null,
    };
  });
}

/**
 * Ждущие заявки, у которых сейчас нет строк без позиции в неотправленных
 * накладных (строки уже ушли в 1С): позиция появится после выгрузки каталога.
 */
export function pendingRequestsWithoutLines<R extends NewItemRequestLike>(requests: R[], lines: UnmappedLine[]): R[] {
  const keys = new Set(lines.map(l => newItemGroupKey(l.original_name)));
  return requests.filter(r => r.status === 'pending' && !keys.has(r.name_key));
}

// ─── Проверка запросов ───────────────────────────────────────────────────────

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

export interface MapGroupInput { name_key: string; onec_guid: string }
export interface CreateItemInput { name_key: string; name: string; unit: NewItemUnit; parent_guid: string | null }

function asObject(body: unknown): Record<string, unknown> | null {
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
}

function readNameKey(b: Record<string, unknown>): string | null {
  const k = typeof b.name_key === 'string' ? b.name_key.trim() : '';
  return k && k.length <= NEW_ITEM_KEY_MAX ? k : null;
}

/** POST /api/new-items/map — {name_key, onec_guid}. */
export function validateMapGroupBody(body: unknown): Validated<MapGroupInput> {
  const b = asObject(body);
  if (!b) return { ok: false, error: 'Ожидается JSON {name_key, onec_guid}' };
  const nameKey = readNameKey(b);
  if (!nameKey) return { ok: false, error: 'name_key: ключ группы из списка «Новые товары»' };
  const guid = typeof b.onec_guid === 'string' ? b.onec_guid.trim() : '';
  if (!guid || guid.length > 64) return { ok: false, error: 'Выберите позицию 1С' };
  return { ok: true, value: { name_key: nameKey, onec_guid: guid } };
}

/** POST /api/new-items/create — {name_key, name, unit, parent_guid?}. Единица приводится к канонической. */
export function validateCreateItemBody(body: unknown): Validated<CreateItemInput> {
  const b = asObject(body);
  if (!b) return { ok: false, error: 'Ожидается JSON {name_key, name, unit, parent_guid?}' };
  const nameKey = readNameKey(b);
  if (!nameKey) return { ok: false, error: 'name_key: ключ группы из списка «Новые товары»' };
  const name = typeof b.name === 'string' ? normalizeNewItemName(b.name) : '';
  if (!name) return { ok: false, error: 'Укажите название позиции' };
  if (name.length > NEW_ITEM_NAME_MAX) return { ok: false, error: `Название длиннее ${NEW_ITEM_NAME_MAX} символов — в 1С оно не поместится` };
  const unit = typeof b.unit === 'string' ? canonUnit(b.unit)?.unit : undefined;
  if (!isNewItemUnit(unit)) return { ok: false, error: `Единица: ${NEW_ITEM_UNITS.join(', ')}` };
  let parentGuid: string | null = null;
  if (b.parent_guid !== undefined && b.parent_guid !== null && b.parent_guid !== '') {
    const pg = typeof b.parent_guid === 'string' ? b.parent_guid.trim() : '';
    if (!pg || pg.length > 64) return { ok: false, error: 'parent_guid: группа из справочника 1С' };
    parentGuid = pg;
  }
  return { ok: true, value: { name_key: nameKey, name, unit, parent_guid: parentGuid } };
}

// ─── Выгрузка в 1С (/pending) ────────────────────────────────────────────────

/** То, что получает модуль 1С в item.new_item. */
export interface NewItemPayload { name: string; unit: string; parent_guid: string | null }

export interface PendingRequestRow {
  owner_user_id: number;
  name_key: string;
  name: string;
  unit: string;
  parent_guid: string | null;
  status: string;
}

function indexKey(ownerUserId: number, nameKey: string): string {
  return `${ownerUserId}\u0000${nameKey}`;
}

/** Индекс ждущих заявок «компания + ключ товара» → new_item. */
export function indexPendingRequests(rows: PendingRequestRow[]): Map<string, NewItemPayload> {
  const m = new Map<string, NewItemPayload>();
  for (const r of rows) {
    if (r.status !== 'pending' || !r.name_key) continue;
    m.set(indexKey(Number(r.owner_user_id), r.name_key), { name: r.name, unit: r.unit, parent_guid: r.parent_guid || null });
  }
  return m;
}

/**
 * Строки накладной для выгрузки в 1С: строке без позиции 1С, по товару которой
 * у компании есть заявка «Создать в 1С», добавляется new_item, а mapped_name
 * становится названием из заявки — модуль 1С ищет и создаёт позицию по
 * mapped_name, и так ВСЕ строки группы (в том числе пришедшие после заявки со
 * своим mapped_name) попадут в одну новую позицию. Остальные строки
 * возвращаются теми же объектами — выгрузка для них не меняется ни на байт
 * (старые модули 1С незнакомое поле просто не читают).
 */
export function attachNewItems<I extends { onec_guid?: string | null; original_name?: string | null }>(
  items: I[],
  ownerUserId: number | null | undefined,
  index: Map<string, NewItemPayload>,
): Array<I | (I & { mapped_name: string; new_item: NewItemPayload })> {
  if (ownerUserId == null || index.size === 0) return items;
  return items.map(it => {
    if (it.onec_guid) return it;
    const key = newItemGroupKey(it.original_name);
    if (!key) return it;
    const payload = index.get(indexKey(ownerUserId, key));
    return payload ? { ...it, mapped_name: payload.name, new_item: { ...payload } } : it;
  });
}

// ─── После выгрузки каталога из 1С ───────────────────────────────────────────

export interface CatalogRowLike {
  guid: string;
  name: string;
  unit: string | null;
  is_folder?: number | boolean | null;
}

/**
 * Какие ждущие заявки уже выполнены: в каталоге появилась позиция (не группа)
 * с тем же названием — без учёта регистра и лишних пробелов. Если таких
 * позиций несколько, берётся та, чья единица совпадает с заявкой.
 */
export function matchRequestsToCatalog<R extends CatalogRowLike>(
  requests: Array<{ id: number; name: string; unit: string; status: string }>,
  catalog: R[],
): Array<{ requestId: number; item: R }> {
  const byName = new Map<string, R[]>();
  for (const row of catalog) {
    if (!row.guid || Number(row.is_folder) === 1 || row.is_folder === true) continue;
    const k = comparableItemName(row.name);
    if (!k) continue;
    const list = byName.get(k);
    if (list) list.push(row); else byName.set(k, [row]);
  }
  const out: Array<{ requestId: number; item: R }> = [];
  for (const r of requests) {
    if (r.status !== 'pending') continue;
    const hits = byName.get(comparableItemName(r.name));
    if (!hits?.length) continue;
    const wanted = canonUnit(r.unit)?.unit ?? null;
    const sorted = [...hits].sort((a, b) => a.guid.localeCompare(b.guid));
    const item = sorted.find(h => wanted != null && canonUnit(h.unit)?.unit === wanted) ?? sorted[0];
    out.push({ requestId: r.id, item });
  }
  return out;
}

/** Позиция каталога с таким же названием (для проверки перед «Создать в 1С»). */
export function findCatalogItemByName<R extends CatalogRowLike>(name: string, unit: string, catalog: R[]): R | null {
  return matchRequestsToCatalog([{ id: 0, name, unit, status: 'pending' }], catalog)[0]?.item ?? null;
}
