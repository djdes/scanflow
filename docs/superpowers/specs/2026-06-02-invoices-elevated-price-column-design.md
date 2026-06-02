# Invoices list — «Цены ↑» (elevated-price count) column

**Date:** 2026-06-02
**Status:** approved

## Problem

The invoice detail page flags items whose price is >10% above the usual (median)
price, but the invoices **list** gives no at-a-glance signal of which invoices
contain over-priced positions. The user wants a new column on the list showing,
per invoice, the **count** of elevated-price items.

## Decision (from brainstorming)

- **Display:** a single counter — a reddish badge with the number when `> 0`,
  «—» when none. (Not the orange/red tiered split, not a plain number.)
- **Definition reused, not redefined:** an item is "elevated" by the **same**
  rule the detail page already uses (see `GET /api/invoices/:id` in
  `src/api/routes/invoices.ts`): it has a median price stat with `samples ≥ 3`,
  its unit matches the stat's `price_unit`, its `price > 0`, and
  `price > median_price · 1.10`. List and detail must agree.
- **No N+1:** one batched aggregate query per list page, mirroring the existing
  `attachSberStatus` helper.

## Architecture

### Backend — `src/api/routes/invoices.ts`

New helper next to `attachSberStatus`:

```ts
async function attachElevatedPriceCount<T extends { id: number }>(
  invoices: T[],
): Promise<(T & { elevated_price_count: number })[]>
```

It returns `[]` for an empty input, otherwise runs ONE query over the page's
invoice ids:

```sql
SELECT ii.invoice_id AS invoice_id, COUNT(*) AS c
  FROM invoice_items ii
  JOIN nomenclature_price_stats ps ON ps.onec_guid = ii.onec_guid
 WHERE ii.invoice_id IN (<placeholders>)
   AND ps.samples >= 3
   AND ii.unit = ps.price_unit
   AND ii.price > 0
   AND ii.price > ps.median_price * 1.10
 GROUP BY ii.invoice_id
```

and maps the result onto each row as `elevated_price_count` (default `0`).

Wired into the list endpoint `GET /api/invoices` (the main list path only), after
`attachSberStatus`:

```ts
const withSber = await attachSberStatus(enriched);
const withElevated = await attachElevatedPriceCount(withSber);
res.json({ data: withElevated, count: withElevated.length });
```

The `?file_name=` single-lookup branch (used only by upload polling) is left
unchanged — the column doesn't use it.

### Frontend

- `public/app.html`: add `<th title="Позиции дороже обычного более чем на 10%"
  style="text-align:center">Цены&nbsp;↑</th>` between «Сумма» and «Статус».
- `public/js/invoices.js`:
  - `loadTable()`: add a `<td style="text-align:center">${this._elevatedCell(inv)}</td>`
    between the Сумма cell and the Статус cell.
  - new `_elevatedCell(inv)`: `> 0` → a reddish inline-styled pill with the count
    (bg `#fee2e2`, color `#dc2626`) and a pluralised tooltip; else a muted «—».
  - bump the empty-state `colspan` from 8 → 9.
  - add one width to the `App.skeletonRows(...)` array (8 → 9 columns).

No CSS-file change (badge uses an inline style, consistent with other inline
badges in this list).

## Edge cases

- Empty list → helper returns `[]` (guard).
- Invoice with no elevated items → absent from the GROUP BY result → `0`.
- `onec_guid`/`unit`/`price` NULL → excluded by the JOIN / `= ` / `> 0` predicates.
- Query is read-only and fully parameterised (ids via `?` placeholders) — no
  injection, no writes.

## Testing

- `npx tsc --noEmit` + `npm test` (full suite; DB-backed suites remain dormant by
  design — same situation as `attachSberStatus`, which has no unit test either).
- Live verification: prod invoice **#63** has exactly one elevated item
  («Огурцы маринованные +39%»), so its list row must render the badge **1**;
  invoices with none must render «—».

## Out of scope

- Sorting/filtering the list by the new column.
- Backfilling or changing the price-stat computation.
