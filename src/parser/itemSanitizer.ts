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

/**
 * Invoice-level sanity check: does Σ(items.total) match invoice.total_sum?
 *
 * Claude sometimes puts the "without VAT" column into item.total but the
 * "with VAT" column into invoice.total_sum (or vice versa). If it's off by
 * exactly the VAT amount, we know one of the two is pre-tax and can scale.
 *
 * Decision rule:
 *   - If Σ(items.total) ≈ total_sum (within 2%), do nothing.
 *   - If Σ(items.total) ≈ total_sum − vat_sum (within 2%), items are
 *     pre-VAT but the header is post-VAT → scale each item.total by
 *     total_sum / Σ(items.total). Also scale item.price the same way.
 *   - If Σ(items.total) ≈ total_sum + vat_sum (within 2%), items are
 *     post-VAT but header is pre-VAT → leave items alone, trust them,
 *     caller can recompute total_sum from items.
 *
 * Returns the new items + a report.
 */
export interface VatSanityReport {
  scaled: boolean;
  reason: string;
  scaleFactor?: number;
}

export function sanitizeInvoiceVat<T extends SanitizableItem>(
  items: T[],
  totalSum: number | null | undefined,
  vatSum: number | null | undefined,
): { items: T[]; report: VatSanityReport } {
  if (totalSum == null || !items.length) {
    return { items, report: { scaled: false, reason: 'missing total_sum or no items' } };
  }
  const itemsSum = items.reduce((s, i) => s + (i.total ?? 0), 0);
  if (itemsSum <= 0) {
    return { items, report: { scaled: false, reason: 'zero items sum' } };
  }

  const tol = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(b), 1) <= 0.02;

  if (tol(itemsSum, totalSum)) {
    return { items, report: { scaled: false, reason: 'items sum matches total_sum' } };
  }

  // Items pre-VAT, header post-VAT → scale up.
  if (vatSum != null && vatSum > 0 && tol(itemsSum, totalSum - vatSum)) {
    const factor = totalSum / itemsSum;
    const scaled = items.map(it => ({
      ...it,
      total: it.total != null ? Math.round(it.total * factor * 100) / 100 : it.total,
      price: it.price != null ? Math.round(it.price * factor * 100) / 100 : it.price,
    }));
    return {
      items: scaled,
      report: {
        scaled: true,
        scaleFactor: factor,
        reason: `items summed to ${itemsSum.toFixed(2)} (pre-VAT), total_sum ${totalSum} = ${(totalSum - vatSum).toFixed(2)} + VAT ${vatSum}. Scaled items by ×${factor.toFixed(4)} to put them in "with VAT" terms.`,
      },
    };
  }

  // Header pre-VAT, items already post-VAT → nothing to do; caller should
  // recompute total_sum from items via invoiceRepo.recalculateTotal.
  if (vatSum != null && vatSum > 0 && tol(itemsSum, totalSum + vatSum)) {
    return {
      items,
      report: {
        scaled: false,
        reason: `items are post-VAT (${itemsSum.toFixed(2)}) but total_sum is pre-VAT (${totalSum}). Leaving items, caller should recompute total_sum.`,
      },
    };
  }

  // Doesn't match any pattern — leave everything alone, UI will flag mismatch.
  return {
    items,
    report: {
      scaled: false,
      reason: `no recognisable VAT pattern (itemsSum=${itemsSum.toFixed(2)}, total_sum=${totalSum}, vat_sum=${vatSum ?? 'null'})`,
    },
  };
}

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
