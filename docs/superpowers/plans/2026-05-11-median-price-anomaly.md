# Median-Price Anomaly Detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show median price (last 10 deliveries by `onec_guid`) next to each invoice item, with a heatmap row-color based on deviation, so price anomalies (supplier slipping in flour at 2× normal) are visible before approval.

**Architecture:** New `nomenclature_price_stats` table keyed by `onec_guid`. A `src/pricing/priceStats.ts` module recomputes median for affected GUIDs after invoice writes. The invoice-detail API joins the table and computes deviation %. Frontend renders an extra column and applies CSS classes based on deviation.

**Tech Stack:** Node.js 25, TypeScript, Express 5, MariaDB (mysql2/promise), Vitest, vanilla HTML/JS frontend (no build step).

**Spec:** [`docs/superpowers/specs/2026-05-11-median-price-anomaly-design.md`](../specs/2026-05-11-median-price-anomaly-design.md)

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/pricing/priceStats.ts` | Create | Core: compute & UPSERT median for a GUID; batch helper; backfill |
| `src/pricing/medianOf.ts` | Create | Pure: median of number[]; reused so it can be unit-tested without DB |
| `tests/pricing/medianOf.test.ts` | Create | Tests for the pure helper |
| `tests/pricing/priceStats.test.ts` | Create | Tests for DB-backed recompute |
| `src/database/migrations.ts` | Modify (append migration 24) | Schema + backfill call into priceStats |
| `src/database/repositories/invoiceRepo.ts` | Modify (6 hook sites) | Trigger async recompute after item insert / update / delete |
| `src/api/routes/invoices.ts` | Modify ([line 192-205](../../src/api/routes/invoices.ts)) | Detail endpoint enriches items with median + deviation_pct |
| `tests/api/invoices.detail.test.ts` | Create | Test detail endpoint returns median + deviation |
| `public/js/app.js` | Modify (invoice detail render) | New «Обычная» column; row class by deviation |
| `public/css/style.css` | Modify | Heatmap row classes (good/warn/alert/anomaly) |
| `tests/helpers/db.ts` | Modify | Add `nomenclature_price_stats` to TRUNCATE list |

Each task is committable on its own. Tests precede implementation (TDD).

---

## Task 1: Pure median helper

**Files:**
- Create: `src/pricing/medianOf.ts`
- Test: `tests/pricing/medianOf.test.ts`

- [ ] **Step 1.1: Write the failing test**

Create `tests/pricing/medianOf.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { medianOf } from '../../src/pricing/medianOf';

describe('medianOf', () => {
  it('returns null for empty array', () => {
    expect(medianOf([])).toBeNull();
  });

  it('returns the single value for length 1', () => {
    expect(medianOf([42])).toBe(42);
  });

  it('returns middle value for odd-length sorted input', () => {
    // sorted: [1, 3, 5] → median = 3
    expect(medianOf([1, 5, 3])).toBe(3);
  });

  it('returns average of two middle values for even length', () => {
    // sorted: [1, 2, 3, 4] → median = (2+3)/2 = 2.5
    expect(medianOf([4, 1, 3, 2])).toBe(2.5);
  });

  it('handles decimal prices', () => {
    expect(medianOf([10.5, 20.0, 15.25])).toBe(15.25);
  });

  it('does not mutate input', () => {
    const input = [3, 1, 2];
    medianOf(input);
    expect(input).toEqual([3, 1, 2]);
  });
});
```

- [ ] **Step 1.2: Run test to verify it fails**

Run: `npx vitest run tests/pricing/medianOf.test.ts`
Expected: FAIL — `Cannot find module '../../src/pricing/medianOf'`.

- [ ] **Step 1.3: Implement the minimal helper**

Create `src/pricing/medianOf.ts`:

```ts
/**
 * Median of a numeric array. Returns null for empty input.
 * Does not mutate the input.
 */
export function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}
```

- [ ] **Step 1.4: Run test to verify it passes**

Run: `npx vitest run tests/pricing/medianOf.test.ts`
Expected: PASS — all 6 tests green.

- [ ] **Step 1.5: Commit**

```bash
git add src/pricing/medianOf.ts tests/pricing/medianOf.test.ts
git commit -m "feat(pricing): add pure medianOf helper"
```

---

## Task 2: priceStats module (DB-backed)

**Files:**
- Create: `src/pricing/priceStats.ts`
- Test: `tests/pricing/priceStats.test.ts`
- Modify: `tests/helpers/db.ts` (add new table to TRUNCATE list)

This task assumes migration 24 already creates the `nomenclature_price_stats` table — we'll add the migration in Task 3 and run tests against it. To keep tasks small we sequence:
- Task 2 writes the module + tests (tests will fail because table doesn't exist yet, that's expected)
- Task 3 adds migration; running tests after Task 3 = all green

This is the only out-of-order coupling. Everything else is straight TDD.

- [ ] **Step 2.1: Update test helper to truncate the new table**

Open `tests/helpers/db.ts:48-62` (the `tables` array). Add `'nomenclature_price_stats'` near the top so it's TRUNCATEd alongside everything else:

```ts
  const tables = [
    'nomenclature_price_stats',
    'sber_payments',
    'invoice_items',
    'invoices',
    'mapping_supplier_usage',
    'nomenclature_mappings',
    'onec_nomenclature',
    'sber_tokens',
    'suppliers',
    'notification_events',
    'users',
    'webhook_config',
    'analyzer_config',
    'api_requests_log',
  ];
```

- [ ] **Step 2.2: Write the failing tests**

Create `tests/pricing/priceStats.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { recomputeMedianForGuid, recomputeMedianForGuids } from '../../src/pricing/priceStats';

const GUID = 'aaaa-bbbb-cccc-dddd';

