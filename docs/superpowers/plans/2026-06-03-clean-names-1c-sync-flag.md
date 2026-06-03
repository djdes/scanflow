# Clean nomenclature names + 1C sync flag — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clean trailing size/caliber/pack junk from unmatched item names before they create 1C Номенклатура, and add a global "nomenclature needs export" flag a per-minute 1C job reads/clears.

**Architecture:** A pure `cleanItemName()` plugs into `NomenclatureMapper.map()`'s `none` branch (one DRY spot all ingest paths share). A single-row `integration_sync_state` table + `syncStateRepo` backs a `GET/POST /api/integrations/sync-flag` pair; the flag is set when an approved invoice has unmatched items and cleared with a race guard. The 1C processing splits into a reusable load core, the two existing manual commands, and a new scheduled full-cycle command.

**Tech Stack:** Node 25 + TypeScript (strict), Express 5, MariaDB via the `getDb()` wrapper, vitest + supertest, 1C:UNF BSL.

**Spec:** [docs/superpowers/specs/2026-06-03-clean-names-and-1c-sync-flag-design.md](../specs/2026-06-03-clean-names-and-1c-sync-flag-design.md)

**Conventions to honor:**
- All repo methods are async — always `await` (CLAUDE.md §15).
- Schema changes only via a new idempotent migration object (CLAUDE.md §16).
- DB tests must point at localhost + a DB_NAME containing `test`; the guard in `tests/helpers/db.ts` enforces it (CLAUDE.md §17). DB/API tests are wrapped in `describe.runIf((process.env.DB_NAME || '').includes('test'))` so they no-op without a test DB.
- DB datetime values come back as raw strings (`dateStrings: true`, `timezone: 'Z'`). The flag `since` is round-tripped verbatim — never reformatted — so comparisons stay timezone-consistent.

---

## Part A — Clean names for unmatched items

### Task A1: `cleanItemName` pure function (TDD)

**Files:**
- Create: `src/mapping/nameCleaner.ts`
- Test: `tests/mapping/nameCleaner.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/mapping/nameCleaner.test.ts
import { describe, it, expect } from 'vitest';
import { cleanItemName } from '../../src/mapping/nameCleaner';

describe('cleanItemName', () => {
  it('strips trailing weight range + caliber code', () => {
    expect(cleanItemName('Ветчина с бедром индейки вареная 3-4кг d120'))
      .toBe('Ветчина с бедром индейки вареная');
  });

  it('strips caliber with Cyrillic д and a space', () => {
    expect(cleanItemName('Колбаса д 80')).toBe('Колбаса');
    expect(cleanItemName('Колбаса д80')).toBe('Колбаса');
  });

  it('strips mid-name weight and trailing packaging word', () => {
    expect(cleanItemName('Сельдь филе Классическая в масле 3 кг ведро'))
      .toBe('Сельдь филе Классическая в масле');
  });

  it('strips trailing packaging word but preserves percent (fat content)', () => {
    expect(cleanItemName('Молоко 3,2% пакет')).toBe('Молоко 3,2%');
    expect(cleanItemName('Сметана 20%')).toBe('Сметана 20%');
  });

  it('strips weight/volume/count units', () => {
    expect(cleanItemName('Мука 50кг')).toBe('Мука');
    expect(cleanItemName('Вода питьевая 500 мл')).toBe('Вода питьевая');
    expect(cleanItemName('Яйцо Куриное 10шт')).toBe('Яйцо Куриное');
  });

  it('is idempotent', () => {
    const once = cleanItemName('Ветчина вареная 3-4кг d120');
    expect(cleanItemName(once)).toBe(once);
  });

  it('falls back to raw when cleaning would empty the name', () => {
    expect(cleanItemName('3 кг')).toBe('3 кг');
    expect(cleanItemName('')).toBe('');
  });

  it('leaves a clean name untouched', () => {
    expect(cleanItemName('Лук репчатый')).toBe('Лук репчатый');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mapping/nameCleaner.test.ts`
Expected: FAIL — `Failed to resolve import ... nameCleaner` / `cleanItemName is not a function`.

- [ ] **Step 3: Write the implementation**

