/**
 * Pack conversion helpers.
 *
 * When a supplier sells a product in multi-unit packaging ("Мука (50кг) — 1 шт"),
 * the warehouse tracks it in the base unit ("Мука ржаная — 50 кг"). A learned
 * nomenclature_mappings row can carry `pack_size` + `pack_unit` to describe
 * that transform, and we apply it here on the server so 1С only ever sees the
 * base-unit quantities.
 *
 * Supports kg, g, l, ml — inside or without parentheses.
 */

export interface PackTransformable {
  quantity: number | null | undefined;
  unit: string | null | undefined;
  price: number | null | undefined;
  total: number | null | undefined;
}

// Canonical base units we convert to.
const UNIT_ALIASES: Record<string, string> = {
  'кг': 'кг',
  'г': 'г',
  'гр': 'г',
  'л': 'л',
  'мл': 'мл',
};

/**
 * Matches "50кг", "1.5 кг", "(50 кг)", "25 КГ" — anywhere in the string.
 * Captures number as group 1, unit as group 2.
 * Uses lookahead for the trailing boundary to work with Cyrillic names.
 */
const PACK_PATTERN = /(?:\(|\b|\s|^)(\d+(?:[.,]\d+)?)\s*(кг|гр|г|мл|л)(?=\s|\)|$|[^а-яА-Яa-zA-Z0-9])/i;

/**
 * Container-like words. When these appear in the item name, any "350 мл" /
 * "500 мл" / "1л" inside is the SIZE OF THE VESSEL, not the pack size of
 * contents — so pack-transform must NOT fire.
 *
 * Example of what we want to block:
 *   "Стакан 350 мл крафт..." quantity=175 шт → WITHOUT this guard, the old
 *   code would turn it into 61250 мл → 61.25 л, which is nonsense — these
 *   are physical cups, not 175 servings of a 350ml beverage.
 *
 * Two tiers:
 *   - STRICT: always blocks. The product itself IS this container (disposable
 *     cups, cutlery, bags, jars sold as empty containers, etc.).
 *   - PACKAGING_HINTS: blocks only when it precedes the pack-size pattern.
 *     "Ведро 5л" (ведро first) → блок. "Сельдь 3кг (ведро)" (цифра first) → pass.
 *     Words here describe either a product-type (тара) or a packaging format
 *     used next to a weighted/volumed food product.
 */
const CONTAINER_STRICT = [
  'стакан', 'стаканчик',
  'контейнер',
  'бутылка', 'бутыль', 'флакон',
  'крышка',
  'пакет', 'пакетик', 'мешок',
  'лоток',
  'пробка', 'дозатор',
  'тарелк', 'миск',
  'ложка', 'вилка', 'нож',                     // одноразовые приборы
  'салфетк',
  'форма',
];
const PACKAGING_HINTS = [
  'банк',                                      // банка
  'коробк', 'короб',
  'ведро',
  'упаковк',
];
// Note: JS RegExp \b doesn't honour Cyrillic word boundaries, so we rely on
// simple lowercase substring lookup. This is permissive (matches "стакан"
// inside "стаканчик" — which is intended, both are containers) but won't
// false-positive on ordinary ingredient names.
const CONTAINER_STRICT_STEMS = CONTAINER_STRICT.map(w => w.toLowerCase());
const PACKAGING_HINT_STEMS = PACKAGING_HINTS.map(w => w.toLowerCase());

/**
 * Returns true when the item name describes the container itself (not a food
 * product packed in it). A name is treated as a container when:
 *   - it contains any STRICT stem, OR
 *   - it contains a PACKAGING_HINT stem that appears BEFORE the first pack
 *     size pattern (e.g. "Ведро 5л" — ведро first → container).
 * Names like "Сельдь 3 кг (ведро)" pass (цифра first → фасовка).
 */
function looksLikeContainer(name: string): boolean {
  const lower = name.toLowerCase();
  if (CONTAINER_STRICT_STEMS.some(stem => lower.includes(stem))) return true;
  const packMatch = lower.match(PACK_PATTERN);
  const packIdx = packMatch?.index ?? -1;
  for (const stem of PACKAGING_HINT_STEMS) {
    const idx = lower.indexOf(stem);
    if (idx === -1) continue;
    // No pack pattern in the name — a lone "ведро" / "короб" means the product
    // IS the container.
    if (packIdx === -1) return true;
    // Hint BEFORE the pack size — also container ("Ведро 5л").
    if (idx < packIdx) return true;
    // Hint AFTER the pack size — packaging format for a food product,
    // pack-transform should proceed ("Сельдь 3кг (ведро)").
  }
  return false;
}