async function insertInvoice(date: string): Promise<number> {
  const r = await getDb().prepare(
    `INSERT INTO invoices (file_name, status, invoice_date) VALUES (?, 'processed', ?)`,
  ).run(`f-${date}`, date);
  return Number(r.lastInsertRowid);
}

async function insertItem(
  invoiceId: number,
  opts: { price: number; unit?: string; guid?: string | null } = { price: 0 },
): Promise<void> {
  await getDb().prepare(
    `INSERT INTO invoice_items (invoice_id, original_name, quantity, unit, price, total, mapping_confidence, onec_guid)
     VALUES (?, 'test', 1, ?, ?, ?, 1, ?)`,
  ).run(
    invoiceId,
    opts.unit ?? 'кг',
    opts.price,
    opts.price,
    opts.guid === undefined ? GUID : opts.guid,
  );
}

async function getStats(guid: string) {
  return getDb()
    .prepare('SELECT * FROM nomenclature_price_stats WHERE onec_guid = ?')
    .get<{ onec_guid: string; median_price: number; price_unit: string; samples: number }>(guid);
}

describe('recomputeMedianForGuid', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  it('writes nothing when fewer than 3 samples exist', async () => {
    const inv = await insertInvoice('2026-01-01');
    await insertItem(inv, { price: 100 });
    await insertItem(inv, { price: 110 });

    const result = await recomputeMedianForGuid(GUID);
    expect(result).toBeNull();
    expect(await getStats(GUID)).toBeUndefined();
  });

  it('computes median of last 10 prices (odd N)', async () => {
    // 5 invoices, all same unit, prices 10,20,30,40,50 → median 30
    for (const [i, price] of [10, 20, 30, 40, 50].entries()) {
      const inv = await insertInvoice(`2026-01-0${i + 1}`);
      await insertItem(inv, { price });
    }
    const result = await recomputeMedianForGuid(GUID);
    expect(result).not.toBeNull();
    expect(result!.median_price).toBe(30);
    expect(result!.samples).toBe(5);
    expect(result!.price_unit).toBe('кг');

    const row = await getStats(GUID);
    expect(row!.median_price).toBe(30);
  });

  it('computes mean of two middle values for even N', async () => {
    // 4 invoices, prices 10,20,30,40 → median (20+30)/2 = 25
    for (const [i, price] of [10, 20, 30, 40].entries()) {
      const inv = await insertInvoice(`2026-01-0${i + 1}`);
      await insertItem(inv, { price });
    }
    const result = await recomputeMedianForGuid(GUID);
    expect(result!.median_price).toBe(25);
    expect(result!.samples).toBe(4);
  });

  it('uses the majority unit when units diverge', async () => {
    // 4 invoices in кг, 3 in шт → majority кг, samples=4, median over кг only
    for (const [i, price] of [10, 20, 30, 40].entries()) {
      const inv = await insertInvoice(`2026-01-0${i + 1}`);
      await insertItem(inv, { price, unit: 'кг' });
    }
    for (const [i, price] of [100, 200, 300].entries()) {
      const inv = await insertInvoice(`2026-02-0${i + 1}`);
      await insertItem(inv, { price, unit: 'шт' });
    }
    const result = await recomputeMedianForGuid(GUID);
    expect(result!.price_unit).toBe('кг');
    expect(result!.samples).toBe(4);
    expect(result!.median_price).toBe(25); // median of 10,20,30,40
  });

  it('tie-breaks on unit by choosing the most recent', async () => {
    // 3 кг (older), 3 шт (newer)
    for (const [i, price] of [10, 20, 30].entries()) {
      const inv = await insertInvoice(`2026-01-0${i + 1}`);
      await insertItem(inv, { price, unit: 'кг' });
    }
    for (const [i, price] of [100, 200, 300].entries()) {
      const inv = await insertInvoice(`2026-02-0${i + 1}`);
      await insertItem(inv, { price, unit: 'шт' });
    }
    const result = await recomputeMedianForGuid(GUID);
    expect(result!.price_unit).toBe('шт');
    expect(result!.samples).toBe(3);
  });

  it('takes the 10 most recent invoices, ignores older ones', async () => {
    // 11 invoices, prices 1..11. Most recent 10 by invoice_date = 2..11. Median = (6+7)/2 = 6.5
    for (let i = 1; i <= 11; i++) {
      const inv = await insertInvoice(`2026-${String(i).padStart(2, '0')}-01`);
      await insertItem(inv, { price: i });
    }
    const result = await recomputeMedianForGuid(GUID);
    expect(result!.samples).toBe(10);
    expect(result!.median_price).toBe(6.5);
  });

  it('filters out price == 0', async () => {
    // 3 valid + 1 zero, valid prices 10,20,30. Median = 20, samples = 3.
    const dates = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04'];
    const prices = [0, 10, 20, 30];
    for (let i = 0; i < dates.length; i++) {
      const inv = await insertInvoice(dates[i]);
      await insertItem(inv, { price: prices[i] });
    }
    const result = await recomputeMedianForGuid(GUID);
    expect(result!.samples).toBe(3);
    expect(result!.median_price).toBe(20);
  });

  it('does not duplicate rows when called repeatedly (UPSERT)', async () => {
    for (const [i, price] of [10, 20, 30].entries()) {
      const inv = await insertInvoice(`2026-01-0${i + 1}`);
      await insertItem(inv, { price });
    }
    await recomputeMedianForGuid(GUID);
    await recomputeMedianForGuid(GUID);
    await recomputeMedianForGuid(GUID);

    const [rows] = await (await import('../../src/database/db')).getPool()
      .query<any[]>('SELECT COUNT(*) AS c FROM nomenclature_price_stats WHERE onec_guid = ?', [GUID]);
    expect(rows[0].c).toBe(1);
  });

  it('deletes the row when invoices vanish (samples falls below 3)', async () => {
    for (const [i, price] of [10, 20, 30].entries()) {
      const inv = await insertInvoice(`2026-01-0${i + 1}`);
      await insertItem(inv, { price });
    }
    await recomputeMedianForGuid(GUID);
    expect(await getStats(GUID)).not.toBeUndefined();

    // Now delete the items, leaving 0 samples
    await getDb().prepare('DELETE FROM invoice_items WHERE onec_guid = ?').run(GUID);
    const result = await recomputeMedianForGuid(GUID);
    expect(result).toBeNull();
    expect(await getStats(GUID)).toBeUndefined();
  });
});

