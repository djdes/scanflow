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
 * Extract a pack size from a scanned item name.
 * Recognises kg / g / l / ml, with or without surrounding parentheses.
 * Returns null if the name has no recognisable pack pattern.
 */
export function detectPackFromName(name: string): { pack_size: number; pack_unit: string } | null {
  if (!name) return null;
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

  // Idempotence guard: if the item is already in the target unit, assume
  // the transform was already applied (or the parser delivered base units
  // directly) — do not multiply again.
  if (item.unit && item.unit.toLowerCase() === pack_unit.toLowerCase()) return item;

  const total = item.total != null
    ? item.total
    : (item.price != null ? item.price * oldQty : null);

  const newQty = oldQty * pack_size;
  const newPrice = total != null && newQty > 0 ? total / newQty : item.price ?? null;

  return {
    ...item,
    quantity: newQty,
    unit: pack_unit,
    price: newPrice,
    total,
  };
}

/**
 * Convenience: apply a transform using either the explicit pack fields from a
 * learned mapping, or a fallback detected from the scanned name when the
 * mapping doesn't specify one. Returns the (possibly unchanged) item and the
 * pack fields that were actually used — callers can persist them back to the
 * mapping so the next pass doesn't need the fallback.
 */
export function resolveAndApplyPackTransform<T extends PackTransformable>(
  item: T,
  scannedName: string,
  mappingPackSize: number | null | undefined,
  mappingPackUnit: string | null | undefined,
): { item: T; packSize: number | null; packUnit: string | null; usedFallback: boolean } {
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