/**
 * Extract a pack size from a scanned item name.
 * Recognises kg / g / l / ml, with or without surrounding parentheses.
 * Returns null if the name has no recognisable pack pattern.
 *
 * Also returns null if the name describes a CONTAINER (stakan, konteyner,
 * bottle, etc.) — the volume there describes the vessel, not a pack.
 */
export function detectPackFromName(name: string): { pack_size: number; pack_unit: string } | null {
  if (!name) return null;
  if (looksLikeContainer(name)) return null;
  const match = name.match(PACK_PATTERN);
  if (!match) return null;
  const n = parseFloat(match[1].replace(',', '.'));
  if (!isFinite(n) || n <= 0) return null;
  const unit = UNIT_ALIASES[match[2].toLowerCase()];
  if (!unit) return null;
  return { pack_size: n, pack_unit: unit };
}

/**
 * Apply a pack transform to an item's quantity/unit/price (returns a new object).
 *
 *   new_quantity = old_quantity * pack_size
 *   new_unit     = pack_unit
 *   total        = unchanged (money doesn't depend on how we count)
 *   new_price    = total / new_quantity
 *
 * If quantity or pack_size is missing / zero, returns the item unchanged.
 * If total is missing, derives it from old price * old quantity so the new price
 * stays meaningful.
 *
 * Guard against double-transforming: if the item's current unit already equals
 * pack_unit, the transform is skipped (it was already applied on a previous pass).
 */
export function applyPackTransform<T extends PackTransformable>(
  item: T,
  pack_size: number | null | undefined,
  pack_unit: string | null | undefined
): T {
  if (!pack_size || !pack_unit || pack_size <= 0) return item;
  const oldQty = item.quantity;
  if (oldQty == null || oldQty <= 0) return item;

  // Idempotence guard: if the item is already in the target unit (or in its
  // normalised parent unit — "кг" when pack_unit is "г", "л" when "мл"),
  // assume the transform was already applied and skip.
  const packU = pack_unit.toLowerCase();
  const itemU = (item.unit || '').toLowerCase();
  if (itemU && (
    itemU === packU
    || (packU === 'г' && itemU === 'кг')
    || (packU === 'мл' && itemU === 'л')
  )) return item;

  const total = item.total != null
    ? item.total
    : (item.price != null ? item.price * oldQty : null);

  let newQty = oldQty * pack_size;
  let newUnit = pack_unit;

  // Normalise sub-units into their base when the result is large:
  //   60 шт × 420 мл = 25200 мл → 25.2 л
  //   60 шт × 950 г  = 57000 г  → 57 кг
  // Rule: ≥ 1000 sub-units roll up into one base unit. Keeps totals intact
  // since we just scale quantity and recompute price below.
  const normUnit = pack_unit.toLowerCase();
  if (normUnit === 'мл' && newQty >= 1000) {
    newQty = newQty / 1000;
    newUnit = 'л';
  } else if (normUnit === 'г' && newQty >= 1000) {
    newQty = newQty / 1000;
    newUnit = 'кг';
  }

  const newPrice = total != null && newQty > 0 ? total / newQty : item.price ?? null;

  return {
    ...item,
    quantity: newQty,
    unit: newUnit,
    price: newPrice,
    total,
  };
}

/**
 * When the 1C-side name itself carries a pack pattern ("Кофе растворимый
 * сублимированный 2г"), the size is the accounting unit IN 1C:
 *   1 шт on the 1C side = 1 pack of that size.
 *
 * In the scan name we expect a COUNT MULTIPLIER after this size — how many
 * such packs are in one line-item "шт" from the invoice (e.g. "2г 100 п"
 * means 1 invoice шт = 100 packs). This helper extracts that multiplier.
 *
 * Recognises:
 *   "100 п", "100п", "100 пак", "100пак", "100 пакетов", "100 пакетиков",
 *   "100 шт", "100шт", "100 штук",
 *   "×100", "*100", "x100", "х100" (Cyrillic 'х'),
 * — looked for only AFTER the size-pattern position in the scan name.
 *
 * Returns null when no multiplier is found, which means the invoice line
 * already uses the 1C unit (no scaling needed).
 */