describe('recomputeMedianForGuids (batch)', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  it('processes multiple GUIDs and skips null/empty entries', async () => {
    const G1 = 'guid-1';
    const G2 = 'guid-2';
    for (const [i, price] of [10, 20, 30].entries()) {
      const inv = await insertInvoice(`2026-01-0${i + 1}`);
      await insertItem(inv, { price, guid: G1 });
      await insertItem(inv, { price: price * 2, guid: G2 });
    }
    await recomputeMedianForGuids([G1, G2, null as unknown as string, '']);
    expect((await getStats(G1))!.median_price).toBe(20);
    expect((await getStats(G2))!.median_price).toBe(40);
  });
});
```

- [ ] **Step 2.3: Run tests to verify they fail**

Run: `npx vitest run tests/pricing/priceStats.test.ts`
Expected: FAIL — `Cannot find module '../../src/pricing/priceStats'` (module doesn't exist yet).

- [ ] **Step 2.4: Implement priceStats.ts**

Create `src/pricing/priceStats.ts`:

```ts
import { getDb } from '../database/db';
import { logger } from '../utils/logger';
import { medianOf } from './medianOf';

const HISTORY_LIMIT = 10;
const MIN_SAMPLES = 3;

export interface PriceStats {
  onec_guid: string;
  median_price: number;
  price_unit: string;
  samples: number;
}

interface ItemRow {
  price: number;
  unit: string;
}

/**
 * Recompute median price over the most recent {@link HISTORY_LIMIT}
 * invoice_items for a single 1С GUID and UPSERT into
 * `nomenclature_price_stats`. If fewer than {@link MIN_SAMPLES} valid
 * samples exist (or none) the row is DELETEd so callers never see stale
 * data. Returns the computed stats or null on insufficient samples.
 *
 * Safe to call repeatedly — UPSERT via PRIMARY KEY conflict.
 */
export async function recomputeMedianForGuid(guid: string): Promise<PriceStats | null> {
  if (!guid) return null;
  const db = getDb();

  // Pull up to 10 most recent prices for this GUID, newest first.
  const rows = await db.prepare(
    `SELECT ii.price, ii.unit
     FROM invoice_items ii
     JOIN invoices i ON i.id = ii.invoice_id
     WHERE ii.onec_guid = ?
       AND ii.price > 0
       AND ii.unit IS NOT NULL AND ii.unit != ''
     ORDER BY i.invoice_date DESC, ii.id DESC
     LIMIT ${HISTORY_LIMIT}`,
  ).all<ItemRow>(guid);

  // Group by unit. Pick the unit with the most samples; on tie, the one
  // from the freshest row (rows[0] is newest because ORDER BY DESC).
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.unit, (counts.get(r.unit) ?? 0) + 1);
  if (counts.size === 0) {
    await db.prepare('DELETE FROM nomenclature_price_stats WHERE onec_guid = ?').run(guid);
    return null;
  }
  let chosenUnit = rows[0].unit;          // freshest → wins ties
  let chosenCount = counts.get(chosenUnit)!;
  for (const [u, c] of counts) {
    if (c > chosenCount) { chosenUnit = u; chosenCount = c; }
  }

  const prices = rows.filter(r => r.unit === chosenUnit).map(r => r.price);
  if (prices.length < MIN_SAMPLES) {
    await db.prepare('DELETE FROM nomenclature_price_stats WHERE onec_guid = ?').run(guid);
    return null;
  }

  const median = medianOf(prices);
  if (median === null) {
    // Defensive — medianOf returns null only on [], which we filtered above.
    await db.prepare('DELETE FROM nomenclature_price_stats WHERE onec_guid = ?').run(guid);
    return null;
  }

  await db.prepare(
    `INSERT INTO nomenclature_price_stats (onec_guid, median_price, price_unit, samples, updated_at)
     VALUES (?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       median_price = VALUES(median_price),
       price_unit   = VALUES(price_unit),
       samples      = VALUES(samples),
       updated_at   = NOW()`,
  ).run(guid, median, chosenUnit, prices.length);

  return { onec_guid: guid, median_price: median, price_unit: chosenUnit, samples: prices.length };
}

/**
 * Batch helper: dedupe + filter + run sequentially. Swallows individual
 * errors so one bad GUID can't break the rest of the batch (used in
 * fire-and-forget hooks where the parent operation already succeeded).
 */
export async function recomputeMedianForGuids(guids: Array<string | null | undefined>): Promise<void> {
  const unique = Array.from(new Set(guids.filter((g): g is string => typeof g === 'string' && g.length > 0)));
  for (const guid of unique) {
    try {
      await recomputeMedianForGuid(guid);
    } catch (err) {
      logger.warn('priceStats: recompute failed', { guid, error: (err as Error).message });
    }
  }
}

/**
 * One-time backfill called from migration 24. Walks every distinct
 * onec_guid in invoice_items and rebuilds price_stats. Idempotent.
 */
