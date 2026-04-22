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

export interface VatAwareItem extends SanitizableItem {
  vat_rate: number | null | undefined;
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

/**
 * Per-item VAT sanity: fix items where Claude took the "сумма БЕЗ НДС" column
 * instead of "сумма С НДС" for some lines but not others (common failure mode
 * in ТОРГ-12 — unlike sanitizeInvoiceVat which only catches the all-pre-VAT
 * or all-post-VAT cases).
 *
 * Rule (intentionally conservative — we'd rather leave a wrong line than
 * corrupt a right one):
 *
 *   For each item with a positive vat_rate and total ≈ qty × price (within
 *   0.5% — the "clean pre-VAT" signature: all three numbers taken from the
 *   pre-VAT side of the same row):
 *     candidate = total × (1 + vat_rate/100)
 *
 *   Then we try every subset of candidates (bit-mask over the K<=20 eligible
 *   rows) and pick the one that minimises |Σ new_totals − header_total|
 *   WHILE staying ≤ headerTol. If no subset improves on the current error
 *   by ≥ 50%, we back off and apply nothing.
 *
 * The double safety (clean arithmetic check + subset that actually closes
 * the header gap) means we never inflate lines that Claude read from
 * different columns (those fail the clean-arithmetic test).
 *
 * Inputs that are null/zero-qty/zero-price/zero-total are passed through.
 */
export interface VatPerItemReport {
  inflated: number;         // how many items were scaled up
  skipped: number;          // eligible but not chosen by the subset search
  newItemsSum: number;
  oldItemsSum: number;
  headerTotal: number;
  improvementFactor: number; // how much closer we got to the header (1.0 = nothing, higher = better)
  reason: string;
}

export function sanitizeItemVatPerItem<T extends VatAwareItem>(
  items: T[],
  headerTotal: number | null | undefined,
): { items: T[]; report: VatPerItemReport } {
  const oldSum = items.reduce((s, i) => s + (i.total ?? 0), 0);
  const baseReport = {
    inflated: 0,
    skipped: 0,
    newItemsSum: oldSum,
    oldItemsSum: oldSum,
    headerTotal: headerTotal ?? 0,
    improvementFactor: 1,
  };

  if (headerTotal == null || headerTotal <= 0 || items.length === 0) {
    return { items, report: { ...baseReport, reason: 'no header total or empty items' } };
  }

  const oldErr = Math.abs(oldSum - headerTotal);
  // Already close enough (≤1%)? Don't touch anything.
  if (oldErr / headerTotal <= 0.01) {
    return { items, report: { ...baseReport, reason: 'already within 1% of header total' } };
  }

  // Identify eligible lines: clean pre-VAT arithmetic + positive vat_rate.
  type Eligible = { idx: number; cur: number; inflated: number; vat: number };
  const eligible: Eligible[] = [];
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    const q = it.quantity ?? 0;
    const p = it.price ?? 0;
    const t = it.total ?? 0;
    const vat = it.vat_rate ?? 0;
    if (q <= 0 || p <= 0 || t <= 0 || vat <= 0) continue;
    // Clean pre-VAT: |q × p − t| / t ≤ 0.5%
    const expected = q * p;
    const rel = Math.abs(expected - t) / t;
    if (rel > 0.005) continue;
    const infl = Math.round(t * (1 + vat / 100) * 100) / 100;
    eligible.push({ idx: k, cur: t, inflated: infl, vat });
  }

  // Cap subset search at 20 lines (2^20 = 1M iterations, ~50ms).
  // Accounting invoices rarely exceed 20 items, and if they do, the
  // risk of an over-eager fix outweighs the benefit — fall back to none.
  if (eligible.length === 0 || eligible.length > 20) {
    return { items, report: { ...baseReport, reason: `no eligible pre-VAT items (found ${eligible.length})` } };
  }

  // Fixed portion: items we won't touch (ineligible).
  const nonEligibleSum = items.reduce((s, it, k) => {
    if (eligible.some(e => e.idx === k)) return s;
    return s + (it.total ?? 0);
  }, 0);

  // Brute-force subset selection over eligible lines.
  const N = eligible.length;
  let bestMask = 0;
  let bestErr = oldErr;
  for (let mask = 0; mask < (1 << N); mask++) {
    let s = nonEligibleSum;
    for (let k = 0; k < N; k++) {
      s += (mask >> k) & 1 ? eligible[k].inflated : eligible[k].cur;
    }
    const err = Math.abs(s - headerTotal);
    if (err < bestErr) {
      bestErr = err;
      bestMask = mask;
    }
  }

  // Require a meaningful improvement: at least 50% smaller error than before,
  // AND final error ≤ 1% of header total. Otherwise the "best" subset is just
  // a coincidence that doesn't really solve the problem.
  const finalRel = bestErr / headerTotal;
  const improvement = oldErr / Math.max(bestErr, 0.01);
  if (improvement < 2 || finalRel > 0.01) {
    return {
      items,
      report: {
        ...baseReport,
        skipped: eligible.length,
        reason: `no subset brings error within 1% (oldErr=${oldErr.toFixed(2)}, bestErr=${bestErr.toFixed(2)}, improvement=${improvement.toFixed(2)}x)`,
      },
    };
  }

  // Apply the chosen mask.
  const chosenIdx = new Set<number>();
  for (let k = 0; k < N; k++) {
    if ((bestMask >> k) & 1) chosenIdx.add(eligible[k].idx);
  }
  const out: T[] = items.map((it, k) => {
    if (!chosenIdx.has(k)) return it;
    const q = it.quantity ?? 0;
    const vat = it.vat_rate ?? 0;
    const newTotal = Math.round((it.total ?? 0) * (1 + vat / 100) * 100) / 100;
    const newPrice = q > 0 ? Math.round(newTotal / q * 100) / 100 : it.price;
    return { ...it, total: newTotal, price: newPrice };
  });
  const newSum = out.reduce((s, i) => s + (i.total ?? 0), 0);
  return {
    items: out,
    report: {
      inflated: chosenIdx.size,
      skipped: eligible.length - chosenIdx.size,
      newItemsSum: newSum,
      oldItemsSum: oldSum,
      headerTotal,
      improvementFactor: improvement,
      reason: `inflated ${chosenIdx.size}/${eligible.length} pre-VAT items by (1+vat%), sum went from ${oldSum.toFixed(2)} to ${newSum.toFixed(2)} (header=${headerTotal}, improvement=${improvement.toFixed(1)}x)`,
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
