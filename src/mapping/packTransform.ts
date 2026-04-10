/**
 * Pack conversion helpers.
 *
 * When a supplier sells a product in multi-unit packaging ("Мука (50кг) — 1 шт"),
 * the warehouse tracks it in the base unit ("Мука ржаная — 50 кг"). A learned
 * nomenclature_mappings row can carry `pack_size` + `pack_unit` to describe
 * that transform, and we apply it here on the server so 1С only ever sees the
 * base-unit quantities.
 *
 * Current scope: kg only. Volumes (л, мл) were out of scope per user request.
 */

export interface PackTransformable {
  quantity: number | null | undefined;
  unit: string | null | undefined;
  price: number | null | undefined;
  total: number | null | undefined;
}

/**
 * Regex matching "... (50кг)" / "... (1.5 кг)" / "Мука (50 КГ)" — only kg.
 * Captures the numeric pack size as group 1. Accepts dot or comma decimals.
 */
const PACK_KG_PATTERN = /\(\s*(\d+(?:[.,]\d+)?)\s*кг\s*\)/i;

/**
 * Try to extract a kilogram pack size from a scanned item name.
 * Returns { pack_size, pack_unit } or null if no pattern found.
 */
export function detectPackFromName(name: string): { pack_size: number; pack_unit: string } | null {
  if (!name) return null;
  const match = name.match(PACK_KG_PATTERN);
  if (!match) return null;
  const raw = match[1].replace(',', '.');
  const n = parseFloat(raw);
  if (!isFinite(n) || n <= 0) return null;
  return { pack_size: n, pack_unit: 'кг' };
}

/**
 * Apply a pack transform to an item's quantity/unit/price in place-style
 * (pure function — returns a new object). Math:
 *
 *   new_quantity = old_quantity * pack_size
 *   new_unit     = pack_unit
 *   total        = unchanged (money doesn't depend on how we count)
 *   new_price    = total / new_quantity  (per-unit price in base unit)
 *
 * If original quantity or pack_size is missing / zero, returns the item as-is
 * (transform is a no-op rather than corrupting data). If total is missing,
 * it's computed from old price * old quantity so the recomputed new price
 * stays meaningful.
 */
export function applyPackTransform<T extends PackTransformable>(
  item: T,
  pack_size: number | null | undefined,
  pack_unit: string | null | undefined
): T {
  if (!pack_size || !pack_unit || pack_size <= 0) return item;
  const oldQty = item.quantity;
  if (oldQty == null || oldQty <= 0) return item;

  // Capture the total BEFORE changing anything — prefer the stored value,
  // fall back to old_price * old_quantity if total wasn't set.
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
    total: total, // unchanged
  };
}