export async function backfillAllStats(): Promise<{ processed: number }> {
  const rows = await getDb().prepare(
    `SELECT DISTINCT onec_guid FROM invoice_items
     WHERE onec_guid IS NOT NULL AND onec_guid != ''`,
  ).all<{ onec_guid: string }>();
  let processed = 0;
  for (const { onec_guid } of rows) {
    try {
      await recomputeMedianForGuid(onec_guid);
      processed++;
    } catch (err) {
      logger.warn('priceStats: backfill recompute failed', { guid: onec_guid, error: (err as Error).message });
    }
  }
  logger.info('priceStats: backfill complete', { processed });
  return { processed };
}
```

- [ ] **Step 2.5: Try to run tests (will still fail — no table yet)**

Run: `npx vitest run tests/pricing/priceStats.test.ts`
Expected: FAIL — `Table 'scanflow_test.nomenclature_price_stats' doesn't exist`. This is expected — we add the migration in Task 3. Commit what we have so far.

- [ ] **Step 2.6: Commit**

```bash
git add src/pricing/priceStats.ts tests/pricing/priceStats.test.ts tests/helpers/db.ts
git commit -m "feat(pricing): add priceStats module + tests (table comes in next commit)"
```

---

## Task 3: Migration 24 — create table + backfill

**Files:**
- Modify: `src/database/migrations.ts` (append new migration object to `MIGRATIONS` array)

- [ ] **Step 3.1: Open migrations.ts and find the last `version: 23` block**

Run: `grep -n "version: 23" src/database/migrations.ts`
Expected: one match. Open the file, find the closing `},` of that migration. Migration 24 goes immediately after it, before the closing `]` of `MIGRATIONS`.

- [ ] **Step 3.2: Append migration 24**

Insert after the `version: 23` migration's closing `},`:

```ts
  {
    version: 24,
    name: 'nomenclature_price_stats: median price per GUID',
    detect: (exec) => hasTable(exec, 'nomenclature_price_stats'),
    run: async (exec) => {
      await exec.query(`
        CREATE TABLE IF NOT EXISTS nomenclature_price_stats (
          onec_guid    VARCHAR(64) NOT NULL PRIMARY KEY,
          median_price DOUBLE      NOT NULL,
          price_unit   VARCHAR(32) NOT NULL,
          samples      INT         NOT NULL,
          updated_at   DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      // Backfill: rebuild stats for every GUID already in invoice_items.
      // Imported lazily to avoid a circular require if the module ever
      // grows other dependencies that touch the db.
      const { backfillAllStats } = await import('../pricing/priceStats');
      await backfillAllStats();
    },
  },
```

- [ ] **Step 3.3: Run the priceStats tests — the table now exists**

Run: `npx vitest run tests/pricing/priceStats.test.ts`
Expected: PASS — all 10 tests green. The `resetDb` helper runs migrations, including 24, before each test.

- [ ] **Step 3.4: Run the full test suite to make sure we didn't break anything**

Run: `npx vitest run`
Expected: PASS for everything that was passing before; new tests added in Task 1+2 also green. (Many tests in the project are `.skip` from the SQLite→MariaDB migration — that's pre-existing and not our concern.)

- [ ] **Step 3.5: Commit**

```bash
git add src/database/migrations.ts
git commit -m "feat(db): add migration 24 — nomenclature_price_stats table + backfill"
```

---

## Task 4: Hooks in invoiceRepo

We trigger async recompute at every write that affects the price/unit/guid columns of `invoice_items`. The recompute is fire-and-forget — errors logged, never thrown.

**Files:**
- Modify: `src/database/repositories/invoiceRepo.ts`

- [ ] **Step 4.1: Add the import at the top of the file**

Find the existing imports (around line 1-10). Add:

```ts
import { recomputeMedianForGuids } from '../../pricing/priceStats';
```

Actually the path from `src/database/repositories/invoiceRepo.ts` to `src/pricing/priceStats.ts` is `../../pricing/priceStats`. Verify with `ls src/pricing/` — should show `priceStats.ts` and `medianOf.ts`.

- [ ] **Step 4.2: Add hook helper near the top of the file (after imports, before `export const invoiceRepo`)**

Insert this helper:

```ts
/**
 * Fire-and-forget recompute of median price stats for the given GUIDs.
 * Errors are logged but never re-thrown — the parent invoice write has
 * already committed by the time we get here, and a failed stats refresh
 * must not surface as a user-visible failure.
 */
function triggerStatsRecompute(guids: Array<string | null | undefined>): void {
  void recomputeMedianForGuids(guids).catch(() => { /* logged inside */ });
}
```

- [ ] **Step 4.3: Hook into `addItem`**

Find `async addItem(data: CreateInvoiceItemData)` (around [line 256](../../src/database/repositories/invoiceRepo.ts#L256)). Currently it ends:

```ts
    return (await db
      .prepare('SELECT * FROM invoice_items WHERE id = ?')
      .get<InvoiceItem>(Number(result.lastInsertRowid)))!;
  },
```

Replace with:

```ts
    const created = (await db
      .prepare('SELECT * FROM invoice_items WHERE id = ?')
      .get<InvoiceItem>(Number(result.lastInsertRowid)))!;
    triggerStatsRecompute([created.onec_guid]);
    return created;
  },
```

- [ ] **Step 4.4: Hook into `mapItem`**

Find `async mapItem(itemId, onecGuid, mappedName)` (around [line 290](../../src/database/repositories/invoiceRepo.ts#L290)). Currently:

```ts
  async mapItem(itemId: number, onecGuid: string | null, mappedName: string | null): Promise<InvoiceItem | undefined> {
    const db = getDb();
    await db.prepare(
      `UPDATE invoice_items SET onec_guid = ?, mapped_name = COALESCE(?, mapped_name) WHERE id = ?`
    ).run(onecGuid, mappedName, itemId);
    return db.prepare('SELECT * FROM invoice_items WHERE id = ?').get<InvoiceItem>(itemId);
  },
