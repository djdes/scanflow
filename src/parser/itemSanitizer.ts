/**
 * Post-Claude arithmetic sanity check for invoice items.
 *
 * Claude sometimes returns numbers where `quantity × price ≠ total` by an
 * order of magnitude — typical misread is "7" vs "7,000" (reading the
 * thousand-separator as part of the number, or picking up a neighbouring
 * column). When that happens, `total` and `price` are almost always the
 * trustworthy ones (they come from the rightmost, boldest columns of the
 * table), and `quantity` is the one to correct.
 *
 * Rule:
 *   - If qty × price matches total within 5% → leave everything as-is
 *   - Otherwise, if price > 0 and total > 0, derive qty := total / price
 *   - If we can't fix (price or total missing / zero), leave as-is — the
 *     user can still correct via inline edit. We DO NOT invent values.
 */

export interface SanitizableItem {
  quantity: number | null | undefined;
  unit: string | null | undefined;
  price: number | null | undefined;
  total: number | null | undefined;
}

export interface SanitizeResult<T> {
  item: T;
  corrected: boolean;
  // Human-readable explanation, useful for logs.
  reason?: string;
}

const TOLERANCE = 0.05; // 5% relative tolerance

export function sanitizeItemArithmetic<T extends SanitizableItem>(item: T): SanitizeResult<T> {
  const qty = item.quantity;
  const price = item.price;
  const total = item.total;

  if (qty == null || price == null || total == null) {
    return { item, corrected: false };
  }
  if (qty === 0 || price === 0 || total === 0) {
    return { item, corrected: false };
  }

  const expected = qty * price;
  const diff = Math.abs(expected - total);
  const rel = diff / Math.max(Math.abs(total), 1);
  if (rel <= TOLERANCE) {
    return { item, corrected: false };
  }

  // Arithmetic lies. Trust total + price, fix qty.
  const newQty = total / price;
  if (!Number.isFinite(newQty) || newQty <= 0) {
    return { item, corrected: false };
  }

  // Round to 3 decimals — same precision we use in the UI's formatQty.
  const rounded = Math.round(newQty * 1000) / 1000;

  return {
    item: { ...item, quantity: rounded },
    corrected: true,
    reason: `qty × price (${qty} × ${price} = ${expected.toFixed(2)}) didn't match total (${total}); fixed qty to ${rounded}`,
  };
}