```ts
// src/mapping/nameCleaner.ts
/**
 * Conservatively trim trailing size / caliber / packaging junk from a scanned
 * item name so an UNMATCHED item creates a clean Справочники.Номенклатура in 1C.
 *
 * Trims (iteratively, from the tail): caliber/diameter codes (d120, д80, ø60),
 * weight & volume tokens incl. ranges (3-4кг, 0,5 л, 500г, 10шт), a leftover
 * trailing size number, and a small whitelist of trailing packaging words.
 *
 * PRESERVES: percent fat content (3,2%, 45%), mid-name descriptors, and never
 * returns an empty/too-short result (falls back to the raw input). The raw scan
 * (invoice_items.original_name) is a separate column and is never touched.
 *
 * Idempotent: cleanItemName(cleanItemName(x)) === cleanItemName(x).
 */

// Accounting units we recognise as a "size" suffix. Tunable.
const UNIT = '(?:кг|гр|г|мл|л|шт|штук|уп|упак|пач|бут)';

// Caliber/diameter: "d120", "д 80", "ø60". 2–3 digits, on a token boundary,
// the letter not glued to a preceding word so it can't eat a real word's "d".
const CALIBER_RE = /(?:^|[\s(])[dдøØ]\s?\d{2,3}\b\.?/gi;

// Weight/volume incl. ranges. The UNIT must follow, so "3,2%" (percent, not a
// unit) is never matched. Negative lookahead stops "шт" eating "штурм".
const WEIGHT_RE = new RegExp(
  String.raw`\s*\d+(?:[.,]\d+)?(?:\s?[-–—]\s?\d+(?:[.,]\d+)?)?\s*${UNIT}\.?(?![а-яёa-z])`,
  'gi',
);

// Trailing packaging words (whitelist), only at the very end. Tunable list.
const TRAIL_PACK_RE = /\s*(?:пэт|в\/у|б\/у|вакуум\w*|в\s?вакууме|ведро|лоток|пакет)\.?\s*$/i;

// Leftover trailing standalone number/range. Requires the string to END in a
// digit, so "…3,2%" (ends in %) is preserved.
const TRAIL_NUM_RE = /[\s,;–-]+\d+(?:[.,]\d+)?(?:\s?[-–]\s?\d+(?:[.,]\d+)?)?\s*$/;

// Leftover trailing punctuation/separators.
const TRAIL_PUNCT_RE = /[\s,.;:–—-]+$/;

export function cleanItemName(raw: string): string {
  if (!raw) return raw;
  let s = raw;
  let prev: string;
  // Iterate to a fixed point: order of trailing tokens doesn't matter and the
  // function becomes idempotent.
  do {
    prev = s;
    s = s.replace(CALIBER_RE, ' ');
    s = s.replace(WEIGHT_RE, ' ');
    s = s.replace(TRAIL_PACK_RE, '');
    s = s.replace(TRAIL_NUM_RE, '');
    s = s.replace(TRAIL_PUNCT_RE, '');
    s = s.replace(/\s{2,}/g, ' ').trim();
  } while (s !== prev);

  // Never destroy the name entirely.
  if (s.length < 2) return raw.trim();
  return s;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mapping/nameCleaner.test.ts`
Expected: PASS (all cases). If a case fails, adjust the regexes — do NOT relax the percent-preservation or fallback tests.

- [ ] **Step 5: Commit**

```bash
git add src/mapping/nameCleaner.ts tests/mapping/nameCleaner.test.ts
git commit -m "feat(mapping): cleanItemName — trim trailing size/caliber/pack junk"
```

---

### Task A2: Wire `cleanItemName` into the mapper's `none` branch

**Files:**
- Modify: `src/mapping/nomenclatureMapper.ts` (import + the `// 3. None` return at ~line 300)
- Test: `tests/mapping/mapper-clean-none.test.ts`

- [ ] **Step 1: Write the failing DB-gated test**

```ts
// tests/mapping/mapper-clean-none.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { NomenclatureMapper } from '../../src/mapping/nomenclatureMapper';

// Empty catalog + empty mappings → map() falls through to source 'none',
// where mapped_name must now be the cleaned name.
describe.runIf((process.env.DB_NAME || '').includes('test'))('NomenclatureMapper.map none-branch cleaning', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  it('returns a cleaned mapped_name for unmatched items', async () => {
    const mapper = new NomenclatureMapper();
    const r = await mapper.map('Ветчина с бедром индейки вареная 3-4кг d120');
    expect(r.source).toBe('none');
    expect(r.onec_guid).toBeNull();
    expect(r.mapped_name).toBe('Ветчина с бедром индейки вареная');
    expect(r.original_name).toBe('Ветчина с бедром индейки вареная 3-4кг d120');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mapping/mapper-clean-none.test.ts`