```

Replace with:

```ts
  async mapItem(itemId: number, onecGuid: string | null, mappedName: string | null): Promise<InvoiceItem | undefined> {
    const db = getDb();
    const prev = await db.prepare('SELECT onec_guid FROM invoice_items WHERE id = ?')
      .get<{ onec_guid: string | null }>(itemId);
    await db.prepare(
      `UPDATE invoice_items SET onec_guid = ?, mapped_name = COALESCE(?, mapped_name) WHERE id = ?`
    ).run(onecGuid, mappedName, itemId);
    triggerStatsRecompute([prev?.onec_guid, onecGuid]);
    return db.prepare('SELECT * FROM invoice_items WHERE id = ?').get<InvoiceItem>(itemId);
  },
```

- [ ] **Step 4.5: Hook into `updateItemQuantity`**

Find `async updateItemQuantity` (around [line 298](../../src/database/repositories/invoiceRepo.ts#L298)). Currently:

```ts
  async updateItemQuantity(
    itemId: number,
    quantity: number | null,
    unit: string | null,
    price: number | null,
  ): Promise<void> {
    await getDb().prepare(
      `UPDATE invoice_items SET quantity = ?, unit = ?, price = ? WHERE id = ?`
    ).run(quantity, unit, price, itemId);
  },
```

Replace with:

```ts
  async updateItemQuantity(
    itemId: number,
    quantity: number | null,
    unit: string | null,
    price: number | null,
  ): Promise<void> {
    const db = getDb();
    await db.prepare(
      `UPDATE invoice_items SET quantity = ?, unit = ?, price = ? WHERE id = ?`
    ).run(quantity, unit, price, itemId);
    const after = await db.prepare('SELECT onec_guid FROM invoice_items WHERE id = ?')
      .get<{ onec_guid: string | null }>(itemId);
    triggerStatsRecompute([after?.onec_guid]);
  },
```

- [ ] **Step 4.6: Hook into `updateItemFields`**

Find `async updateItemFields` (around [line 309](../../src/database/repositories/invoiceRepo.ts#L309)). Currently:

```ts
  async updateItemFields(
    itemId: number,
    fields: { quantity?: number | null; unit?: string | null; price?: number | null; total?: number | null },
  ): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if ('quantity' in fields) { sets.push('quantity = ?'); vals.push(fields.quantity); }
    if ('unit' in fields) { sets.push('unit = ?'); vals.push(fields.unit); }
    if ('price' in fields) { sets.push('price = ?'); vals.push(fields.price); }
    if ('total' in fields) { sets.push('total = ?'); vals.push(fields.total); }
    if (sets.length === 0) return;
    vals.push(itemId);
    await getDb().prepare(`UPDATE invoice_items SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  },
```

Replace with:

```ts
  async updateItemFields(
    itemId: number,
    fields: { quantity?: number | null; unit?: string | null; price?: number | null; total?: number | null },
  ): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if ('quantity' in fields) { sets.push('quantity = ?'); vals.push(fields.quantity); }
    if ('unit' in fields) { sets.push('unit = ?'); vals.push(fields.unit); }
    if ('price' in fields) { sets.push('price = ?'); vals.push(fields.price); }
    if ('total' in fields) { sets.push('total = ?'); vals.push(fields.total); }
    if (sets.length === 0) return;
    vals.push(itemId);
    const db = getDb();
    await db.prepare(`UPDATE invoice_items SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    // Only re-trigger if price/unit changed — quantity/total don't affect stats.
    if ('price' in fields || 'unit' in fields) {
      const after = await db.prepare('SELECT onec_guid FROM invoice_items WHERE id = ?')
        .get<{ onec_guid: string | null }>(itemId);
      triggerStatsRecompute([after?.onec_guid]);
    }
  },
```

- [ ] **Step 4.7: Hook into `updateItemMapping`**

Find `async updateItemMapping` (around [line 324](../../src/database/repositories/invoiceRepo.ts#L324)). Currently:

```ts
  async updateItemMapping(itemId: number, onecGuid: string, mappedName: string, confidence: number): Promise<void> {
    await getDb().prepare(
      `UPDATE invoice_items SET onec_guid = ?, mapped_name = ?, mapping_confidence = ? WHERE id = ?`
    ).run(onecGuid, mappedName, confidence, itemId);
  },
```

Replace with:

```ts
  async updateItemMapping(itemId: number, onecGuid: string, mappedName: string, confidence: number): Promise<void> {
    const db = getDb();
    const prev = await db.prepare('SELECT onec_guid FROM invoice_items WHERE id = ?')
      .get<{ onec_guid: string | null }>(itemId);
    await db.prepare(
      `UPDATE invoice_items SET onec_guid = ?, mapped_name = ?, mapping_confidence = ? WHERE id = ?`
    ).run(onecGuid, mappedName, confidence, itemId);
    triggerStatsRecompute([prev?.onec_guid, onecGuid]);
  },
```

- [ ] **Step 4.8: Hook into `deleteItems` and `delete`**

Find `async deleteItems(invoiceId)` (around [line 574](../../src/database/repositories/invoiceRepo.ts#L574)) and `async delete(id)` (around [line 578](../../src/database/repositories/invoiceRepo.ts#L578)).

Replace `deleteItems` with:

```ts
  async deleteItems(invoiceId: number): Promise<void> {
    const db = getDb();
    const guids = await db.prepare(
      'SELECT DISTINCT onec_guid FROM invoice_items WHERE invoice_id = ? AND onec_guid IS NOT NULL'
    ).all<{ onec_guid: string }>(invoiceId);
    await db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(invoiceId);
    triggerStatsRecompute(guids.map(g => g.onec_guid));
  },
```

Replace `delete` with:

```ts
  async delete(id: number): Promise<{ file_name: string | null }> {
    const invoice = await this.getById(id);
    const fileName = invoice?.file_name ?? null;
    const db = getDb();
    const guids = await db.prepare(
      'SELECT DISTINCT onec_guid FROM invoice_items WHERE invoice_id = ? AND onec_guid IS NOT NULL'
    ).all<{ onec_guid: string }>(id);
    await db.transaction(async (txn) => {
      await txn.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(id);
      await txn.prepare('DELETE FROM invoices WHERE id = ?').run(id);
    });
    triggerStatsRecompute(guids.map(g => g.onec_guid));
    return { file_name: fileName };
  },