// JS \b doesn't honour Cyrillic word boundaries, so we use a negative
// lookahead for letters instead — ensures "п" isn't swallowed out of
// "покупка" and "шт" isn't swallowed out of "штурм".
const COUNT_MULTIPLIER_PATTERN =
  /(?:(?:[×xх*])\s*(\d+(?:[.,]\d+)?)|(\d+(?:[.,]\d+)?)\s*(?:п(?:ак(?:ет(?:ик)?(?:ов|а)?)?)?|шт(?:ук[аи]?)?)(?![а-яёa-z]))/i;

function extractCountMultiplierAfterSize(
  scannedName: string,
  sizePatternIndex: number,
): number | null {
  const tail = scannedName.slice(sizePatternIndex);
  // Skip the size token itself — find the next cursor after the first
  // pack pattern match in the tail.
  const sizeMatch = tail.match(PACK_PATTERN);
  if (!sizeMatch) return null;
  const sizeEnd = (sizeMatch.index ?? 0) + sizeMatch[0].length;
  const afterSize = tail.slice(sizeEnd);
  const m = afterSize.match(COUNT_MULTIPLIER_PATTERN);
  if (!m) return null;
  const raw = m[1] ?? m[2];
  if (!raw) return null;
  const n = parseFloat(raw.replace(',', '.'));
  return isFinite(n) && n > 0 ? n : null;
}

/**
 * Finds the pack pattern's start index in a string, or -1.
 */
function findPackPatternIndex(s: string | null | undefined): number {
  if (!s) return -1;
  const m = s.match(PACK_PATTERN);
  return m?.index ?? -1;
}

/**
 * Convenience: apply a transform using either the explicit pack fields from a
 * learned mapping, or a fallback detected from the scanned name when the
 * mapping doesn't specify one. Returns the (possibly unchanged) item and the
 * pack fields that were actually used — callers can persist them back to the
 * mapping so the next pass doesn't need the fallback.
 *
 * Two modes depending on whether mapped_name_1c already contains a size:
 *
 *   A. 1C name has NO size (e.g. "Сельдь филе"): classic mode. Pull the
 *      pack size from the mapping or from the scan name, scale quantity,
 *      swap unit. 7 шт × 3 кг → 21 кг.
 *
 *   B. 1C name HAS a size (e.g. "Кофе ... 2г"): size is already the 1C
 *      accounting unit. We DON'T convert the invoice line into grams.
 *      Instead we look in the scan name for a COUNT MULTIPLIER after that
 *      size ("100 п", "100 шт", "×100") and, if found, multiply qty by it
 *      and set unit = шт. 1 шт × 100 = 100 шт. If no multiplier present,
 *      leave the item unchanged (invoice line already uses 1C unit).
 */
export function resolveAndApplyPackTransform<T extends PackTransformable>(
  item: T,
  scannedName: string,
  mappingPackSize: number | null | undefined,
  mappingPackUnit: string | null | undefined,
  mappedName1c?: string | null,
): { item: T; packSize: number | null; packUnit: string | null; usedFallback: boolean } {
  // Mode B: 1C name encodes the pack size.
  if (mappedName1c && findPackPatternIndex(mappedName1c) !== -1) {
    const sizeIdx = findPackPatternIndex(scannedName);
    if (sizeIdx === -1) {
      // No size in the scan — nothing to anchor a multiplier search to.
      return { item, packSize: null, packUnit: null, usedFallback: false };
    }
    const mult = extractCountMultiplierAfterSize(scannedName, sizeIdx);
    if (mult == null) {
      // 1C уже использует правильную единицу, множителя нет.
      return { item, packSize: null, packUnit: null, usedFallback: false };
    }
    const oldQty = item.quantity;
    if (oldQty == null || oldQty <= 0) {
      return { item, packSize: null, packUnit: null, usedFallback: false };
    }
    const total = item.total != null
      ? item.total
      : (item.price != null ? item.price * oldQty : null);
    const newQty = oldQty * mult;
    const newPrice = total != null && newQty > 0 ? total / newQty : item.price ?? null;
    return {
      item: { ...item, quantity: newQty, unit: 'шт', price: newPrice, total } as T,
      packSize: mult,
      packUnit: 'шт',
      usedFallback: true,
    };
  }

  // Mode A (classic): pull from mapping or fall back to detectPackFromName.
  let packSize = mappingPackSize ?? null;
  let packUnit = mappingPackUnit ?? null;
  let usedFallback = false;

  if (!packSize || !packUnit) {
    const detected = detectPackFromName(scannedName);
    if (detected) {
      packSize = detected.pack_size;
      packUnit = detected.pack_unit;
      usedFallback = true;
    }
  }

  const transformed = applyPackTransform(item, packSize, packUnit);
  return { item: transformed, packSize, packUnit, usedFallback };
}