Expected (with a test DB configured): FAIL — `mapped_name` equals the raw name, not the cleaned one. (Without a test DB the suite is skipped — that's acceptable; proceed to implement, the assertion logic is verified by code review.)

- [ ] **Step 3: Implement the wiring**

In `src/mapping/nomenclatureMapper.ts`, add the import near the top (after the existing imports):

```ts
import { cleanItemName } from './nameCleaner';
```

Change the final `// 3. None` return block (currently `mapped_name: scannedName,`) to:

```ts
    // 3. None — unmatched. Clean the scan name so 1C creates a tidy
    // Справочники.Номенклатура (trims "3-4кг", "d120", "ведро", etc.).
    return {
      original_name: scannedName,
      mapped_name: cleanItemName(scannedName),
      onec_guid: null,
      confidence: 0,
      source: 'none',
      mapping_id: null,
      pack_size: null,
      pack_unit: null,
    };
```

- [ ] **Step 4: Run the test (and the full mapping suite)**

Run: `npx vitest run tests/mapping/`
Expected: PASS (the new test passes with a test DB; `normalizeName` + `packTransform` suites still green).

- [ ] **Step 5: Commit**

```bash
git add src/mapping/nomenclatureMapper.ts tests/mapping/mapper-clean-none.test.ts
git commit -m "feat(mapping): clean unmatched item names in map() none-branch"
```

---

### Task A3: Retroactive cleaning on remap

**Files:**
- Modify: `src/api/routes/invoices.ts` (the remap loop ~lines 606–685)

- [ ] **Step 1: Add a `none`-branch + counter to the remap loop**

In the remap handler, find the counters block:

```ts
  let remapped = 0;
  let changed = 0;
  let legacyMapped = 0;
  let repacked = 0;
```

Add one line:

```ts
  let cleaned = 0;
```

Find the existing `else if` for legacy (~line 627):

```ts
    } else if (result?.source === 'legacy' && result.mapped_name !== item.original_name) {
      await invoiceRepo.updateItemMappingName(item.id, result.mapped_name, result.confidence);
      legacyMapped++;
    }
```

Append a new branch immediately after it:

```ts
    } else if (
      result?.source === 'none' &&
      result.mapped_name &&
      result.mapped_name !== item.mapped_name
    ) {
      // Unmatched: refresh the editable «Название (1С)» with the cleaned name so
      // rows ingested before name-cleaning get fixed when the user re-maps.
      await invoiceRepo.updateItemMappingName(item.id, result.mapped_name, result.confidence);
      cleaned++;
    }
```

Find the `logger.info('Re-mapped invoice items', {...})` call and the `res.json({ data: {...} })` below it; add `cleaned` to both objects:

```ts
  logger.info('Re-mapped invoice items', { id, remapped, legacyMapped, changed, repacked, cleaned, vatInflated, restoredTotal, total: items.length, all: includeAll });
  res.json({ data: { id, remapped, legacyMapped, changed, repacked, cleaned, vatInflated, restoredTotal, total: items.length } });
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (`item.mapped_name` exists on the remap item shape — it is selected by `getWithItems`. If tsc reports it missing, confirm the item type includes `mapped_name` and adjust.)

- [ ] **Step 3: Commit**

```bash
git add src/api/routes/invoices.ts
git commit -m "feat(invoices): retroactively clean unmatched names on remap"
```

---

## Part B — Nomenclature sync flag (backend)

### Task B1: Migration 33 — `integration_sync_state`

**Files:**
- Modify: `src/database/migrations.ts` (append a migration object after version 32, before the closing `]`)
- Modify: `tests/helpers/db.ts` (truncate list + re-seed)

- [ ] **Step 1: Append migration 33**

Insert after the version 32 object (the `integration_events` one), keeping it inside the array:

```ts
  {
    version: 33,
    name: 'integration_sync_state — single-row flag: nomenclature needs export to 1C',
    detect: (exec) => hasTable(exec, 'integration_sync_state'),
    run: async (exec) => {
      await exec.query(`
        CREATE TABLE IF NOT EXISTS integration_sync_state (
          id                              TINYINT      NOT NULL PRIMARY KEY,
          nomenclature_sync_requested_at  DATETIME     NULL,
          CONSTRAINT chk_sync_state_single CHECK (id = 1)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      await exec.query(
        `INSERT IGNORE INTO integration_sync_state (id, nomenclature_sync_requested_at) VALUES (1, NULL)`
      );
    },
  },
```

- [ ] **Step 2: Add the table to the test reset lifecycle**

In `tests/helpers/db.ts`, add `'integration_sync_state'` to the `tables` array (any position — it has no FKs):

```ts
    'webhook_config',
    'analyzer_config',
    'integration_sync_state',
    'api_requests_log',
```

And after the existing `analyzer_config` re-seed, add the singleton re-seed:

```ts
  await pool.query(
    `INSERT INTO integration_sync_state (id, nomenclature_sync_requested_at) VALUES (1, NULL)`
  );
```

- [ ] **Step 3: Verify the migration applies**

Run (only meaningful with a test DB configured): `npx vitest run tests/database/migration-22.test.ts`
Expected: migrations run without error through version 33 (this existing test boots `runMigrations`). If no test DB, verify by code review that `hasTable`/`hasColumn` helpers exist in this file and the object shape matches version 32.

- [ ] **Step 4: Commit**

```bash
git add src/database/migrations.ts tests/helpers/db.ts
git commit -m "feat(db): migration 33 — integration_sync_state flag table"
```

---

### Task B2: `syncStateRepo`

**Files:**
- Create: `src/database/repositories/syncStateRepo.ts`
- Test: `tests/database/syncStateRepo.test.ts`

- [ ] **Step 1: Write the failing DB-gated test**

```ts
// tests/database/syncStateRepo.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { syncStateRepo } from '../../src/database/repositories/syncStateRepo';

describe.runIf((process.env.DB_NAME || '').includes('test'))('syncStateRepo', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  it('starts unset', async () => {
    const st = await syncStateRepo.getNomenclatureSyncState();
    expect(st.requested).toBe(false);
    expect(st.since).toBeNull();
  });

  it('mark then get returns requested with a since', async () => {
    await syncStateRepo.markNomenclatureSyncRequested();
    const st = await syncStateRepo.getNomenclatureSyncState();
    expect(st.requested).toBe(true);
    expect(typeof st.since).toBe('string');
  });

  it('clear with the observed since clears the flag', async () => {
    await syncStateRepo.markNomenclatureSyncRequested();
    const st = await syncStateRepo.getNomenclatureSyncState();
    const res = await syncStateRepo.clearNomenclatureSync(st.since as string);
    expect(res.cleared).toBe(true);
    expect((await syncStateRepo.getNomenclatureSyncState()).requested).toBe(false);
  });

  it('clear with an older since does NOT clear a newer flag (race guard)', async () => {
    const older = '2000-01-01 00:00:00';
    await syncStateRepo.markNomenclatureSyncRequested();
    const res = await syncStateRepo.clearNomenclatureSync(older);
    expect(res.cleared).toBe(false);
    expect((await syncStateRepo.getNomenclatureSyncState()).requested).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/database/syncStateRepo.test.ts`
Expected: FAIL — module not found (or skipped without a test DB; proceed to implement).

- [ ] **Step 3: Implement the repo**

```ts
// src/database/repositories/syncStateRepo.ts
import { getDb } from '../db';

export interface NomenclatureSyncState {
  requested: boolean;
  /** Raw DB DATETIME string (dateStrings: true), round-tripped verbatim. */
  since: string | null;
}

interface StateRow {
  nomenclature_sync_requested_at: string | null;
}

export const syncStateRepo = {
  /** Set/refresh the flag to NOW(). Upsert so it works even if the singleton
   *  row was wiped (e.g. test TRUNCATE). */
  async markNomenclatureSyncRequested(): Promise<void> {
    await getDb().prepare(`
      INSERT INTO integration_sync_state (id, nomenclature_sync_requested_at)
      VALUES (1, NOW())
      ON DUPLICATE KEY UPDATE nomenclature_sync_requested_at = NOW()
    `).run();
  },

  async getNomenclatureSyncState(): Promise<NomenclatureSyncState> {
    const row = await getDb()
      .prepare('SELECT nomenclature_sync_requested_at FROM integration_sync_state WHERE id = 1')
      .get<StateRow>();
    const since = row?.nomenclature_sync_requested_at ?? null;
    return { requested: since != null, since };
  },

  /** Clear only if no newer request arrived since `since` (race guard). */
  async clearNomenclatureSync(since: string): Promise<{ cleared: boolean }> {
    const res = await getDb().prepare(`
      UPDATE integration_sync_state
         SET nomenclature_sync_requested_at = NULL
       WHERE id = 1 AND nomenclature_sync_requested_at <= ?
    `).run(since);
    return { cleared: res.changes > 0 };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/database/syncStateRepo.test.ts`
Expected: PASS (with test DB). Without test DB: skipped — verify by review.

- [ ] **Step 5: Commit**

```bash
git add src/database/repositories/syncStateRepo.ts tests/database/syncStateRepo.test.ts
git commit -m "feat(db): syncStateRepo — race-guarded nomenclature sync flag"
```

---

### Task B3: `invoiceRepo.hasUnmatchedItems`

**Files:**
- Modify: `src/database/repositories/invoiceRepo.ts` (add a method; place it near `updateItemMapping`)

- [ ] **Step 1: Add the method**

```ts
  /** True when the invoice has at least one item not yet mapped to 1C
   *  (onec_guid IS NULL) — i.e. 1C will create new Номенклатура for it. */
  async hasUnmatchedItems(invoiceId: number): Promise<boolean> {
    const row = await getDb().prepare(
      `SELECT 1 AS x FROM invoice_items WHERE invoice_id = ? AND onec_guid IS NULL LIMIT 1`
    ).get<{ x: number }>();
    return !!row;
  },
```

(If `getDb` is not already imported at the top of `invoiceRepo.ts`, confirm it is — the file uses it throughout, so no new import is needed.)

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/database/repositories/invoiceRepo.ts
git commit -m "feat(db): invoiceRepo.hasUnmatchedItems"
```

---

### Task B4: Sync-flag endpoints

**Files:**
- Modify: `src/api/routes/integrations.ts`
- Test: `tests/api/integrations-sync-flag.test.ts`

- [ ] **Step 1: Write the failing DB-gated API test**

```ts
// tests/api/integrations-sync-flag.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';

vi.mock('../../src/watcher/fileWatcher', () => ({ FileWatcher: class {} }));
vi.mock('../../src/mapping/nomenclatureMapper', () => ({ NomenclatureMapper: class {} }));

import { createServer } from '../../src/api/server';
import { FileWatcher } from '../../src/watcher/fileWatcher';
import { NomenclatureMapper } from '../../src/mapping/nomenclatureMapper';
import { syncStateRepo } from '../../src/database/repositories/syncStateRepo';

let app: express.Express;
beforeAll(() => { app = createServer(new FileWatcher() as never, new NomenclatureMapper() as never); });

async function setupUser(): Promise<string> {
  await getDb().prepare(
    `INSERT INTO users (id, username, password_hash, api_key, role, notify_events) VALUES (1, 'admin', 'x', 'k', 'admin', '[]')`
  ).run();
  return 'k';
}

describe.runIf((process.env.DB_NAME || '').includes('test'))('GET/POST /api/integrations/sync-flag', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  it('GET returns false when unset', async () => {
    const key = await setupUser();
    const res = await request(app).get('/api/integrations/sync-flag').set('X-API-Key', key);
    expect(res.status).toBe(200);
    expect(res.body.data.nomenclature_sync_requested).toBe(false);
    expect(res.body.data.since).toBeNull();
  });

  it('GET returns true + since after mark; clear with that since resets it', async () => {
    const key = await setupUser();
    await syncStateRepo.markNomenclatureSyncRequested();

    const got = await request(app).get('/api/integrations/sync-flag').set('X-API-Key', key);
    expect(got.body.data.nomenclature_sync_requested).toBe(true);
    const since = got.body.data.since as string;

    const cleared = await request(app)
      .post('/api/integrations/sync-flag/clear')
      .set('X-API-Key', key)
      .send({ since });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.cleared).toBe(true);

    const after = await request(app).get('/api/integrations/sync-flag').set('X-API-Key', key);
    expect(after.body.data.nomenclature_sync_requested).toBe(false);
  });

  it('clear without since → 400', async () => {
    const key = await setupUser();
    const res = await request(app).post('/api/integrations/sync-flag/clear').set('X-API-Key', key).send({});
    expect(res.status).toBe(400);
  });

  it('requires auth', async () => {
    const res = await request(app).get('/api/integrations/sync-flag');
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api/integrations-sync-flag.test.ts`
Expected: FAIL — routes return 404 (or skipped without a test DB).

- [ ] **Step 3: Implement the endpoints**

In `src/api/routes/integrations.ts`, add the import and two routes (before `export default router;`):

```ts
import { syncStateRepo } from '../../database/repositories/syncStateRepo';
```

```ts
// GET /api/integrations/sync-flag — cheap per-minute check for the 1C scheduled
// job: is there new nomenclature waiting to be exported back to the site?
router.get('/sync-flag', async (_req: Request, res: Response) => {
  try {
    const st = await syncStateRepo.getNomenclatureSyncState();
    res.json({ data: { nomenclature_sync_requested: st.requested, since: st.since } });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/integrations/sync-flag/clear { since } — clear after a successful
// export. Race-guarded: only clears if no newer request arrived (stored <= since).
// `since` must be the exact string returned by GET /sync-flag.
router.post('/sync-flag/clear', async (req: Request, res: Response) => {
  const since = (req.body?.since ?? '') as unknown;
  if (typeof since !== 'string' || !since.trim()) {
    res.status(400).json({ error: 'since is required (the value from GET /sync-flag)' });
    return;
  }
  try {
    const r = await syncStateRepo.clearNomenclatureSync(since);
    res.json({ data: { cleared: r.cleared } });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/api/integrations-sync-flag.test.ts`
Expected: PASS (with test DB).

- [ ] **Step 5: Commit**

```bash
git add src/api/routes/integrations.ts tests/api/integrations-sync-flag.test.ts
git commit -m "feat(api): GET/POST /api/integrations/sync-flag"
```

---

### Task B5: Set the flag on `/send` when the invoice has unmatched items

**Files:**
- Modify: `src/api/routes/invoices.ts` (the `POST /:id/send` handler, after `approveForOneC`)
- Test: extend `tests/api/integrations-sync-flag.test.ts`

- [ ] **Step 1: Add the failing assertions**

Append to `tests/api/integrations-sync-flag.test.ts` inside the same `describe` (add helpers if not present):

```ts
  async function createProcessedInvoice(): Promise<number> {
    const r = await getDb().prepare(
      `INSERT INTO invoices (file_name, file_path, status, invoice_number) VALUES ('f','/f','processed','N-1')`
    ).run();
    return Number(r.lastInsertRowid);
  }
  async function addItem(invoiceId: number, guid: string | null): Promise<void> {
    await getDb().prepare(
      `INSERT INTO invoice_items (invoice_id, original_name, quantity, unit, price, total, mapping_confidence, onec_guid)
       VALUES (?, 'x', 1, 'шт', 10, 10, 1, ?)`
    ).run(invoiceId, guid);
  }

  it('sets the flag when an approved invoice has an unmatched item', async () => {
    const key = await setupUser();
    const inv = await createProcessedInvoice();
    await addItem(inv, null); // unmatched
    const send = await request(app).post(`/api/invoices/${inv}/send`).set('X-API-Key', key);
    expect(send.status).toBe(200);
    const flag = await request(app).get('/api/integrations/sync-flag').set('X-API-Key', key);
    expect(flag.body.data.nomenclature_sync_requested).toBe(true);
  });

  it('does NOT set the flag when all items are matched', async () => {
    const key = await setupUser();
    const inv = await createProcessedInvoice();
    await addItem(inv, 'guid-1'); // matched
    await request(app).post(`/api/invoices/${inv}/send`).set('X-API-Key', key);
    const flag = await request(app).get('/api/integrations/sync-flag').set('X-API-Key', key);
    expect(flag.body.data.nomenclature_sync_requested).toBe(false);
  });
```

- [ ] **Step 2: Run to verify the new cases fail**

Run: `npx vitest run tests/api/integrations-sync-flag.test.ts`
Expected: the two new cases FAIL (flag stays false / both behave the same).

- [ ] **Step 3: Implement the flag-set in `/send`**

In `src/api/routes/invoices.ts`, confirm the import exists (add if missing):

```ts
import { syncStateRepo } from '../../database/repositories/syncStateRepo';
```

In the `POST /:id/send` handler, right after the `void logIntegrationEvent({ integration: '1c', event_type: 'approved', ... })` call and before `res.json(...)`, add:

```ts
  // If this invoice introduces new (unmatched) nomenclature, flag the catalog
  // for re-export. 1C's scheduled job pulls it back after creating the docs.
  try {
    if (await invoiceRepo.hasUnmatchedItems(id)) {
      await syncStateRepo.markNomenclatureSyncRequested();
      void logIntegrationEvent({
        integration: 'nomenclature', event_type: 'sync_requested', invoice_id: id,
        summary: `Накладная №${invForNotif?.invoice_number ?? id} содержит новые позиции — каталог 1С помечен к выгрузке`,
      });
    }
  } catch (e) {
    logger.warn('Failed to set nomenclature sync flag', { id, error: (e as Error).message });
  }
```

(`logger` and `invoiceRepo` are already imported in this file; `invForNotif` is already in scope from the lines above.)

- [ ] **Step 4: Run to verify all pass**

Run: `npx vitest run tests/api/integrations-sync-flag.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Full typecheck + test sweep**

Run: `npx tsc --noEmit && npx vitest run`
Expected: no type errors; suite green (DB/API tests skipped if no test DB — that's expected).

- [ ] **Step 6: Commit**

```bash
git add src/api/routes/invoices.ts tests/api/integrations-sync-flag.test.ts
git commit -m "feat(invoices): set nomenclature sync flag on /send for unmatched items"
```

---

## Part C — 1C processing (BSL)

> These edit `1c/КНД_ЗагрузкаНакладныхСканер/КНД_ЗагрузкаНакладныхСканер/Ext/ObjectModule.bsl`
> (and the form module / command registration). BSL can't be unit-tested here —
> each task ends with a **manual** verification step the user runs in 1C
> (compile in Конфигуратор → run the command → read the report + `C:\scanflow-debug.log`).
> Commit after each task; the user compiles the `.epf` separately.

### Task C1: Flag helper functions (additive)

**Files:**
- Modify: `1c/…/Ext/ObjectModule.bsl` (add two functions in the "ВЗАИМОДЕЙСТВИЕ С API" section, near `ПодтвердитьЗагрузку`)

- [ ] **Step 1: Add `ПрочитатьФлагВыгрузки` and `СброситьФлагВыгрузки`**

```bsl
// ============================================================================
// ФЛАГ ВЫГРУЗКИ НОМЕНКЛАТУРЫ (sync-flag)
// ============================================================================

// Читает флаг с сайта. Возвращает Структуру {Стоит: Булево, Since: Строка}.
// Все ошибки/недоступность сервера → {Ложь, ""} (не валим основную логику).
Функция ПрочитатьФлагВыгрузки()
	Результат = Новый Структура("Стоит, Since", Ложь, "");

	Соединение = СоздатьHTTPСоединение();
	Если Соединение = Неопределено Тогда
		Возврат Результат;
	КонецЕсли;

	Запрос = Новый HTTPЗапрос("/api/integrations/sync-flag");
	Запрос.Заголовки.Вставить("X-API-Key", КОНСТ_КлючAPI());
	Запрос.Заголовки.Вставить("Accept", "application/json");

	Попытка
		Ответ = Соединение.Получить(Запрос);
	Исключение
		Возврат Результат;
	КонецПопытки;

	Если Ответ.КодСостояния <> 200 Тогда
		Возврат Результат;
	КонецЕсли;

	Попытка
		ЧтениеJSON = Новый ЧтениеJSON;
		ЧтениеJSON.УстановитьСтроку(Ответ.ПолучитьТелоКакСтроку("UTF-8"));
		Данные = ПрочитатьJSON(ЧтениеJSON);
		ЧтениеJSON.Закрыть();

		Если ТипЗнч(Данные) = Тип("Структура") И Данные.Свойство("data") Тогда
			Д = Данные.data;
			Если Д.Свойство("nomenclature_sync_requested") Тогда
				Результат.Стоит = (Д.nomenclature_sync_requested = Истина);
			КонецЕсли;
			Если Д.Свойство("since") И Д.since <> Неопределено И Д.since <> Null Тогда
				Результат.Since = Строка(Д.since);
			КонецЕсли;
		КонецЕсли;
	Исключение
		Возврат Новый Структура("Стоит, Since", Ложь, "");
	КонецПопытки;

	Возврат Результат;
КонецФункции

// Сбрасывает флаг на сайте той же меткой Since (сервер чистит только если
// stored <= since). Возвращает Булево «успешно».
Функция СброситьФлагВыгрузки(Since)
	Соединение = СоздатьHTTPСоединение();
	Если Соединение = Неопределено Тогда
		Возврат Ложь;
	КонецЕсли;

	Тело = Новый Структура("since", Since);
	ЗаписьJSON = Новый ЗаписьJSON;
	ЗаписьJSON.УстановитьСтроку();
	ЗаписатьJSON(ЗаписьJSON, Тело);
	СтрокаТела = ЗаписьJSON.Закрыть();

	Запрос = Новый HTTPЗапрос("/api/integrations/sync-flag/clear");
	Запрос.Заголовки.Вставить("X-API-Key", КОНСТ_КлючAPI());
	Запрос.Заголовки.Вставить("Content-Type", "application/json");
	Запрос.УстановитьТелоИзСтроки(СтрокаТела, "UTF-8");

	Попытка
		Ответ = Соединение.ОтправитьДляОбработки(Запрос);
	Исключение
		Возврат Ложь;
	КонецПопытки;

	Возврат Ответ.КодСостояния = 200;
КонецФункции
```

- [ ] **Step 2: Commit**

```bash
git add "1c/КНД_ЗагрузкаНакладныхСканер/КНД_ЗагрузкаНакладныхСканер/Ext/ObjectModule.bsl"
git commit -m "feat(1c): flag helpers ПрочитатьФлагВыгрузки / СброситьФлагВыгрузки"
```

---

### Task C2: Extract `ЗагрузитьНакладныеИзPending` core; make `ЗагрузитьНакладныеСоСканера` a wrapper

**Files:**
- Modify: `1c/…/Ext/ObjectModule.bsl` (refactor `ЗагрузитьНакладныеСоСканера`, lines ~116–284)

- [ ] **Step 1: Create the load core**

Rename the current `Функция ЗагрузитьНакладныеСоСканера() Экспорт` to `Функция ЗагрузитьНакладныеИзPending()` and:
- Keep its body from the start through the `Отчёт.Добавить("Ошибок: " + Строка(КоличествоОшибок));` line (the "=== Итого ===" block).
- **Delete** the auto-export block that currently follows (the `Если КоличествоСоздано > 0 Тогда … ВыгрузитьНоменклатуруНаСайт() … КонецЕсли;`, lines ~259–280).
- Change every early `Возврат СоздатьОтчётСтроку(Отчёт);` inside it to return the structure instead:

```bsl
		Возврат Новый Структура("Создано, Ошибок, Отчёт", 0, 0, Отчёт);
```

- Change the final return to:

```bsl
	Возврат Новый Структура("Создано, Ошибок, Отчёт", КоличествоСоздано, КоличествоОшибок, Отчёт);
```

(So `ЗагрузитьНакладныеИзPending` returns `{Создано, Ошибок, Отчёт(Массив)}` and never exports.)

- [ ] **Step 2: Add the thin wrapper `ЗагрузитьНакладныеСоСканера`**

Add a new exported function (this preserves the manual button's behavior + clears the flag):

```bsl
// Ручная загрузка (кнопка «Загрузить накладные со сканера»):
// грузит /pending, и если создан хотя бы один документ — выгружает каталог
// обратно (как раньше). Дополнительно гасит флаг выгрузки, если он стоял.
Функция ЗагрузитьНакладныеСоСканера() Экспорт

	ОтладкаЛог("=== НАЧАЛО ЗагрузитьНакладныеСоСканера (ручная) ===");

	// Запоминаем метку флага ДО загрузки (для корректного сброса).
	Флаг = ПрочитатьФлагВыгрузки();

	Рез = ЗагрузитьНакладныеИзPending();
	Отчёт = Рез.Отчёт;

	Если Рез.Создано > 0 Тогда
		Отчёт.Добавить("");
		Отчёт.Добавить("--- Автовыгрузка номенклатуры на сайт ---");
		Попытка
			ОтчётВыгрузки = ВыгрузитьНоменклатуруНаСайт();
			Для Каждого СтрокаОтчёта Из СтрРазделить(ОтчётВыгрузки, Символы.ПС, Ложь) Цикл
				Отчёт.Добавить(СтрокаОтчёта);
			КонецЦикла;
			// Выгрузка прошла — если флаг стоял, гасим его той же меткой.
			Если Флаг.Стоит Тогда
				Если СброситьФлагВыгрузки(Флаг.Since) Тогда
					Отчёт.Добавить("Флаг выгрузки сброшен.");
				КонецЕсли;
			КонецЕсли;
		Исключение
			Отчёт.Добавить("⚠ Автовыгрузка номенклатуры упала: " + ОписаниеОшибки());
			ЗаписатьОшибкуВЖурнал("Автовыгрузка после загрузки: " + ОписаниеОшибки());
		КонецПопытки;
	КонецЕсли;

	Возврат СоздатьОтчётСтроку(Отчёт);

КонецФункции
```

- [ ] **Step 3: Manual verification (user, in 1C)**

Compile in Конфигуратор. Run the existing "Загрузить накладные со сканера" command. Expected: same behavior as before (loads pending, creates docs, auto-exports when ≥1 doc); the report ends cleanly; no "Значение содержит данные недопустимых типов" modal. `Форма.Module.bsl`'s `ЗагрузитьНакладныеНаСервере` still calls `ОбъектОбработка.ЗагрузитьНакладныеСоСканера()` — unchanged signature, returns a String. ✓

- [ ] **Step 4: Commit**

```bash
git add "1c/КНД_ЗагрузкаНакладныхСканер/КНД_ЗагрузкаНакладныхСканер/Ext/ObjectModule.bsl"
git commit -m "refactor(1c): extract ЗагрузитьНакладныеИзPending core + flag-clearing wrapper"
```

---

### Task C3: New scheduled command `АвтосинхронизацияПоФлагу`

**Files:**
- Modify: `1c/…/Ext/ObjectModule.bsl` (command registration + dispatch + the function)

- [ ] **Step 1: Register the command**

In `СведенияОВнешнейОбработке()`, after the existing two `ДобавитьКоманду(...)` calls, add:

```bsl
	ДобавитьКоманду(ТаблицаКоманд,
		"Автосинхронизация (по флагу, для расписания)",
		"КНД_АвтосинхронизацияПоФлагу",
		"ВызовСерверногоМетода");
```

In `ВыполнитьКоманду(ИдентификаторКоманды, ПараметрыВыполненияКоманды)`, add a branch before the `Иначе`:

```bsl
	ИначеЕсли ИдентификаторКоманды = "КНД_АвтосинхронизацияПоФлагу" Тогда
		АвтосинхронизацияПоФлагу();
```

- [ ] **Step 2: Add the function (full cycle)**

```bsl
// ============================================================================
// АВТОСИНХРОНИЗАЦИЯ ПО ФЛАГУ (для регламентного задания, вызов раз в минуту)
// Полный цикл: загрузка /pending → (если флаг стоял) выгрузка → сброс флага.
// ============================================================================
Функция АвтосинхронизацияПоФлагу() Экспорт

	ОтладкаЛог("=== НАЧАЛО АвтосинхронизацияПоФлагу ===");

	Отчёт = Новый Массив;
	Отчёт.Добавить("=== Автосинхронизация (по флагу) ===");

	// Шаг 0: читаем флаг ДО загрузки, запоминаем метку времени.
	Флаг = ПрочитатьФлагВыгрузки();
	Если Флаг.Стоит Тогда
		Отчёт.Добавить("Флаг выгрузки: СТОИТ (" + Флаг.Since + ")");
	Иначе
		Отчёт.Добавить("Флаг выгрузки: не стоит");
	КонецЕсли;

	// Шаг 1: грузим накладные — создаются документы и новая номенклатура.
	Рез = ЗагрузитьНакладныеИзPending();
	Для Каждого С Из Рез.Отчёт Цикл
		Отчёт.Добавить(С);
	КонецЦикла;

	// Шаг 2: выгрузка ТОЛЬКО если флаг стоял (новые товары были отправлены).
	Если Флаг.Стоит Тогда
		Отчёт.Добавить("");
		Отчёт.Добавить("--- Выгрузка номенклатуры (флаг стоял) ---");
		Попытка
			ОтчётВыгрузки = ВыгрузитьНоменклатуруНаСайт();
			Для Каждого С Из СтрРазделить(ОтчётВыгрузки, Символы.ПС, Ложь) Цикл
				Отчёт.Добавить(С);
			КонецЦикла;
			// Шаг 3: сбрасываем флаг той же меткой (сервер: гард stored <= since).
			Если СброситьФлагВыгрузки(Флаг.Since) Тогда
				Отчёт.Добавить("Флаг выгрузки сброшен.");
			Иначе
				Отчёт.Добавить("Флаг НЕ сброшен (появились новые данные или ошибка) — повтор на следующем запуске.");
			КонецЕсли;
		Исключение
			Отчёт.Добавить("⚠ Выгрузка упала: " + ОписаниеОшибки() + " — флаг НЕ сброшен, повтор позже.");
			ЗаписатьОшибкуВЖурнал("Автосинхронизация: выгрузка упала: " + ОписаниеОшибки());
		КонецПопытки;
	Иначе
		Отчёт.Добавить("Новых позиций не было — выгрузка номенклатуры пропущена.");
	КонецЕсли;

	Возврат СоздатьОтчётСтроку(Отчёт);

КонецФункции
```

- [ ] **Step 3: Manual verification (user, in 1C)**

1. Compile the `.epf` in Конфигуратор.
2. On the site: scan/approve an invoice that has at least one unmatched item → `GET /api/integrations/sync-flag` returns `requested: true`.
3. Run the new "Автосинхронизация (по флагу, для расписания)" command once. Expected report: loads the invoice (creates doc + new Номенклатура with the **cleaned** name), then "флаг стоял" → exports nomenclature → "Флаг выгрузки сброшен."
4. `GET /api/integrations/sync-flag` now returns `requested: false`.
5. Run the command again with no new approvals → report says "Новых позиций не было — выгрузка пропущена" and does NOT export.
6. Schedule it: create a 1C регламентное/фоновое задание that calls this command every minute.

- [ ] **Step 4: Commit**

```bash
git add "1c/КНД_ЗагрузкаНакладныхСканер/КНД_ЗагрузкаНакладныхСканер/Ext/ObjectModule.bsl"
git commit -m "feat(1c): scheduled АвтосинхронизацияПоФлагу — load → flag-gated export → clear"
```

---

## Final verification

- [ ] **Full sweep:** `npx tsc --noEmit && npx vitest run` — no type errors; all non-DB suites green; DB/API suites pass if a test DB is configured (`DB_HOST=127.0.0.1`, `DB_NAME=...test...`, `DB_PASSWORD=...`), else skipped.
- [ ] **Manual end-to-end (optional, with prod-like 1C):** approve an unmatched-item invoice → run the scheduled command → confirm 1C creates a tidy Номенклатура and the site catalog gains it with a GUID, and the flag is cleared.

---

## Optional (only if the user asks) — Part D: UI banner indicator

Show a yellow chip "N позиций ждут выгрузки в 1С" on the 1C status banner when `GET /api/integrations/sync-flag` returns `requested: true`. Purely informational; no task written here until requested.

---

## Self-review notes

- **Spec coverage:** Part A (A1–A3) ↔ spec A; Part B (B1–B5) ↔ spec B; Part C (C1–C3) ↔ spec C; Part D ↔ spec D (deferred). All spec sections mapped.
- **Type consistency:** `cleanItemName` (A1) used in A2/A3; `syncStateRepo.{markNomenclatureSyncRequested,getNomenclatureSyncState,clearNomenclatureSync}` defined in B2, used in B4/B5; `invoiceRepo.hasUnmatchedItems` defined B3, used B5; BSL `ЗагрузитьНакладныеИзPending`/`ПрочитатьФлагВыгрузки`/`СброситьФлагВыгрузки` defined C1/C2, used C2/C3. Names consistent across tasks.
- **No placeholders:** every code step contains complete code; commands have expected output.