```

- [ ] **Step 4.9: Type-check the project**

Run: `npx tsc --noEmit`
Expected: 0 errors. If TS complains about the import path of `recomputeMedianForGuids`, fix it.

- [ ] **Step 4.10: Re-run tests**

Run: `npx vitest run`
Expected: PASS. The hooks are fire-and-forget so existing tests don't care; new pricing tests still pass.

- [ ] **Step 4.11: Commit**

```bash
git add src/database/repositories/invoiceRepo.ts
git commit -m "feat(invoices): trigger median-price recompute on item write/delete"
```

---

## Task 5: API — invoice detail includes median + deviation

**Files:**
- Modify: `src/database/repositories/invoiceRepo.ts` (extend `getItems` OR `getWithItems` to JOIN)
- Modify: `src/api/routes/invoices.ts` ([line 192-205](../../src/api/routes/invoices.ts#L192))
- Create: `tests/api/invoices.detail.test.ts`

The cleanest approach is to do the JOIN inside `getWithItems` (the function the detail endpoint calls) and compute `price_deviation_pct` in the route handler. That way other callers of `getItems` (1С pickup, etc.) keep the lean shape.

- [ ] **Step 5.1: Write the failing test**

Create `tests/api/invoices.detail.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';

// Mock heavy deps so createServer doesn't try to start them.
vi.mock('../../src/watcher/fileWatcher', () => ({ FileWatcher: class {} }));
vi.mock('../../src/mapping/nomenclatureMapper', () => ({ NomenclatureMapper: class {} }));

import { createServer } from '../../src/api/server';
import { FileWatcher } from '../../src/watcher/fileWatcher';
import { NomenclatureMapper } from '../../src/mapping/nomenclatureMapper';

let app: express.Express;
beforeAll(() => {
  app = createServer(new FileWatcher() as never, new NomenclatureMapper() as never);
});

async function setupUser(): Promise<string> {
  await getDb().prepare(
    `INSERT INTO users (id, username, password_hash, api_key, role) VALUES (1, 'admin', 'x', 'k', 'admin')`
  ).run();
  return 'k';
}

async function createInvoice(date: string): Promise<number> {
  const r = await getDb().prepare(
    `INSERT INTO invoices (file_name, status, invoice_date) VALUES (?, 'processed', ?)`
  ).run(`f-${date}`, date);
  return Number(r.lastInsertRowid);
}

async function addItem(
  invoiceId: number,
  opts: { price: number; unit: string; guid: string | null },
): Promise<void> {
  await getDb().prepare(
    `INSERT INTO invoice_items (invoice_id, original_name, quantity, unit, price, total, mapping_confidence, onec_guid)
     VALUES (?, 'x', 1, ?, ?, ?, 1, ?)`
  ).run(invoiceId, opts.unit, opts.price, opts.price, opts.guid);
}

describe('GET /api/invoices/:id (price stats)', () => {
  const GUID = 'gid-flour';
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  it('returns median_price and price_deviation_pct when 3+ prior matched-unit samples exist', async () => {
    const key = await setupUser();
    // 3 prior invoices establishing median = 100 in кг
    for (const [i, p] of [90, 100, 110].entries()) {
      const inv = await createInvoice(`2026-01-0${i + 1}`);
      await addItem(inv, { price: p, unit: 'кг', guid: GUID });
    }
    // current invoice — price 200 in кг (2× outlier)
    const current = await createInvoice('2026-02-01');
    await addItem(current, { price: 200, unit: 'кг', guid: GUID });

    // Force backfill so price_stats is populated
    const { backfillAllStats } = await import('../../src/pricing/priceStats');
    await backfillAllStats();

    const res = await request(app).get(`/api/invoices/${current}`).set('X-API-Key', key);
    expect(res.status).toBe(200);
    const item = res.body.data.items[0];
    expect(item.median_price).toBe(100);
    expect(item.median_price_unit).toBe('кг');
    expect(item.median_samples).toBeGreaterThanOrEqual(3);
    // (200 - 100) / 100 * 100 = 100
    expect(item.price_deviation_pct).toBe(100);
  });

  it('returns null deviation when samples < 3', async () => {
    const key = await setupUser();
    for (const [i, p] of [90, 110].entries()) {
      const inv = await createInvoice(`2026-01-0${i + 1}`);
      await addItem(inv, { price: p, unit: 'кг', guid: GUID });
    }
    const { backfillAllStats } = await import('../../src/pricing/priceStats');
    await backfillAllStats();

    const current = await createInvoice('2026-02-01');
    await addItem(current, { price: 200, unit: 'кг', guid: GUID });

    const res = await request(app).get(`/api/invoices/${current}`).set('X-API-Key', key);
    expect(res.status).toBe(200);
    const item = res.body.data.items[0];
    expect(item.median_price).toBeNull();
    expect(item.price_deviation_pct).toBeNull();
  });

  it('returns median but null deviation when item.unit differs from median_price_unit', async () => {
    const key = await setupUser();
    for (const [i, p] of [90, 100, 110].entries()) {
      const inv = await createInvoice(`2026-01-0${i + 1}`);
      await addItem(inv, { price: p, unit: 'кг', guid: GUID });
    }
    const { backfillAllStats } = await import('../../src/pricing/priceStats');
    await backfillAllStats();

    const current = await createInvoice('2026-02-01');
    await addItem(current, { price: 200, unit: 'шт', guid: GUID }); // unit mismatch

    const res = await request(app).get(`/api/invoices/${current}`).set('X-API-Key', key);
    expect(res.status).toBe(200);
    const item = res.body.data.items[0];
    expect(item.median_price).toBe(100);          // we still surface it for the UI label
    expect(item.median_price_unit).toBe('кг');
    expect(item.price_deviation_pct).toBeNull();  // but no deviation → no heatmap
  });

  it('returns null for items without onec_guid', async () => {
    const key = await setupUser();
    const inv = await createInvoice('2026-02-01');
    await addItem(inv, { price: 200, unit: 'кг', guid: null });

    const res = await request(app).get(`/api/invoices/${inv}`).set('X-API-Key', key);
    expect(res.status).toBe(200);
    const item = res.body.data.items[0];
    expect(item.median_price).toBeNull();
    expect(item.price_deviation_pct).toBeNull();
  });
});
```

- [ ] **Step 5.2: Run the test to verify it fails**

Run: `npx vitest run tests/api/invoices.detail.test.ts`
Expected: FAIL — `Cannot read properties of undefined (reading 'median_price')` or similar (the field doesn't exist yet).

- [ ] **Step 5.3: Modify `getWithItems` to JOIN price stats**

In `src/database/repositories/invoiceRepo.ts`, find `getWithItems` (around [line 336](../../src/database/repositories/invoiceRepo.ts#L336)):

```ts
  async getWithItems(id: number): Promise<(Invoice & { items: InvoiceItem[] }) | undefined> {
    const invoice = await this.getById(id);
    if (!invoice) return undefined;
    const items = await this.getItems(id);
    return { ...invoice, items };
  },
```

Replace with:

```ts
  async getWithItems(id: number): Promise<(Invoice & { items: Array<InvoiceItem & { median_price: number | null; median_price_unit: string | null; median_samples: number | null }> }) | undefined> {
    const invoice = await this.getById(id);
    if (!invoice) return undefined;
    const items = await getDb().prepare(
      `SELECT ii.*,
              ps.median_price       AS median_price,
              ps.price_unit         AS median_price_unit,
              ps.samples            AS median_samples
       FROM invoice_items ii
       LEFT JOIN nomenclature_price_stats ps ON ps.onec_guid = ii.onec_guid
       WHERE ii.invoice_id = ?
       ORDER BY ii.id`
    ).all<InvoiceItem & { median_price: number | null; median_price_unit: string | null; median_samples: number | null }>(id);
    return { ...invoice, items };
  },
```

- [ ] **Step 5.4: Compute `price_deviation_pct` in the route handler**

Open `src/api/routes/invoices.ts:194-205`. Currently:

```ts
router.get('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const raw = await invoiceRepo.getWithItems(id);
  const invoice = raw ? { ...(await enrichInvoiceWithSupplier(raw)), items: raw.items } : raw;

  if (!invoice) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }

  res.json({ data: invoice });
});
```

Replace with:

```ts
router.get('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const raw = await invoiceRepo.getWithItems(id);
  if (!raw) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }
  const enriched = { ...(await enrichInvoiceWithSupplier(raw)), items: raw.items };
  // Compute deviation per item. Surface median only when samples ≥ 3.
  // Surface deviation only when units match (else heatmap would be meaningless).
  enriched.items = enriched.items.map((item: any) => {
    const hasStats = item.median_price != null && item.median_samples != null && item.median_samples >= 3;
    const unitsMatch = item.unit && item.median_price_unit && item.unit === item.median_price_unit;
    const priceValid = typeof item.price === 'number' && item.price > 0;

    let price_deviation_pct: number | null = null;
    if (hasStats && unitsMatch && priceValid && item.median_price > 0) {
      price_deviation_pct = ((item.price - item.median_price) / item.median_price) * 100;
    }

    return {
      ...item,
      // If samples < 3, hide median entirely (frontend rule).
      median_price: hasStats ? item.median_price : null,
      median_price_unit: hasStats ? item.median_price_unit : null,
      median_samples: hasStats ? item.median_samples : null,
      price_deviation_pct,
    };
  });

  res.json({ data: enriched });
});
```

- [ ] **Step 5.5: Run the test to verify it passes**

Run: `npx vitest run tests/api/invoices.detail.test.ts`
Expected: PASS — all 4 tests green.

- [ ] **Step 5.6: Re-run full suite**

Run: `npx vitest run && npx tsc --noEmit`
Expected: tests PASS, 0 TS errors.

- [ ] **Step 5.7: Commit**

```bash
git add src/database/repositories/invoiceRepo.ts src/api/routes/invoices.ts tests/api/invoices.detail.test.ts
git commit -m "feat(invoices): include median_price and deviation in detail endpoint"
```

---

## Task 6: Frontend — «Обычная» column + heatmap

**Files:**
- Modify: `public/js/app.js` (invoice detail render)
- Modify: `public/css/style.css`

Frontend is vanilla JS — no test framework (the existing pattern). We verify by browser.

- [ ] **Step 6.1: Find where invoice items are rendered in app.js**

Run: `grep -n "items\.map\|item\.price\|renderInvoiceDetail\|item-row" public/js/app.js | head -20`
Look for the function/block that builds the items table in the invoice detail view. It will iterate `invoice.items` and emit `<tr><td>...</td></tr>` strings. Note its line number — every change in this task happens inside it.

- [ ] **Step 6.2: Locate the items table header and add the «Обычная» column**

Find the `<thead>` row that lists current columns (e.g., «Наименование», «Кол-во», «Ед», «Цена», «Сумма»). Add a new `<th>Обычная</th>` between «Цена» and «Сумма».

If the header is in `public/app.html`, edit there. If it's built dynamically in `app.js`, edit there. Use grep to find:
```
grep -n "Цена" public/app.html public/js/app.js
```

- [ ] **Step 6.3: Add the median cell and row class in the item-row builder**

In the function that builds each row from an item, change the row's opening tag from something like `<tr>` to:

```js
function rowClassForDeviation(pct) {
  if (pct == null) return '';
  if (pct <= -10) return 'row-price-good';
  if (pct <= 10) return '';
  if (pct <= 25) return 'row-price-warn';
  if (pct <= 50) return 'row-price-alert';
  return 'row-price-anomaly';
}

function medianCell(item) {
  if (item.median_price == null) return '<td></td>';
  // Use Russian formatting: 52,30 ₽ + small (N поставок)
  const price = Number(item.median_price).toFixed(2).replace('.', ',');
  return `<td><div>${price} ₽</div><small class="muted">${item.median_samples} поставок</small></td>`;
}
```

Use these in the row template:

```js
const cls = rowClassForDeviation(item.price_deviation_pct);
return `<tr class="${cls}">
  <td>${item.mapped_name || item.original_name}</td>
  <td>${item.quantity ?? ''}</td>
  <td>${item.unit ?? ''}</td>
  <td>${item.price ?? ''}</td>
  ${medianCell(item)}
  <td>${item.total ?? ''}</td>
</tr>`;
```

Adapt to the existing template style — if the file uses DOM construction (createElement) instead of template strings, follow that pattern. The key invariants:
1. New `<td>` between price and total.
2. Row gets class from `rowClassForDeviation(item.price_deviation_pct)`.

- [ ] **Step 6.4: Add CSS heatmap classes**

Open `public/css/style.css`. Append at the end:

```css
/* === Price-anomaly heatmap on invoice item rows === */
.row-price-good     { background: rgba(6, 214, 160, 0.08); }
.row-price-warn     { background: rgba(251, 191, 36, 0.10); }
.row-price-alert    { background: rgba(251, 146, 60, 0.13); }
.row-price-anomaly  { background: rgba(239, 68, 68, 0.15); }

.row-price-good td, .row-price-warn td, .row-price-alert td, .row-price-anomaly td {
  /* Keep text colour from theme — backgrounds are translucent enough to read on both light and dark. */
}

.muted { color: var(--text-muted, #888); font-size: 0.85em; }
```

If `--text-muted` is already defined elsewhere in the file, the `var()` fallback (`#888`) is just a safety net.

- [ ] **Step 6.5: Manual browser verification**

Make sure the dev server is running on port 8899 (per the earlier session: `npm run dev`).

Open `http://localhost:8899/` in a browser, log in as `admin` / `Desdes123`, open an invoice that has 3+ prior matched-unit deliveries for at least one GUID (the existing 43 prod invoices likely have several). Visually verify:
- A new «Обычная» column shows median + «N поставок».
- Items where current price > 25% above median have orange row background; > 50% red.
- Items without enough history have an empty cell and no row color.

If the dashboard doesn't refresh, hard-reload (`Ctrl+Shift+R`).

- [ ] **Step 6.6: Commit**

```bash
git add public/js/app.js public/app.html public/css/style.css
git commit -m "feat(ui): «Обычная» column + heatmap on invoice items"
```

(If `public/app.html` wasn't touched, omit it from the `git add`.)

---

## Task 7: End-to-end sanity check

- [ ] **Step 7.1: Verify all tests pass**

Run: `npx vitest run`
Expected: all new tests green; pre-existing passing tests still pass; `.skip`'d tests stay `.skip`'d (those are pre-existing tech debt).

- [ ] **Step 7.2: Verify type check is clean**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 7.3: Verify migration is idempotent**

In a test DB (`DB_NAME=scanflow_test`), run `runMigrations` twice in a row. Easiest: restart the dev server (`Ctrl+C` then `npm run dev`) and confirm:
- First start: migration 24 applies, log says `Migration applied {version:24,...}`.
- Second start: log says `Migration already present, backfilled history` or simply no apply line — the `detect()` (which checks `hasTable('nomenclature_price_stats')`) returns true and skips.

- [ ] **Step 7.4: Live prod-DB smoke test (the dev server is pointed at prod)**

With the dev server running:

```bash
curl -s -H "X-API-Key: $(python -c "import pymysql; c=pymysql.connect(host='192.168.33.3',port=3306,user='scanflow',password='bW72yelUrlS39Ncr',database='scanflow').cursor(); c.execute('SELECT api_key FROM users WHERE id=1'); print(c.fetchone()[0])")" \
  http://localhost:8899/api/invoices/$(python -c "import pymysql; c=pymysql.connect(host='192.168.33.3',port=3306,user='scanflow',password='bW72yelUrlS39Ncr',database='scanflow').cursor(); c.execute('SELECT id FROM invoices ORDER BY id DESC LIMIT 1'); print(c.fetchone()[0])") \
  | python -m json.tool | head -60
```

Verify that the response contains `median_price`, `median_price_unit`, `median_samples`, `price_deviation_pct` on each item. Some will be non-null, some null — depending on whether prior history exists.

If everything looks right, the feature is live in the dev environment pointing at prod data.

---

## Out of scope (per spec)

The following are intentionally NOT in this plan — confirm before adding:
- Per-supplier median (only global by GUID).
- Telegram / email notification on `price_deviation_pct > 50`.
- Blocking `approve_for_1c` on red rows.
- A price-history graph view.
- Comparison against external market data (DaData / competitor APIs).

---

## Self-review notes

- Every spec requirement has a corresponding task: schema (Task 3), priceStats module (Task 1+2), hooks (Task 4), API (Task 5), frontend (Task 6), edge cases (covered across Task 2 + Task 5 tests).
- No placeholder language. All test bodies, SQL, TS, CSS are concrete.
- Type signatures are consistent: `recomputeMedianForGuid` returns `Promise<PriceStats | null>`; the `triggerStatsRecompute` helper takes `Array<string | null | undefined>` matching the spec's tolerance for null GUIDs.
- Task 2 explicitly notes the out-of-order dependency on Task 3's migration and how to verify (commit-and-fail-tests-until-Task-3-runs).
- Task 6 frontend lacks unit tests by design — the spec explicitly says heatmap CSS is verified by eye.
