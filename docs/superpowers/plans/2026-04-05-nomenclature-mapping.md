# Nomenclature Mapping (1С GUID-based) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Link dashboard nomenclature mappings to the real 1С catalog via stable GUIDs, so invoice imports resolve the correct `Справочник.Номенклатура` item without name-typing, with a per-supplier view for bulk review and a learning loop.

**Architecture:** Three new DB tables (`onec_nomenclature`, plus columns on existing `nomenclature_mappings` and `invoice_items`, plus `mapping_supplier_usage` m2m stats). Backend exposes sync + lookup endpoints. `NomenclatureMapper` gets a GUID-first path with Fuse.js fallback against the 1C catalog mirror. Dashboard gains an autocomplete dropdown per invoice line and a supplier-grouped view on the Nomenclature tab. 1C external processing gets a new command to export the full catalog and switches to `ПолучитьСсылку(UUID)` on invoice import.

**Tech Stack:** Node.js + TypeScript, better-sqlite3, Express, Fuse.js, vanilla JS dashboard, 1С:УНФ 1.6 (BSL).

**Spec:** `docs/superpowers/specs/2026-04-05-nomenclature-mapping-design.md`

---

## File Structure

**Create:**
- `src/database/repositories/onecNomenclatureRepo.ts` — mirror of 1C catalog (upsert + lookup)
- `src/database/repositories/mappingSupplierUsageRepo.ts` — supplier usage m2m stats
- `src/api/routes/nomenclature.ts` — `/api/nomenclature/*` endpoints (sync, list, stats, suppliers)
- `src/scripts/test-onec-nomenclature.ts` — repo tests
- `src/scripts/test-nomenclature-mapper.ts` — mapper learning + GUID tests
- `src/scripts/test-nomenclature-sync-api.ts` — integration test for sync endpoint
- `public/js/onecCatalog.js` — shared client cache + autocomplete helper for dashboard

**Modify:**
- `src/database/migrations.ts` — migrations v6, v7, v8
- `src/database/repositories/invoiceRepo.ts` — surface `onec_guid` in InvoiceItem, accept in addItem, add per-item map update
- `src/database/repositories/mappingRepo.ts` — add `onec_guid`, stats fields, supplier-scoped queries, GUID-aware upsert
- `src/mapping/nomenclatureMapper.ts` — GUID-first learned lookup → fuzzy over `onec_nomenclature`
- `src/api/server.ts` — mount new `/api/nomenclature` router
- `src/api/routes/mappings.ts` — accept `supplier` and `unmapped` query filters, accept `onec_guid` on POST/PUT
- `src/api/routes/invoices.ts` — new `PUT /api/invoices/:invoiceId/items/:itemId/map` route
- `src/watcher/fileWatcher.ts` — pass supplier into mapper, record usage on each item
- `public/index.html` — supplier view markup, script tag for `onecCatalog.js`
- `public/js/invoices.js` — replace read-only "Название (1С)" column with autocomplete, disable "Отправить в 1С" until all items mapped
- `public/js/mappings.js` — mode toggle + supplier sidebar + unmapped filter
- `public/css/style.css` — styles for autocomplete + supplier sidebar
- `1c/КНД_ЗагрузкаНакладныхСканер/КНД_ЗагрузкаНакладныхСканер/Ext/ObjectModule.bsl` — new sync command + GUID-first import in existing command

**Test:**
- `src/scripts/test-onec-nomenclature.ts`
- `src/scripts/test-nomenclature-mapper.ts`
- `src/scripts/test-nomenclature-sync-api.ts`

---

## Task 1: Database migration v6 — `onec_nomenclature` table

**Files:**
- Modify: `src/database/migrations.ts`

- [ ] **Step 1: Add migration v6 block at the end of `runMigrations` (before the final `logger.info('Database migrations completed')` line)**

Open `src/database/migrations.ts` and, immediately before the last `logger.info('Database migrations completed');`, add:

```typescript
  // === Migration v6: onec_nomenclature (1C catalog mirror) ===
  // Local copy of Справочник.Номенклатура from 1С. Primary key is the GUID
  // from the 1C reference (Ссылка.УникальныйИдентификатор). All mapping
  // decisions in the dashboard eventually resolve to one of these rows.
  const hasOnecNomenclature = db.prepare(
    "SELECT COUNT(*) as cnt FROM sqlite_master WHERE type = 'table' AND name = 'onec_nomenclature'"
  ).get() as { cnt: number };

  if (hasOnecNomenclature.cnt === 0) {
    logger.info('Migration v6: Creating onec_nomenclature table...');
    db.exec(`
      CREATE TABLE onec_nomenclature (
        guid        TEXT PRIMARY KEY,
        code        TEXT,
        name        TEXT NOT NULL,
        full_name   TEXT,
        unit        TEXT,
        parent_guid TEXT,
        is_folder   INTEGER NOT NULL DEFAULT 0,
        is_weighted INTEGER NOT NULL DEFAULT 0,
        synced_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_onec_nomenclature_name ON onec_nomenclature(name COLLATE NOCASE);
      CREATE INDEX idx_onec_nomenclature_parent ON onec_nomenclature(parent_guid);
    `);
  }
```

- [ ] **Step 2: Run TypeScript check**

```bash
cd c:/www/1C-JPGExchange && npx tsc --noEmit
```

Expected: exit code 0, no output.

- [ ] **Step 3: Start server once to apply the migration**

```bash
cd c:/www/1C-JPGExchange && timeout 8 npx ts-node src/index.ts 2>&1 | head -40
```

Expected output contains `Migration v6: Creating onec_nomenclature table...` and `Database migrations completed`.

- [ ] **Step 4: Verify the table exists via sqlite3**

```bash
cd c:/www/1C-JPGExchange && npx ts-node -e "
import { getDb, initDb } from './src/database/db';
initDb();
const db = getDb();
const cols = db.prepare(\"PRAGMA table_info('onec_nomenclature')\").all();
console.log(JSON.stringify(cols, null, 2));
"
```

Expected: JSON array with 9 columns (`guid`, `code`, `name`, `full_name`, `unit`, `parent_guid`, `is_folder`, `is_weighted`, `synced_at`).

- [ ] **Step 5: Commit**

```bash
git add src/database/migrations.ts
git commit -m "Migration v6: add onec_nomenclature table (1C catalog mirror)"
```

---

## Task 2: Database migration v7 — extend `nomenclature_mappings` and `invoice_items`

**Files:**
- Modify: `src/database/migrations.ts`

- [ ] **Step 1: Add migration v7 block right after the v6 block**

Append after v6:

```typescript
  // === Migration v7: Extend mappings and invoice_items with onec_guid ===
  const hasMappingOnecGuid = db.prepare(
    "SELECT COUNT(*) as cnt FROM pragma_table_info('nomenclature_mappings') WHERE name = 'onec_guid'"
  ).get() as { cnt: number };

  if (hasMappingOnecGuid.cnt === 0) {
    logger.info('Migration v7: Extending nomenclature_mappings and invoice_items...');
    db.exec(`
      ALTER TABLE nomenclature_mappings ADD COLUMN onec_guid TEXT;
      ALTER TABLE nomenclature_mappings ADD COLUMN times_seen INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE nomenclature_mappings ADD COLUMN last_seen_supplier TEXT;
      ALTER TABLE nomenclature_mappings ADD COLUMN last_seen_at TEXT;

      ALTER TABLE invoice_items ADD COLUMN onec_guid TEXT;

      CREATE INDEX IF NOT EXISTS idx_nomenclature_mappings_onec_guid
        ON nomenclature_mappings(onec_guid);
    `);
  }
```

- [ ] **Step 2: Run TypeScript check**

```bash
cd c:/www/1C-JPGExchange && npx tsc --noEmit
```

Expected: exit code 0.

- [ ] **Step 3: Apply the migration**

```bash
cd c:/www/1C-JPGExchange && timeout 8 npx ts-node src/index.ts 2>&1 | grep -E "Migration v7|completed"
```

Expected: `Migration v7: Extending nomenclature_mappings and invoice_items...` and `Database migrations completed`.

- [ ] **Step 4: Verify columns**

```bash
cd c:/www/1C-JPGExchange && npx ts-node -e "
import { getDb, initDb } from './src/database/db';
initDb();
const db = getDb();
const m = db.prepare(\"PRAGMA table_info('nomenclature_mappings')\").all() as Array<{ name: string }>;
const i = db.prepare(\"PRAGMA table_info('invoice_items')\").all() as Array<{ name: string }>;
console.log('mapping cols:', m.map(c => c.name).join(','));
console.log('invoice_items cols:', i.map(c => c.name).join(','));
"
```

Expected output contains `onec_guid`, `times_seen`, `last_seen_supplier`, `last_seen_at` in mapping cols, and `onec_guid` in invoice_items cols.

- [ ] **Step 5: Commit**

```bash
git add src/database/migrations.ts
git commit -m "Migration v7: add onec_guid + usage stats to mappings and invoice_items"
```

---

## Task 3: Database migration v8 — `mapping_supplier_usage`

**Files:**
- Modify: `src/database/migrations.ts`

- [ ] **Step 1: Add migration v8 block right after v7**

```typescript
  // === Migration v8: mapping_supplier_usage (per-supplier stats m2m) ===
  const hasSupplierUsage = db.prepare(
    "SELECT COUNT(*) as cnt FROM sqlite_master WHERE type = 'table' AND name = 'mapping_supplier_usage'"
  ).get() as { cnt: number };

  if (hasSupplierUsage.cnt === 0) {
    logger.info('Migration v8: Creating mapping_supplier_usage table...');
    db.exec(`
      CREATE TABLE mapping_supplier_usage (
        mapping_id    INTEGER NOT NULL,
        supplier      TEXT NOT NULL,
        first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
        times_seen    INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (mapping_id, supplier),
        FOREIGN KEY (mapping_id) REFERENCES nomenclature_mappings(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_mapping_supplier_usage_supplier ON mapping_supplier_usage(supplier);
    `);
  }
```

- [ ] **Step 2: TypeScript check**

```bash
cd c:/www/1C-JPGExchange && npx tsc --noEmit
```

Expected: exit code 0.

- [ ] **Step 3: Apply + verify**

```bash
cd c:/www/1C-JPGExchange && timeout 8 npx ts-node src/index.ts 2>&1 | grep -E "Migration v8|completed"
```

Expected: `Migration v8: Creating mapping_supplier_usage table...` and `Database migrations completed`.

- [ ] **Step 4: Commit**

```bash
git add src/database/migrations.ts
git commit -m "Migration v8: add mapping_supplier_usage table"
```

---

## Task 4: `onecNomenclatureRepo` — CRUD + bulk upsert

**Files:**
- Create: `src/database/repositories/onecNomenclatureRepo.ts`
- Create: `src/scripts/test-onec-nomenclature.ts`

- [ ] **Step 1: Write the failing test first**

Create `src/scripts/test-onec-nomenclature.ts`:

```typescript
/**
 * Tests for onecNomenclatureRepo.
 * Usage: npx ts-node src/scripts/test-onec-nomenclature.ts
 */
import '../config';
import { onecNomenclatureRepo } from '../database/repositories/onecNomenclatureRepo';
import { getDb } from '../database/db';

let passCount = 0;
let failCount = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passCount++;
  } else {
    console.log(`  ❌ FAIL: ${message}`);
    failCount++;
  }
}

async function main(): Promise<void> {
  console.log('onecNomenclatureRepo tests');
  console.log('==========================');

  // Clean slate for deterministic tests
  const db = getDb();
  db.prepare("DELETE FROM onec_nomenclature WHERE guid LIKE 'test-%'").run();

  console.log('\n=== bulkUpsert inserts new rows ===');
  const inserted = onecNomenclatureRepo.bulkUpsert([
    { guid: 'test-1', code: 'НФ-001', name: 'Картофель сырой', unit: 'кг', is_folder: false, is_weighted: true },
    { guid: 'test-2', code: 'НФ-002', name: 'Морковь свежая', unit: 'кг', is_folder: false, is_weighted: true },
    { guid: 'test-grp', code: null, name: 'Овощи', unit: null, is_folder: true, is_weighted: false },
  ]);
  assert(inserted === 3, `bulkUpsert returned 3, got ${inserted}`);

  console.log('\n=== getByGuid finds inserted row ===');
  const row = onecNomenclatureRepo.getByGuid('test-1');
  assert(row !== undefined, 'row is defined');
  assert(row?.name === 'Картофель сырой', `name matches, got ${row?.name}`);
  assert(row?.is_weighted === 1, `is_weighted stored as 1 (sqlite int), got ${row?.is_weighted}`);

  console.log('\n=== bulkUpsert updates existing rows ===');
  onecNomenclatureRepo.bulkUpsert([
    { guid: 'test-1', code: 'НФ-001', name: 'Картофель новый', unit: 'кг', is_folder: false, is_weighted: true },
  ]);
  const updated = onecNomenclatureRepo.getByGuid('test-1');
  assert(updated?.name === 'Картофель новый', 'name updated');

  console.log('\n=== listItems excludes folders by default ===');
  const items = onecNomenclatureRepo.listItems({ excludeFolders: true });
  const testItems = items.filter(i => i.guid.startsWith('test-'));
  assert(testItems.length === 2, `got 2 items (folder excluded), got ${testItems.length}`);

  console.log('\n=== stats returns counts ===');
  const stats = onecNomenclatureRepo.stats();
  assert(typeof stats.total === 'number' && stats.total >= 3, 'total ≥ 3');
  assert(typeof stats.folders === 'number', 'folders is number');
  assert(typeof stats.items === 'number', 'items is number');

  // Cleanup
  db.prepare("DELETE FROM onec_nomenclature WHERE guid LIKE 'test-%'").run();

  console.log(`\n==========================`);
  console.log(`Results: ${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails (repo not created yet)**

```bash
cd c:/www/1C-JPGExchange && npx ts-node src/scripts/test-onec-nomenclature.ts 2>&1 | head -10
```

Expected: TypeScript error — `Cannot find module '../database/repositories/onecNomenclatureRepo'`.

- [ ] **Step 3: Implement the repo**

Create `src/database/repositories/onecNomenclatureRepo.ts`:

```typescript
import { getDb } from '../db';

export interface OnecNomenclatureRow {
  guid: string;
  code: string | null;
  name: string;
  full_name: string | null;
  unit: string | null;
  parent_guid: string | null;
  is_folder: number; // sqlite stores bools as 0/1
  is_weighted: number;
  synced_at: string;
}

export interface OnecNomenclatureInput {
  guid: string;
  code?: string | null;
  name: string;
  full_name?: string | null;
  unit?: string | null;
  parent_guid?: string | null;
  is_folder?: boolean;
  is_weighted?: boolean;
}

export const onecNomenclatureRepo = {
  /**
   * Upsert a batch of items. Existing rows are updated by guid; new rows inserted.
   * Wrapped in a transaction for atomicity. Returns the count of rows processed.
   */
  bulkUpsert(items: OnecNomenclatureInput[]): number {
    if (items.length === 0) return 0;
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO onec_nomenclature
        (guid, code, name, full_name, unit, parent_guid, is_folder, is_weighted, synced_at)
      VALUES
        (@guid, @code, @name, @full_name, @unit, @parent_guid, @is_folder, @is_weighted, datetime('now'))
      ON CONFLICT(guid) DO UPDATE SET
        code        = excluded.code,
        name        = excluded.name,
        full_name   = excluded.full_name,
        unit        = excluded.unit,
        parent_guid = excluded.parent_guid,
        is_folder   = excluded.is_folder,
        is_weighted = excluded.is_weighted,
        synced_at   = excluded.synced_at
    `);
    const tx = db.transaction((rows: OnecNomenclatureInput[]) => {
      let count = 0;
      for (const item of rows) {
        stmt.run({
          guid: item.guid,
          code: item.code ?? null,
          name: item.name,
          full_name: item.full_name ?? null,
          unit: item.unit ?? null,
          parent_guid: item.parent_guid ?? null,
          is_folder: item.is_folder ? 1 : 0,
          is_weighted: item.is_weighted ? 1 : 0,
        });
        count++;
      }
      return count;
    });
    return tx(items);
  },

  getByGuid(guid: string): OnecNomenclatureRow | undefined {
    const db = getDb();
    return db.prepare('SELECT * FROM onec_nomenclature WHERE guid = ?')
      .get(guid) as OnecNomenclatureRow | undefined;
  },

  listItems(opts: { excludeFolders?: boolean; search?: string; limit?: number } = {}): OnecNomenclatureRow[] {
    const db = getDb();
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (opts.excludeFolders) {
      clauses.push('is_folder = 0');
    }
    if (opts.search) {
      clauses.push('(name LIKE @search OR full_name LIKE @search)');
      params.search = `%${opts.search}%`;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = opts.limit ? `LIMIT ${opts.limit}` : '';
    return db.prepare(
      `SELECT * FROM onec_nomenclature ${where} ORDER BY name COLLATE NOCASE ${limit}`
    ).all(params) as OnecNomenclatureRow[];
  },

  stats(): { total: number; folders: number; items: number; last_synced_at: string | null } {
    const db = getDb();
    const total = (db.prepare('SELECT COUNT(*) as c FROM onec_nomenclature').get() as { c: number }).c;
    const folders = (db.prepare('SELECT COUNT(*) as c FROM onec_nomenclature WHERE is_folder = 1').get() as { c: number }).c;
    const items = total - folders;
    const lastRow = db.prepare('SELECT MAX(synced_at) as ts FROM onec_nomenclature').get() as { ts: string | null };
    return { total, folders, items, last_synced_at: lastRow.ts };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd c:/www/1C-JPGExchange && npx ts-node src/scripts/test-onec-nomenclature.ts
```

Expected: all assertions pass, `Results: N passed, 0 failed`.

- [ ] **Step 5: Add npm script**

In `package.json`, inside `scripts`, add a new entry after `test:invoice-number`:

```json
"test:onec-nomenclature": "ts-node src/scripts/test-onec-nomenclature.ts",
```

- [ ] **Step 6: Commit**

```bash
git add src/database/repositories/onecNomenclatureRepo.ts src/scripts/test-onec-nomenclature.ts package.json
git commit -m "Add onecNomenclatureRepo with bulk upsert, get, list, stats + tests"
```

---

## Task 5: Extend `mappingRepo` with `onec_guid` + supplier stats

**Files:**
- Modify: `src/database/repositories/mappingRepo.ts`

- [ ] **Step 1: Extend the `NomenclatureMapping` interface**

In `src/database/repositories/mappingRepo.ts`, replace the `NomenclatureMapping` interface with:

```typescript
export interface NomenclatureMapping {
  id: number;
  scanned_name: string;
  mapped_name_1c: string;
  category: string | null;
  default_unit: string | null;
  approved: number;
  created_at: string;
  onec_guid: string | null;
  times_seen: number;
  last_seen_supplier: string | null;
  last_seen_at: string | null;
}
```

And extend `CreateMappingData`:

```typescript
export interface CreateMappingData {
  scanned_name: string;
  mapped_name_1c: string;
  category?: string;
  default_unit?: string;
  approved?: boolean;
  onec_guid?: string | null;
}
```

- [ ] **Step 2: Extend `create()` and `update()` to handle `onec_guid`**

In the same file, replace the `create()` and `update()` methods:

```typescript
  create(data: CreateMappingData): NomenclatureMapping {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO nomenclature_mappings (scanned_name, mapped_name_1c, category, default_unit, approved, onec_guid)
      VALUES (@scanned_name, @mapped_name_1c, @category, @default_unit, @approved, @onec_guid)
    `);
    const result = stmt.run({
      scanned_name: data.scanned_name,
      mapped_name_1c: data.mapped_name_1c,
      category: data.category ?? null,
      default_unit: data.default_unit ?? null,
      approved: data.approved ? 1 : 0,
      onec_guid: data.onec_guid ?? null,
    });
    return db.prepare('SELECT * FROM nomenclature_mappings WHERE id = ?')
      .get(Number(result.lastInsertRowid)) as NomenclatureMapping;
  },
```

And the update:

```typescript
  update(id: number, data: Partial<CreateMappingData>): void {
    const db = getDb();
    const fields: string[] = [];
    const values: Record<string, unknown> = { id };

    if (data.scanned_name !== undefined) { fields.push('scanned_name = @scanned_name'); values.scanned_name = data.scanned_name; }
    if (data.mapped_name_1c !== undefined) { fields.push('mapped_name_1c = @mapped_name_1c'); values.mapped_name_1c = data.mapped_name_1c; }
    if (data.category !== undefined) { fields.push('category = @category'); values.category = data.category; }
    if (data.default_unit !== undefined) { fields.push('default_unit = @default_unit'); values.default_unit = data.default_unit; }
    if (data.approved !== undefined) { fields.push('approved = @approved'); values.approved = data.approved ? 1 : 0; }
    if (data.onec_guid !== undefined) { fields.push('onec_guid = @onec_guid'); values.onec_guid = data.onec_guid; }

    if (fields.length > 0) {
      db.prepare(`UPDATE nomenclature_mappings SET ${fields.join(', ')} WHERE id = @id`).run(values);
    }
  },
```

- [ ] **Step 3: Add `recordUsage` method that bumps stats and m2m**

Add this method after `upsert`:

```typescript
  /**
   * Record that this mapping was used for an invoice from `supplier`.
   * Increments the mapping's times_seen, updates last_seen_supplier/at,
   * and upserts a row in mapping_supplier_usage.
   *
   * Called on every successful NomenclatureMapper.map() during invoice
   * processing, and on every explicit user mapping via the dashboard.
   */
  recordUsage(mappingId: number, supplier: string | null | undefined): void {
    const db = getDb();
    db.prepare(`
      UPDATE nomenclature_mappings
      SET times_seen = times_seen + 1,
          last_seen_supplier = COALESCE(?, last_seen_supplier),
          last_seen_at = datetime('now')
      WHERE id = ?
    `).run(supplier ?? null, mappingId);

    if (supplier) {
      db.prepare(`
        INSERT INTO mapping_supplier_usage (mapping_id, supplier, first_seen_at, last_seen_at, times_seen)
        VALUES (?, ?, datetime('now'), datetime('now'), 1)
        ON CONFLICT(mapping_id, supplier) DO UPDATE SET
          last_seen_at = datetime('now'),
          times_seen = times_seen + 1
      `).run(mappingId, supplier);
    }
  },
```

- [ ] **Step 4: Add `getAllFiltered` for supplier and unmapped filters**

Add this method before the closing `}` of the repo:

```typescript
  /**
   * List mappings with optional filters:
   *   - supplier: only mappings linked to this supplier in mapping_supplier_usage
   *   - unmapped: only mappings where onec_guid IS NULL
   * Sorted by last_seen_at DESC (most-recently-seen first), falling back to mapped_name_1c.
   */
  getAllFiltered(opts: { supplier?: string; unmapped?: boolean } = {}): NomenclatureMapping[] {
    const db = getDb();
    const clauses: string[] = [];
    const params: unknown[] = [];
    let join = '';

    if (opts.supplier) {
      join = 'JOIN mapping_supplier_usage u ON u.mapping_id = m.id';
      clauses.push('u.supplier = ?');
      params.push(opts.supplier);
    }
    if (opts.unmapped) {
      clauses.push('(m.onec_guid IS NULL OR m.onec_guid = "")');
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    return db.prepare(
      `SELECT m.* FROM nomenclature_mappings m ${join} ${where}
       ORDER BY COALESCE(m.last_seen_at, '') DESC, m.mapped_name_1c COLLATE NOCASE`
    ).all(...params) as NomenclatureMapping[];
  },

  getSupplierList(): Array<{ supplier: string; mappings_count: number }> {
    const db = getDb();
    return db.prepare(`
      SELECT supplier, COUNT(DISTINCT mapping_id) as mappings_count
      FROM mapping_supplier_usage
      GROUP BY supplier
      ORDER BY mappings_count DESC, supplier
    `).all() as Array<{ supplier: string; mappings_count: number }>;
  },

  getUnmappedCount(): number {
    const db = getDb();
    const row = db.prepare(
      `SELECT COUNT(*) as c FROM nomenclature_mappings WHERE onec_guid IS NULL OR onec_guid = ''`
    ).get() as { c: number };
    return row.c;
  },
```

- [ ] **Step 5: Run TypeScript check**

```bash
cd c:/www/1C-JPGExchange && npx tsc --noEmit
```

Expected: exit code 0.

- [ ] **Step 6: Commit**

```bash
git add src/database/repositories/mappingRepo.ts
git commit -m "Extend mappingRepo: onec_guid, recordUsage, supplier-scoped queries"
```

---

## Task 6: Extend `invoiceRepo` with `onec_guid` on items + per-item map

**Files:**
- Modify: `src/database/repositories/invoiceRepo.ts`

- [ ] **Step 1: Extend `InvoiceItem` interface and `CreateInvoiceItemData`**

In `src/database/repositories/invoiceRepo.ts`, replace the `InvoiceItem` interface:

```typescript
export interface InvoiceItem {
  id: number;
  invoice_id: number;
  original_name: string;
  mapped_name: string | null;
  quantity: number | null;
  unit: string | null;
  price: number | null;
  total: number | null;
  vat_rate: number | null;
  mapping_confidence: number;
  onec_guid: string | null;
}
```

Extend `CreateInvoiceItemData`:

```typescript
export interface CreateInvoiceItemData {
  invoice_id: number;
  original_name: string;
  mapped_name?: string;
  quantity?: number;
  unit?: string;
  price?: number;
  total?: number;
  vat_rate?: number;
  mapping_confidence?: number;
  onec_guid?: string | null;
}
```

- [ ] **Step 2: Update `addItem()` to persist `onec_guid`**

Find the existing `addItem` method and replace with:

```typescript
  addItem(data: CreateInvoiceItemData): InvoiceItem {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO invoice_items (invoice_id, original_name, mapped_name, quantity, unit, price, total, vat_rate, mapping_confidence, onec_guid)
      VALUES (@invoice_id, @original_name, @mapped_name, @quantity, @unit, @price, @total, @vat_rate, @mapping_confidence, @onec_guid)
    `);
    const result = stmt.run({
      invoice_id: data.invoice_id,
      original_name: data.original_name,
      mapped_name: data.mapped_name ?? null,
      quantity: data.quantity ?? null,
      unit: data.unit ?? null,
      price: data.price ?? null,
      total: data.total ?? null,
      vat_rate: data.vat_rate ?? null,
      mapping_confidence: data.mapping_confidence ?? 0,
      onec_guid: data.onec_guid ?? null,
    });
    return db.prepare('SELECT * FROM invoice_items WHERE id = ?').get(Number(result.lastInsertRowid)) as InvoiceItem;
  },
```

- [ ] **Step 3: Add `mapItem` method (used by new PUT endpoint)**

Append this method to the `invoiceRepo` object (before the closing `}`):

```typescript
  /**
   * Set or clear the 1C GUID link for a single invoice line item. Also
   * updates the cached mapped_name for display. Caller is responsible for
   * updating nomenclature_mappings and mapping_supplier_usage.
   */
  mapItem(itemId: number, onecGuid: string | null, mappedName: string | null): InvoiceItem | undefined {
    const db = getDb();
    db.prepare(
      `UPDATE invoice_items SET onec_guid = ?, mapped_name = COALESCE(?, mapped_name) WHERE id = ?`
    ).run(onecGuid, mappedName, itemId);
    return db.prepare('SELECT * FROM invoice_items WHERE id = ?').get(itemId) as InvoiceItem | undefined;
  },

  getItemById(id: number): InvoiceItem | undefined {
    const db = getDb();
    return db.prepare('SELECT * FROM invoice_items WHERE id = ?').get(id) as InvoiceItem | undefined;
  },
```

- [ ] **Step 4: TypeScript check**

```bash
cd c:/www/1C-JPGExchange && npx tsc --noEmit
```

Expected: exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/database/repositories/invoiceRepo.ts
git commit -m "Extend invoiceRepo: onec_guid on items, mapItem, getItemById"
```

---

## Task 7: Rewrite `NomenclatureMapper` to use onec_nomenclature + GUID-first

**Files:**
- Modify: `src/mapping/nomenclatureMapper.ts`
- Create: `src/scripts/test-nomenclature-mapper.ts`

- [ ] **Step 1: Write the failing test first**

Create `src/scripts/test-nomenclature-mapper.ts`:

```typescript
/**
 * Tests for NomenclatureMapper with GUID-first learned lookup + fuzzy onec_nomenclature.
 * Usage: npx ts-node src/scripts/test-nomenclature-mapper.ts
 */
import '../config';
import { NomenclatureMapper } from '../mapping/nomenclatureMapper';
import { onecNomenclatureRepo } from '../database/repositories/onecNomenclatureRepo';
import { mappingRepo } from '../database/repositories/mappingRepo';
import { getDb } from '../database/db';

let passCount = 0;
let failCount = 0;
function assert(condition: boolean, message: string): void {
  if (condition) { console.log(`  ✅ ${message}`); passCount++; }
  else { console.log(`  ❌ FAIL: ${message}`); failCount++; }
}

async function main(): Promise<void> {
  console.log('NomenclatureMapper tests');
  console.log('========================');

  // Clean slate
  const db = getDb();
  db.prepare("DELETE FROM nomenclature_mappings WHERE scanned_name LIKE 'testmap:%'").run();
  db.prepare("DELETE FROM onec_nomenclature WHERE guid LIKE 'test-map-%'").run();

  // Seed onec_nomenclature
  onecNomenclatureRepo.bulkUpsert([
    { guid: 'test-map-1', code: 'НФ-001', name: 'Картофель сырой', unit: 'кг', is_folder: false, is_weighted: true },
    { guid: 'test-map-2', code: 'НФ-002', name: 'Морковь свежая', unit: 'кг', is_folder: false, is_weighted: true },
    { guid: 'test-map-3', code: 'НФ-003', name: 'Молоко 3.2% 1л', unit: 'шт', is_folder: false, is_weighted: false },
  ]);

  const mapper = new NomenclatureMapper();

  console.log('\n=== Case 1: no mapping, fuzzy hit against onec_nomenclature ===');
  const r1 = mapper.map('Картофель');
  assert(r1.source === 'onec_fuzzy', `source=onec_fuzzy, got ${r1.source}`);
  assert(r1.onec_guid === 'test-map-1', `onec_guid test-map-1, got ${r1.onec_guid}`);
  assert(r1.mapped_name === 'Картофель сырой', `mapped_name=Картофель сырой, got ${r1.mapped_name}`);
  assert(r1.confidence >= 0.5, `confidence ≥ 0.5, got ${r1.confidence}`);

  console.log('\n=== Case 2: learned mapping (exact scan name) wins over fuzzy ===');
  const created = mappingRepo.create({
    scanned_name: 'testmap:моло',
    mapped_name_1c: 'Молоко 3.2% 1л',
    onec_guid: 'test-map-3',
  });
  mapper.invalidateCache();
  const r2 = mapper.map('testmap:моло');
  assert(r2.source === 'learned', `source=learned, got ${r2.source}`);
  assert(r2.onec_guid === 'test-map-3', `onec_guid test-map-3, got ${r2.onec_guid}`);
  assert(r2.confidence === 1.0, `confidence=1.0, got ${r2.confidence}`);

  console.log('\n=== Case 3: nothing matches → source = none, onec_guid = null ===');
  const r3 = mapper.map('xyzunknown12345');
  assert(r3.source === 'none', `source=none, got ${r3.source}`);
  assert(r3.onec_guid === null, `onec_guid null, got ${r3.onec_guid}`);
  assert(r3.confidence === 0, `confidence=0, got ${r3.confidence}`);

  console.log('\n=== Case 4: learned mapping without onec_guid is still returned (legacy) ===');
  db.prepare(`INSERT INTO nomenclature_mappings (scanned_name, mapped_name_1c) VALUES (?, ?)`)
    .run('testmap:legacy', 'Legacy Item Name');
  mapper.invalidateCache();
  const r4 = mapper.map('testmap:legacy');
  assert(r4.source === 'learned' || r4.source === 'exact', `source=learned|exact, got ${r4.source}`);
  assert(r4.onec_guid === null, `onec_guid null for legacy, got ${r4.onec_guid}`);
  assert(r4.mapped_name === 'Legacy Item Name', `mapped_name=Legacy Item Name, got ${r4.mapped_name}`);

  // Cleanup
  mappingRepo.delete(created.id);
  db.prepare("DELETE FROM nomenclature_mappings WHERE scanned_name LIKE 'testmap:%'").run();
  db.prepare("DELETE FROM onec_nomenclature WHERE guid LIKE 'test-map-%'").run();

  console.log(`\n========================`);
  console.log(`Results: ${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd c:/www/1C-JPGExchange && npx ts-node src/scripts/test-nomenclature-mapper.ts
```

Expected: fails because the mapper doesn't return `onec_guid` or the new `source` values yet.

- [ ] **Step 3: Rewrite `NomenclatureMapper`**

Replace the entire contents of `src/mapping/nomenclatureMapper.ts` with:

```typescript
import Fuse, { IFuseOptions } from 'fuse.js';
import { mappingRepo, NomenclatureMapping } from '../database/repositories/mappingRepo';
import { onecNomenclatureRepo, OnecNomenclatureRow } from '../database/repositories/onecNomenclatureRepo';
import { logger } from '../utils/logger';

export interface MappingResult {
  original_name: string;
  mapped_name: string;
  onec_guid: string | null;
  confidence: number;
  source: 'learned' | 'onec_fuzzy' | 'legacy' | 'none';
  mapping_id: number | null; // id of nomenclature_mappings row if matched
}

const ONEC_FUSE_OPTIONS: IFuseOptions<OnecNomenclatureRow> = {
  keys: ['name', 'full_name'],
  threshold: 0.3, // Fuse score — best score must be ≤ 0.3, i.e. confidence ≥ 0.7
  includeScore: true,
  minMatchCharLength: 3,
};

const MIN_FUZZY_CONFIDENCE = 0.7;

export class NomenclatureMapper {
  private onecFuse: Fuse<OnecNomenclatureRow> | null = null;

  private refreshIndex(): void {
    const items = onecNomenclatureRepo.listItems({ excludeFolders: true });
    this.onecFuse = new Fuse(items, ONEC_FUSE_OPTIONS);
    logger.debug('Nomenclature mapper index refreshed', { onecItems: items.length });
  }

  private ensureIndex(): Fuse<OnecNomenclatureRow> {
    if (!this.onecFuse) {
      this.refreshIndex();
    }
    return this.onecFuse!;
  }

  invalidateCache(): void {
    this.onecFuse = null;
    logger.info('Nomenclature mapper cache invalidated');
  }

  /**
   * Resolve a scanned item name to a 1C Номенклатура reference.
   * Lookup order:
   *   1. Learned mapping by exact scanned_name → returns onec_guid + name from onec_nomenclature
   *      (or legacy mapped_name_1c if the old row has no onec_guid set)
   *   2. Fuzzy search against onec_nomenclature (confidence ≥ 0.7)
   *   3. None
   */
  map(scannedName: string): MappingResult {
    // 1. Learned mapping
    const learned = mappingRepo.getByScannedName(scannedName);
    if (learned) {
      if (learned.onec_guid) {
        const onec = onecNomenclatureRepo.getByGuid(learned.onec_guid);
        return {
          original_name: scannedName,
          mapped_name: onec?.name ?? learned.mapped_name_1c,
          onec_guid: learned.onec_guid,
          confidence: 1.0,
          source: 'learned',
          mapping_id: learned.id,
        };
      }
      // Legacy mapping without onec_guid
      return {
        original_name: scannedName,
        mapped_name: learned.mapped_name_1c,
        onec_guid: null,
        confidence: 0.9,
        source: 'legacy',
        mapping_id: learned.id,
      };
    }

    // 2. Fuzzy search against onec_nomenclature
    const fuse = this.ensureIndex();
    const results = fuse.search(scannedName);
    if (results.length > 0 && results[0].score !== undefined) {
      const best = results[0];
      const confidence = 1 - (best.score as number);
      if (confidence >= MIN_FUZZY_CONFIDENCE) {
        return {
          original_name: scannedName,
          mapped_name: best.item.name,
          onec_guid: best.item.guid,
          confidence,
          source: 'onec_fuzzy',
          mapping_id: null,
        };
      }
    }

    // 3. None
    return {
      original_name: scannedName,
      mapped_name: scannedName,
      onec_guid: null,
      confidence: 0,
      source: 'none',
      mapping_id: null,
    };
  }

  mapAll(names: string[]): MappingResult[] {
    return names.map(n => this.map(n));
  }

  getSuggestions(scannedName: string, limit: number = 5): Array<{ guid: string; name: string; confidence: number }> {
    const fuse = this.ensureIndex();
    const results = fuse.search(scannedName, { limit });
    return results.map(r => ({
      guid: r.item.guid,
      name: r.item.name,
      confidence: 1 - (r.score || 1),
    }));
  }
}

// Re-export for callers that previously used NomenclatureMapping
export type { NomenclatureMapping };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd c:/www/1C-JPGExchange && npx ts-node src/scripts/test-nomenclature-mapper.ts
```

Expected: `Results: N passed, 0 failed`.

- [ ] **Step 5: TypeScript check across whole project**

```bash
cd c:/www/1C-JPGExchange && npx tsc --noEmit
```

Expected: exit code 0. If it fails on `getByScannedName`-related code in `fileWatcher` or elsewhere because the signature/return changed, that's fixed in Task 11. For now the test script should still compile because it imports the new types directly.

- [ ] **Step 6: Add npm script**

In `package.json` scripts, add:

```json
"test:nomenclature-mapper": "ts-node src/scripts/test-nomenclature-mapper.ts",
```

- [ ] **Step 7: Commit**

```bash
git add src/mapping/nomenclatureMapper.ts src/scripts/test-nomenclature-mapper.ts package.json
git commit -m "Rewrite NomenclatureMapper: GUID-first learned lookup + onec_nomenclature fuzzy"
```

---

## Task 8: `/api/nomenclature` — sync + read endpoints

**Files:**
- Create: `src/api/routes/nomenclature.ts`
- Create: `src/scripts/test-nomenclature-sync-api.ts`
- Modify: `src/api/server.ts`

- [ ] **Step 1: Write integration test (against a running local server)**

Create `src/scripts/test-nomenclature-sync-api.ts`:

```typescript
/**
 * Integration test for /api/nomenclature/* endpoints.
 * Prerequisites: server must be running on localhost:{API_PORT}.
 * Usage: BASE_URL=http://localhost:3000 API_KEY=your-secret-api-key npx ts-node src/scripts/test-nomenclature-sync-api.ts
 */
import '../config';
import { config } from '../config';

const BASE_URL = process.env.BASE_URL || `http://localhost:${config.apiPort}`;
const API_KEY = process.env.API_KEY || config.apiKey;

let passCount = 0;
let failCount = 0;
function assert(condition: boolean, message: string): void {
  if (condition) { console.log(`  ✅ ${message}`); passCount++; }
  else { console.log(`  ❌ FAIL: ${message}`); failCount++; }
}

async function fetchApi(path: string, options: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-API-Key': API_KEY,
    ...((options.headers as Record<string, string>) || {}),
  };
  return fetch(`${BASE_URL}${path}`, { ...options, headers });
}

async function main(): Promise<void> {
  console.log('Nomenclature sync API tests');
  console.log(`Server: ${BASE_URL}`);
  console.log('===========================');

  console.log('\n=== POST /api/nomenclature/sync upserts batch ===');
  const syncRes = await fetchApi('/api/nomenclature/sync', {
    method: 'POST',
    body: JSON.stringify({
      items: [
        { guid: 'test-api-1', code: 'НФ-TST1', name: 'Test Картофель', unit: 'кг', is_folder: false, is_weighted: true },
        { guid: 'test-api-2', code: 'НФ-TST2', name: 'Test Морковь', unit: 'кг', is_folder: false, is_weighted: true },
        { guid: 'test-api-grp', code: null, name: 'Test Овощи', is_folder: true, is_weighted: false },
      ],
    }),
  });
  assert(syncRes.ok, `sync returns 2xx, got ${syncRes.status}`);
  const syncBody = await syncRes.json() as { data: { upserted: number; total: number } };
  assert(syncBody.data.upserted === 3, `upserted 3, got ${syncBody.data.upserted}`);

  console.log('\n=== GET /api/nomenclature/stats ===');
  const statsRes = await fetchApi('/api/nomenclature/stats');
  const statsBody = await statsRes.json() as { data: { total: number; folders: number; items: number; last_synced_at: string | null } };
  assert(statsBody.data.total >= 3, `total ≥ 3, got ${statsBody.data.total}`);
  assert(statsBody.data.last_synced_at !== null, 'last_synced_at populated');

  console.log('\n=== GET /api/nomenclature?exclude_folders=true ===');
  const listRes = await fetchApi('/api/nomenclature?exclude_folders=true');
  const listBody = await listRes.json() as { data: Array<{ guid: string; is_folder: number }>; count: number };
  const testRows = listBody.data.filter(r => r.guid.startsWith('test-api-'));
  assert(testRows.every(r => r.is_folder === 0), 'all returned rows are non-folders');
  assert(testRows.length === 2, `returned 2 test items, got ${testRows.length}`);

  console.log('\n=== POST sync rejects empty body ===');
  const badRes = await fetchApi('/api/nomenclature/sync', { method: 'POST', body: JSON.stringify({}) });
  assert(badRes.status === 400, `empty body → 400, got ${badRes.status}`);

  // Cleanup via direct DB access
  const { getDb } = await import('../database/db');
  const db = getDb();
  db.prepare("DELETE FROM onec_nomenclature WHERE guid LIKE 'test-api-%'").run();

  console.log(`\n===========================`);
  console.log(`Results: ${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
}

main().catch(err => {
  if (err?.cause?.code === 'ECONNREFUSED') {
    console.error('\n❌ Could not connect to server at', BASE_URL);
    console.error('   Start the server first: npm run dev');
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run test to verify it fails (endpoint missing)**

```bash
cd c:/www/1C-JPGExchange && BASE_URL=http://localhost:3000 API_KEY=your-secret-api-key npx ts-node src/scripts/test-nomenclature-sync-api.ts
```

Expected: server may be running (from dev), but the endpoint is not registered → tests fail with 404 or similar. If server not running, start it first via `npm run dev` in another shell then re-run.

- [ ] **Step 3: Create the router**

Create `src/api/routes/nomenclature.ts`:

```typescript
import { Router, Request, Response } from 'express';
import { onecNomenclatureRepo, OnecNomenclatureInput } from '../../database/repositories/onecNomenclatureRepo';
import { mappingRepo } from '../../database/repositories/mappingRepo';
import { logger } from '../../utils/logger';
import { NomenclatureMapper } from '../../mapping/nomenclatureMapper';

const router = Router();

// Optional mapper injection so we can invalidate the cache after sync
let mapper: NomenclatureMapper | null = null;
export function setMapper(m: NomenclatureMapper): void {
  mapper = m;
}

// POST /api/nomenclature/sync — bulk upsert from 1C
router.post('/sync', (req: Request, res: Response) => {
  const items = req.body?.items as OnecNomenclatureInput[] | undefined;
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'items must be a non-empty array' });
    return;
  }
  // Basic validation: each item needs guid + name
  for (const item of items) {
    if (!item.guid || !item.name) {
      res.status(400).json({ error: 'each item must have guid and name' });
      return;
    }
  }
  const upserted = onecNomenclatureRepo.bulkUpsert(items);
  if (mapper) mapper.invalidateCache();
  logger.info('Nomenclature sync completed', { upserted });
  res.json({ data: { upserted, total: items.length } });
});

// GET /api/nomenclature — list catalog items
router.get('/', (req: Request, res: Response) => {
  const excludeFolders = req.query.exclude_folders === 'true';
  const search = req.query.search as string | undefined;
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
  const items = onecNomenclatureRepo.listItems({ excludeFolders, search, limit });
  const stats = onecNomenclatureRepo.stats();
  res.json({ data: items, count: items.length, last_synced_at: stats.last_synced_at });
});

// GET /api/nomenclature/stats
router.get('/stats', (_req: Request, res: Response) => {
  res.json({ data: onecNomenclatureRepo.stats() });
});

// GET /api/nomenclature/suppliers — aggregated list of suppliers across mappings
router.get('/suppliers', (_req: Request, res: Response) => {
  const suppliers = mappingRepo.getSupplierList();
  const unmapped = mappingRepo.getUnmappedCount();
  res.json({ data: { suppliers, unmapped_count: unmapped } });
});

export default router;
```

- [ ] **Step 4: Mount the router in `server.ts`**

Open `src/api/server.ts`. Add the import near the other route imports:

```typescript
import nomenclatureRouter, { setMapper as setNomenclatureMapper } from './routes/nomenclature';
```

Inside `createServer`, after `setMapper(mapper);` in the existing mappings router wiring, add:

```typescript
  setNomenclatureMapper(mapper);
```

And add the route registration after `app.use('/api/settings', apiKeyAuth, settingsRouter);`:

```typescript
  app.use('/api/nomenclature', apiKeyAuth, nomenclatureRouter);
```

- [ ] **Step 5: TypeScript check**

```bash
cd c:/www/1C-JPGExchange && npx tsc --noEmit
```

Expected: exit code 0.

- [ ] **Step 6: Restart dev server and run the integration test**

In one terminal: `cd c:/www/1C-JPGExchange && npm run dev`

In another:

```bash
cd c:/www/1C-JPGExchange && BASE_URL=http://localhost:3000 API_KEY=your-secret-api-key npx ts-node src/scripts/test-nomenclature-sync-api.ts
```

Expected: `Results: N passed, 0 failed`.

Stop the dev server (`Ctrl+C`).

- [ ] **Step 7: Add npm script + commit**

In `package.json`:

```json
"test:nomenclature-sync-api": "ts-node src/scripts/test-nomenclature-sync-api.ts",
```

```bash
git add src/api/routes/nomenclature.ts src/api/server.ts src/scripts/test-nomenclature-sync-api.ts package.json
git commit -m "Add /api/nomenclature router: sync, list, stats, suppliers"
```

---

## Task 9: `PUT /api/invoices/:invoiceId/items/:itemId/map` — per-item mapping

**Files:**
- Modify: `src/api/routes/invoices.ts`

- [ ] **Step 1: Add the route at the end of `invoices.ts` (before `export default router`)**

Find the last route in `src/api/routes/invoices.ts` and, before the `export default router;` line, add:

```typescript
// PUT /api/invoices/:invoiceId/items/:itemId/map — set or clear onec_guid for a single line item.
// Side effects:
//   - Updates invoice_items.onec_guid and mapped_name
//   - Upserts nomenclature_mappings for this scan name → onec_guid (learned mapping)
//   - Records supplier usage
//   - Invalidates mapper cache
router.put('/:invoiceId/items/:itemId/map', (req: Request, res: Response) => {
  const invoiceId = parseInt(req.params.invoiceId as string, 10);
  const itemId = parseInt(req.params.itemId as string, 10);
  const { onec_guid } = req.body as { onec_guid?: string | null };

  const invoice = invoiceRepo.getById(invoiceId);
  if (!invoice) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }
  const item = invoiceRepo.getItemById(itemId);
  if (!item || item.invoice_id !== invoiceId) {
    res.status(404).json({ error: 'Invoice item not found' });
    return;
  }

  let resolvedName: string | null = null;
  if (onec_guid) {
    const onecRow = onecNomenclatureRepo.getByGuid(onec_guid);
    if (!onecRow) {
      res.status(400).json({ error: `onec_guid ${onec_guid} not found in onec_nomenclature` });
      return;
    }
    resolvedName = onecRow.name;
  }

  // Update the invoice item itself
  invoiceRepo.mapItem(itemId, onec_guid ?? null, resolvedName);

  // Learn: upsert nomenclature_mappings for this scan name
  const mapping = mappingRepo.upsert({
    scanned_name: item.original_name,
    mapped_name_1c: resolvedName ?? item.original_name,
    onec_guid: onec_guid ?? null,
  });
  mappingRepo.recordUsage(mapping.id, invoice.supplier ?? null);

  // Invalidate mapper cache so next invoice benefits immediately
  if (mapper) mapper.invalidateCache();

  const updatedItem = invoiceRepo.getItemById(itemId);
  res.json({ data: updatedItem });
});
```

- [ ] **Step 2: Add the missing imports at the top of `invoices.ts`**

At the top of the file, make sure these imports exist (add any that don't):

```typescript
import { onecNomenclatureRepo } from '../../database/repositories/onecNomenclatureRepo';
import { mappingRepo } from '../../database/repositories/mappingRepo';
import { NomenclatureMapper } from '../../mapping/nomenclatureMapper';
```

And add (below existing `let fileWatcher` or similar injected dependencies) a mapper injector:

```typescript
let mapper: NomenclatureMapper | null = null;
export function setMapper(m: NomenclatureMapper): void {
  mapper = m;
}
```

- [ ] **Step 3: Wire the injector in `server.ts`**

In `src/api/server.ts`, near where `setFileWatcher(fileWatcher)` is called, add:

```typescript
  // invoices router also needs the mapper for the item-mapping endpoint
  const { setMapper: setInvoicesMapper } = await import('./routes/invoices');
  setInvoicesMapper(mapper);
```

Wait — `createServer` is not async. Instead, add to the top of `server.ts`:

```typescript
import invoicesRouter, { setMapper as setInvoicesMapper } from './routes/invoices';
```

And in `createServer`, right after `setFileWatcher(fileWatcher);`, add:

```typescript
  setInvoicesMapper(mapper);
```

(Replace the existing `import invoicesRouter from './routes/invoices';` line with the new named import above.)

- [ ] **Step 4: TypeScript check**

```bash
cd c:/www/1C-JPGExchange && npx tsc --noEmit
```

Expected: exit code 0.

- [ ] **Step 5: Smoke test the endpoint manually**

Start `npm run dev` in another terminal. In your current shell:

```bash
cd c:/www/1C-JPGExchange && npx ts-node -e "
(async () => {
  const base = 'http://localhost:3000';
  const key = 'your-secret-api-key';
  // Ensure there's a test onec item
  await fetch(base + '/api/nomenclature/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
    body: JSON.stringify({ items: [{ guid: 'smoke-test-guid', code: 'НФ-SMK', name: 'Smoke Test Item', unit: 'шт', is_folder: false, is_weighted: false }] }),
  });
  // Need an existing invoice with at least one item — skip actual PUT if none exists
  const list = await fetch(base + '/api/invoices?limit=1', { headers: { 'X-API-Key': key } }).then(r => r.json()) as any;
  const inv = list.data[0];
  if (!inv) { console.log('no invoice to test against, skipping'); return; }
  const full = await fetch(base + '/api/invoices/' + inv.id, { headers: { 'X-API-Key': key } }).then(r => r.json()) as any;
  const item = full.data.items?.[0];
  if (!item) { console.log('no items to test against, skipping'); return; }
  const putRes = await fetch(base + '/api/invoices/' + inv.id + '/items/' + item.id + '/map', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
    body: JSON.stringify({ onec_guid: 'smoke-test-guid' }),
  });
  const putBody = await putRes.json();
  console.log('PUT status:', putRes.status, 'body:', JSON.stringify(putBody));
})();
"
```

Expected: `PUT status: 200` and body with `onec_guid: 'smoke-test-guid'` in the updated item.

Stop the dev server. Clean up: `DELETE FROM onec_nomenclature WHERE guid='smoke-test-guid'` (or leave it, harmless).

- [ ] **Step 6: Commit**

```bash
git add src/api/routes/invoices.ts src/api/server.ts
git commit -m "Add PUT /api/invoices/:invoiceId/items/:itemId/map + learning"
```

---

## Task 10: Extend `/api/mappings` with supplier + unmapped filters

**Files:**
- Modify: `src/api/routes/mappings.ts`

- [ ] **Step 1: Replace the GET handler to honor filters**

In `src/api/routes/mappings.ts`, replace the `router.get('/', ...)` handler with:

```typescript
// GET /api/mappings — list mappings.
// Query params:
//   supplier: filter by supplier name (via mapping_supplier_usage)
//   unmapped: "true" to only return mappings with no onec_guid
router.get('/', (req: Request, res: Response) => {
  const supplier = req.query.supplier as string | undefined;
  const unmapped = req.query.unmapped === 'true';
  const mappings = (supplier || unmapped)
    ? mappingRepo.getAllFiltered({ supplier, unmapped })
    : mappingRepo.getAll();
  res.json({ data: mappings, count: mappings.length });
});
```

- [ ] **Step 2: Extend POST and PUT handlers to accept `onec_guid`**

Replace the POST handler:

```typescript
// POST /api/mappings — create or upsert mapping
router.post('/', (req: Request, res: Response) => {
  const { scanned_name, mapped_name_1c, category, default_unit, approved, onec_guid } = req.body;

  if (!scanned_name || !mapped_name_1c) {
    res.status(400).json({ error: 'scanned_name and mapped_name_1c are required' });
    return;
  }

  const mapping = mappingRepo.upsert({
    scanned_name,
    mapped_name_1c,
    category,
    default_unit,
    approved: approved ?? false,
    onec_guid: onec_guid ?? null,
  });

  if (mapper) mapper.invalidateCache();
  res.status(201).json({ data: mapping });
});
```

Find the existing PUT handler and add `onec_guid` to the pulled fields:

```typescript
router.put('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  const { scanned_name, mapped_name_1c, category, default_unit, approved, onec_guid } = req.body;

  mappingRepo.update(id, { scanned_name, mapped_name_1c, category, default_unit, approved, onec_guid });

  if (mapper) mapper.invalidateCache();
  const updated = mappingRepo.getById(id);
  res.json({ data: updated });
});
```

- [ ] **Step 3: TypeScript check**

```bash
cd c:/www/1C-JPGExchange && npx tsc --noEmit
```

Expected: exit code 0.

- [ ] **Step 4: Commit**

```bash
git add src/api/routes/mappings.ts
git commit -m "Mappings API: supplier + unmapped filters, accept onec_guid"
```

---

## Task 11: Update `fileWatcher` to persist `onec_guid` and record usage

**Files:**
- Modify: `src/watcher/fileWatcher.ts`

- [ ] **Step 1: Find the item-creation loop**

Open `src/watcher/fileWatcher.ts`. Search for the loop that iterates `parsed.items` and calls `this.mapper.map(item.name)` and `invoiceRepo.addItem(...)`. There are two such blocks (one in the regular flow, one in the multi-page re-analysis flow).

- [ ] **Step 2: Replace both blocks to pass onec_guid and record usage**

For each `invoiceRepo.addItem({...})` call, replace with:

```typescript
        const mapping = this.mapper.map(item.name);
        invoiceRepo.addItem({
          invoice_id: targetInvoiceId,
          original_name: item.name,
          mapped_name: mapping.mapped_name,
          quantity: item.quantity,
          unit: item.unit,
          price: item.price,
          total: item.total,
          vat_rate: item.vat_rate,
          mapping_confidence: mapping.confidence,
          onec_guid: mapping.onec_guid,
        });
        if (mapping.mapping_id !== null) {
          mappingRepo.recordUsage(mapping.mapping_id, parsed.supplier ?? null);
        }
```

Note: `targetInvoiceId` may be `invoice.id` in the non-merge branch. Keep whichever variable the existing code uses at that point.

Also make sure the import is present at the top of the file:

```typescript
import { mappingRepo } from '../database/repositories/mappingRepo';
```

- [ ] **Step 3: TypeScript check**

```bash
cd c:/www/1C-JPGExchange && npx tsc --noEmit
```

Expected: exit code 0.

- [ ] **Step 4: Commit**

```bash
git add src/watcher/fileWatcher.ts
git commit -m "fileWatcher: persist onec_guid and record supplier usage per item"
```

---

## Task 12: Dashboard — shared `onecCatalog.js` helper with client-side Fuse.js

**Files:**
- Create: `public/js/onecCatalog.js`
- Modify: `public/index.html`

- [ ] **Step 1: Add Fuse.js CDN script to index.html**

Open `public/index.html`. Near the bottom, above the existing `<script src="/js/app.js"></script>` line, add the Fuse CDN include:

```html
<script src="https://cdn.jsdelivr.net/npm/fuse.js@7.0.0"></script>
<script src="/js/onecCatalog.js"></script>
```

- [ ] **Step 2: Create the client catalog helper**

Create `public/js/onecCatalog.js`:

```javascript
/* global App, Fuse, OnecCatalog */
// Client-side cache of Справочник.Номенклатура from the server.
// Used by invoice detail autocomplete and mapping add/edit forms.
const OnecCatalog = {
  items: [],
  fuse: null,
  loaded: false,
  lastSyncedAt: null,

  async load(force = false) {
    if (this.loaded && !force) return;
    try {
      const { data, last_synced_at } = await App.apiJson('/nomenclature?exclude_folders=true');
      this.items = data || [];
      this.lastSyncedAt = last_synced_at;
      this.fuse = new Fuse(this.items, {
        keys: ['name', 'full_name'],
        threshold: 0.3,
        minMatchCharLength: 2,
        includeScore: true,
      });
      this.loaded = true;
    } catch (e) {
      console.error('Failed to load onec catalog', e);
    }
  },

  search(query, limit = 10) {
    if (!this.fuse || !query) return [];
    return this.fuse.search(query, { limit }).map(r => ({
      guid: r.item.guid,
      name: r.item.name,
      full_name: r.item.full_name,
      unit: r.item.unit,
      confidence: 1 - (r.score || 1),
    }));
  },

  getByGuid(guid) {
    return this.items.find(it => it.guid === guid) || null;
  },

  isEmpty() {
    return this.loaded && this.items.length === 0;
  },
};
```

- [ ] **Step 3: Commit**

```bash
git add public/index.html public/js/onecCatalog.js
git commit -m "Dashboard: add OnecCatalog client helper with Fuse.js autocomplete"
```

---

## Task 13: Dashboard — invoice detail autocomplete per item

**Files:**
- Modify: `public/js/invoices.js`
- Modify: `public/css/style.css`

- [ ] **Step 1: Preload the catalog when invoice detail opens**

In `public/js/invoices.js`, find the `showDetail(id)` method. At the very top of the method, before the API call, add:

```javascript
    await OnecCatalog.load();
```

- [ ] **Step 2: Replace the items table rendering to include autocomplete**

Still in `showDetail`, find the block that renders the items table (`itemsTbody.innerHTML = data.items.map(...)`). Replace the whole `itemsTbody.innerHTML =` assignment with:

```javascript
      const itemsTbody = document.getElementById('invoice-items-tbody');
      if (data.items && data.items.length > 0) {
        itemsTbody.innerHTML = data.items.map((item, i) => {
          const badge = item.onec_guid
            ? '<span class="nom-badge nom-badge-ok" title="Сопоставлено">✓</span>'
            : '<span class="nom-badge nom-badge-missing" title="Требует сопоставления">●</span>';
          const currentName = item.mapped_name || item.original_name;
          const safeName = currentName.replace(/"/g, '&quot;');
          return `
          <tr data-item-id="${item.id}">
            <td>${i + 1}</td>
            <td>${item.original_name}</td>
            <td>
              <div class="nom-picker">
                ${badge}
                <input type="text" class="nom-picker-input"
                       value="${safeName}"
                       data-invoice-id="${data.id}"
                       data-item-id="${item.id}"
                       data-current-guid="${item.onec_guid || ''}"
                       oninput="Invoices.onNomInput(event)"
                       onfocus="Invoices.onNomFocus(event)"
                       onblur="Invoices.onNomBlur(event)">
                <div class="nom-picker-dropdown" id="nom-dd-${item.id}"></div>
              </div>
            </td>
            <td style="text-align:right">${item.quantity != null ? item.quantity : '—'}</td>
            <td>${item.unit || '—'}</td>
            <td style="text-align:right">${App.formatMoney(item.price)}</td>
            <td style="text-align:right">${App.formatMoney(item.total)}</td>
            <td style="text-align:center">${item.vat_rate != null ? item.vat_rate + '%' : '—'}</td>
            <td>${App.confidenceBadge(item.mapping_confidence || 0)}</td>
          </tr>
        `;
        }).join('');
      } else {
        itemsTbody.innerHTML = '<tr><td colspan="9"><div class="empty-state">Товары не найдены</div></td></tr>';
      }
```

- [ ] **Step 3: Gate the "Отправить в 1С" button on mapping completeness**

Still in `showDetail`, find where `actionsHtml` is built. Right before the `"Отправить в 1С"` button line, replace:

```javascript
        if (data.status === 'processed') {
          if (data.approved_for_1c) {
            actionsHtml += `<div class="badge badge-sent" style="padding:8px 16px">✓ Ожидает загрузки в 1С</div>`;
            actionsHtml += `<button class="btn btn-outline" onclick="Invoices.unapproveForOneC(${data.id})">Отозвать отправку</button>`;
          } else {
            actionsHtml += `<button class="btn btn-primary" onclick="Invoices.sendTo1C(${data.id})">Отправить в 1С</button>`;
          }
        }
```

with:

```javascript
        const unmappedCount = (data.items || []).filter(it => !it.onec_guid).length;
        if (data.status === 'processed') {
          if (data.approved_for_1c) {
            actionsHtml += `<div class="badge badge-sent" style="padding:8px 16px">✓ Ожидает загрузки в 1С</div>`;
            actionsHtml += `<button class="btn btn-outline" onclick="Invoices.unapproveForOneC(${data.id})">Отозвать отправку</button>`;
          } else {
            const disabled = unmappedCount > 0 ? 'disabled' : '';
            const title = unmappedCount > 0
              ? `title="Сопоставьте ${unmappedCount} товар(ов) с 1С перед отправкой"`
              : '';
            actionsHtml += `<button class="btn btn-primary" ${disabled} ${title} onclick="Invoices.sendTo1C(${data.id})">Отправить в 1С</button>`;
            if (unmappedCount > 0) {
              actionsHtml += `<div class="badge badge-new" style="padding:8px 16px">Не сопоставлено: ${unmappedCount}</div>`;
            }
          }
        }
```

- [ ] **Step 4: Add autocomplete event handlers to the Invoices object**

Still in `public/js/invoices.js`, add these methods to the `Invoices` object (before the closing `};`):

```javascript
  onNomInput(event) {
    const input = event.target;
    const dd = document.getElementById('nom-dd-' + input.dataset.itemId);
    if (!dd) return;
    const q = input.value.trim();
    if (!q) { dd.style.display = 'none'; return; }
    const results = OnecCatalog.search(q, 10);
    if (results.length === 0) { dd.style.display = 'none'; return; }
    dd.innerHTML = results.map(r => `
      <div class="nom-picker-option"
           onmousedown="event.preventDefault()"
           onclick="Invoices.selectNomItem('${input.dataset.invoiceId}', '${input.dataset.itemId}', '${r.guid}', ${JSON.stringify(r.name).replace(/'/g, "\\'")})">
        <strong>${r.name}</strong>
        ${r.unit ? '<span class="nom-unit">' + r.unit + '</span>' : ''}
      </div>
    `).join('');
    dd.style.display = 'block';
  },

  onNomFocus(event) {
    this.onNomInput(event);
  },

  onNomBlur(event) {
    const dd = document.getElementById('nom-dd-' + event.target.dataset.itemId);
    setTimeout(() => { if (dd) dd.style.display = 'none'; }, 150);
  },

  async selectNomItem(invoiceId, itemId, guid, name) {
    try {
      const res = await App.api(`/invoices/${invoiceId}/items/${itemId}/map`, {
        method: 'PUT',
        body: { onec_guid: guid },
      });
      if (res.ok) {
        App.notify(`Сопоставлено: ${name}`, 'success');
        this.showDetail(parseInt(invoiceId, 10));
      } else {
        const data = await res.json();
        App.notify(data.error || 'Ошибка сопоставления', 'error');
      }
    } catch (e) {
      App.notify('Ошибка: ' + e.message, 'error');
    }
  },
```

- [ ] **Step 5: Add CSS for the picker**

Append to `public/css/style.css`:

```css
/* Nomenclature picker (invoice detail autocomplete) */
.nom-picker {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
}
.nom-picker-input {
  flex: 1;
  padding: 4px 8px;
  border: 1px solid var(--border, #cbd5e1);
  border-radius: 4px;
  font-size: 13px;
  background: #fff;
}
.nom-picker-input:focus {
  outline: none;
  border-color: var(--primary, #3b82f6);
}
.nom-picker-dropdown {
  display: none;
  position: absolute;
  top: 100%;
  left: 28px;
  right: 0;
  z-index: 100;
  max-height: 260px;
  overflow-y: auto;
  background: #fff;
  border: 1px solid var(--border, #cbd5e1);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
}
.nom-picker-option {
  padding: 6px 10px;
  cursor: pointer;
  font-size: 13px;
  border-bottom: 1px solid #f1f5f9;
}
.nom-picker-option:last-child { border-bottom: none; }
.nom-picker-option:hover { background: #f1f5f9; }
.nom-picker-option .nom-unit {
  color: #64748b;
  font-size: 11px;
  margin-left: 6px;
}
.nom-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  font-size: 13px;
  flex-shrink: 0;
}
.nom-badge-ok {
  background: #dcfce7;
  color: #166534;
}
.nom-badge-missing {
  background: #fee2e2;
  color: #b91c1c;
}
```

- [ ] **Step 6: Commit**

```bash
git add public/js/invoices.js public/css/style.css
git commit -m "Dashboard: autocomplete per-item mapping in invoice detail + gating"
```

---

## Task 14: Dashboard — Nomenclature tab with mode toggle and supplier sidebar

**Files:**
- Modify: `public/index.html`
- Modify: `public/js/mappings.js`
- Modify: `public/css/style.css`

- [ ] **Step 1: Restructure the Nomenclature section in index.html**

Open `public/index.html`. Find `<section id="view-mappings">`. Replace the whole section content with:

```html
    <section id="view-mappings">
      <div class="section-header" style="margin-bottom:16px">
        <div>
          <h2>Номенклатурные соответствия</h2>
          <div id="mappings-catalog-status" class="section-subtitle">Загрузка...</div>
        </div>
        <button class="btn btn-primary" onclick="Mappings.showAddForm()">+ Добавить</button>
      </div>

      <div class="tabs" style="margin-bottom:16px">
        <button class="tab-btn active" id="mappings-mode-all" onclick="Mappings.setMode('all')">Все маппинги</button>
        <button class="tab-btn" id="mappings-mode-by-supplier" onclick="Mappings.setMode('by-supplier')">По поставщикам</button>
      </div>

      <div id="mappings-mode-all-pane">
        <div class="filters">
          <input type="text" id="mappings-search" placeholder="Поиск..." oninput="Mappings.filter(this.value)">
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Скан имя</th>
                <th>1С товар</th>
                <th>GUID</th>
                <th>Посл. поставщик</th>
                <th>× раз</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="mappings-tbody"></tbody>
          </table>
        </div>
      </div>

      <div id="mappings-mode-by-supplier-pane" style="display:none">
        <div class="supplier-layout">
          <aside class="supplier-sidebar">
            <div class="supplier-sidebar-header">Поставщики</div>
            <div id="supplier-list"></div>
          </aside>
          <div class="supplier-content">
            <div id="supplier-header" class="supplier-content-header">Выберите поставщика слева</div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Скан имя</th>
                    <th>1С товар</th>
                    <th>GUID</th>
                    <th>× раз</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody id="supplier-mappings-tbody"></tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </section>
```

- [ ] **Step 2: Rewrite `public/js/mappings.js`**

Replace the entire contents of `public/js/mappings.js` with:

```javascript
/* global App, OnecCatalog, Mappings */
const Mappings = {
  mode: 'all',
  allMappings: [],
  suppliers: [],
  currentSupplier: null,
  currentSupplierMappings: [],
  editingId: null,

  async load() {
    await OnecCatalog.load();
    this.updateCatalogStatus();
    if (this.mode === 'all') {
      await this.loadAll();
    } else {
      await this.loadSuppliers();
    }
  },

  updateCatalogStatus() {
    const el = document.getElementById('mappings-catalog-status');
    if (!el) return;
    if (OnecCatalog.items.length === 0) {
      el.innerHTML = '<span style="color:#b91c1c">Справочник не выгружен. Запустите команду "Выгрузить номенклатуру" в обработке 1С.</span>';
    } else {
      const ts = OnecCatalog.lastSyncedAt ? new Date(OnecCatalog.lastSyncedAt).toLocaleString('ru-RU') : '—';
      el.innerHTML = `Справочник из 1С: <strong>${OnecCatalog.items.length}</strong> товаров · Последняя выгрузка: ${ts}`;
    }
  },

  setMode(mode) {
    this.mode = mode;
    document.getElementById('mappings-mode-all').classList.toggle('active', mode === 'all');
    document.getElementById('mappings-mode-by-supplier').classList.toggle('active', mode === 'by-supplier');
    document.getElementById('mappings-mode-all-pane').style.display = mode === 'all' ? 'block' : 'none';
    document.getElementById('mappings-mode-by-supplier-pane').style.display = mode === 'by-supplier' ? 'block' : 'none';
    this.load();
  },

  async loadAll() {
    try {
      const { data } = await App.apiJson('/mappings');
      this.allMappings = data || [];
      this.renderAll();
    } catch (e) {
      console.error('Failed to load mappings', e);
      App.notify('Ошибка загрузки соответствий', 'error');
    }
  },

  filter(query) { this.renderAll(query); },

  renderAll(filterQuery = '') {
    const tbody = document.getElementById('mappings-tbody');
    let items = this.allMappings;
    if (filterQuery) {
      const q = filterQuery.toLowerCase();
      items = items.filter(m =>
        (m.scanned_name || '').toLowerCase().includes(q) ||
        (m.mapped_name_1c || '').toLowerCase().includes(q) ||
        (m.last_seen_supplier || '').toLowerCase().includes(q)
      );
    }
    if (items.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">
        <div class="empty-icon">&#128218;</div>
        <div>${filterQuery ? 'Ничего не найдено' : 'Соответствия ещё не добавлены'}</div>
      </div></td></tr>`;
      return;
    }
    tbody.innerHTML = items.map(m => this.editingId === m.id ? this.editRow(m) : this.viewRow(m)).join('');
  },

  viewRow(m) {
    const guidShort = m.onec_guid ? m.onec_guid.substring(0, 8) + '…' : '<span style="color:#b91c1c">—</span>';
    return `
      <tr>
        <td>${m.id}</td>
        <td>${m.scanned_name}</td>
        <td>${m.mapped_name_1c}</td>
        <td><code style="font-size:11px">${guidShort}</code></td>
        <td>${m.last_seen_supplier || '—'}</td>
        <td style="text-align:right">${m.times_seen || 0}</td>
        <td>
          <button class="btn btn-outline btn-sm" onclick="Mappings.startEdit(${m.id})">Ред.</button>
          <button class="btn btn-danger btn-sm" onclick="Mappings.remove(${m.id})">Удалить</button>
        </td>
      </tr>
    `;
  },

  editRow(m) {
    const guidValue = m.onec_guid || '';
    const nameValue = m.mapped_name_1c || '';
    return `
      <tr class="inline-form">
        <td>${m.id}</td>
        <td><input type="text" id="edit-scanned" value="${m.scanned_name}"></td>
        <td>
          <div class="nom-picker">
            <input type="text" class="nom-picker-input" id="edit-nom-input"
                   value="${nameValue.replace(/"/g, '&quot;')}"
                   oninput="Mappings.onEditNomInput()"
                   onfocus="Mappings.onEditNomInput()"
                   onblur="setTimeout(() => document.getElementById('edit-nom-dropdown').style.display='none', 150)">
            <div class="nom-picker-dropdown" id="edit-nom-dropdown"></div>
          </div>
          <input type="hidden" id="edit-onec-guid" value="${guidValue}">
        </td>
        <td><code style="font-size:11px" id="edit-guid-preview">${guidValue ? guidValue.substring(0, 8) + '…' : '—'}</code></td>
        <td colspan="2">
          <button class="btn btn-primary btn-sm" onclick="Mappings.saveEdit(${m.id})">Сохр.</button>
          <button class="btn btn-outline btn-sm" onclick="Mappings.cancelEdit()">Отм.</button>
        </td>
      </tr>
    `;
  },

  onEditNomInput() {
    const input = document.getElementById('edit-nom-input');
    const dd = document.getElementById('edit-nom-dropdown');
    if (!input || !dd) return;
    const q = input.value.trim();
    if (!q) { dd.style.display = 'none'; return; }
    const results = OnecCatalog.search(q, 10);
    if (results.length === 0) { dd.style.display = 'none'; return; }
    dd.innerHTML = results.map(r => `
      <div class="nom-picker-option"
           onmousedown="event.preventDefault()"
           onclick="Mappings.pickEditNom('${r.guid}', ${JSON.stringify(r.name).replace(/'/g, "\\'")})">
        <strong>${r.name}</strong>
        ${r.unit ? '<span class="nom-unit">' + r.unit + '</span>' : ''}
      </div>
    `).join('');
    dd.style.display = 'block';
  },

  pickEditNom(guid, name) {
    document.getElementById('edit-nom-input').value = name;
    document.getElementById('edit-onec-guid').value = guid;
    document.getElementById('edit-guid-preview').textContent = guid.substring(0, 8) + '…';
    document.getElementById('edit-nom-dropdown').style.display = 'none';
  },

  startEdit(id) {
    this.editingId = id;
    if (this.mode === 'all') this.renderAll(document.getElementById('mappings-search').value);
    else this.renderSupplierMappings();
  },

  cancelEdit() {
    this.editingId = null;
    if (this.mode === 'all') this.renderAll(document.getElementById('mappings-search').value);
    else this.renderSupplierMappings();
  },

  async saveEdit(id) {
    const data = {
      scanned_name: document.getElementById('edit-scanned').value.trim(),
      mapped_name_1c: document.getElementById('edit-nom-input').value.trim(),
      onec_guid: document.getElementById('edit-onec-guid').value.trim() || null,
    };
    if (!data.scanned_name || !data.mapped_name_1c) {
      App.notify('Заполните обязательные поля', 'error');
      return;
    }
    try {
      await App.api(`/mappings/${id}`, { method: 'PUT', body: data });
      this.editingId = null;
      App.notify('Соответствие обновлено', 'success');
      await this.load();
    } catch (e) {
      App.notify('Ошибка сохранения', 'error');
    }
  },

  showAddForm() {
    // Inject an inline add row into whichever tbody is active
    const tbody = this.mode === 'all'
      ? document.getElementById('mappings-tbody')
      : document.getElementById('supplier-mappings-tbody');
    if (document.getElementById('add-scanned')) return;
    const row = document.createElement('tr');
    row.className = 'inline-form';
    row.innerHTML = `
      <td>—</td>
      <td><input type="text" id="add-scanned" placeholder="Название из скана"></td>
      <td>
        <div class="nom-picker">
          <input type="text" class="nom-picker-input" id="add-nom-input" placeholder="Выберите из 1С..."
                 oninput="Mappings.onAddNomInput()"
                 onfocus="Mappings.onAddNomInput()"
                 onblur="setTimeout(() => document.getElementById('add-nom-dropdown').style.display='none', 150)">
          <div class="nom-picker-dropdown" id="add-nom-dropdown"></div>
        </div>
        <input type="hidden" id="add-onec-guid" value="">
      </td>
      <td><code style="font-size:11px" id="add-guid-preview">—</code></td>
      <td colspan="3">
        <button class="btn btn-primary btn-sm" onclick="Mappings.saveNew()">Добавить</button>
        <button class="btn btn-outline btn-sm" onclick="this.closest('tr').remove()">Отм.</button>
      </td>
    `;
    tbody.insertBefore(row, tbody.firstChild);
    document.getElementById('add-scanned').focus();
  },

  onAddNomInput() {
    const input = document.getElementById('add-nom-input');
    const dd = document.getElementById('add-nom-dropdown');
    if (!input || !dd) return;
    const q = input.value.trim();
    if (!q) { dd.style.display = 'none'; return; }
    const results = OnecCatalog.search(q, 10);
    if (results.length === 0) { dd.style.display = 'none'; return; }
    dd.innerHTML = results.map(r => `
      <div class="nom-picker-option"
           onmousedown="event.preventDefault()"
           onclick="Mappings.pickAddNom('${r.guid}', ${JSON.stringify(r.name).replace(/'/g, "\\'")})">
        <strong>${r.name}</strong>
        ${r.unit ? '<span class="nom-unit">' + r.unit + '</span>' : ''}
      </div>
    `).join('');
    dd.style.display = 'block';
  },

  pickAddNom(guid, name) {
    document.getElementById('add-nom-input').value = name;
    document.getElementById('add-onec-guid').value = guid;
    document.getElementById('add-guid-preview').textContent = guid.substring(0, 8) + '…';
    document.getElementById('add-nom-dropdown').style.display = 'none';
  },

  async saveNew() {
    const data = {
      scanned_name: document.getElementById('add-scanned').value.trim(),
      mapped_name_1c: document.getElementById('add-nom-input').value.trim(),
      onec_guid: document.getElementById('add-onec-guid').value.trim() || null,
    };
    if (!data.scanned_name || !data.mapped_name_1c) {
      App.notify('Заполните Скан-имя и выберите товар из 1С', 'error');
      return;
    }
    try {
      await App.api('/mappings', { method: 'POST', body: data });
      App.notify('Соответствие добавлено', 'success');
      await this.load();
    } catch (e) {
      App.notify('Ошибка добавления', 'error');
    }
  },

  async remove(id) {
    if (!confirm('Удалить это соответствие?')) return;
    try {
      await App.api(`/mappings/${id}`, { method: 'DELETE' });
      App.notify('Удалено', 'success');
      await this.load();
    } catch (e) {
      App.notify('Ошибка удаления', 'error');
    }
  },

  async loadSuppliers() {
    try {
      const { data } = await App.apiJson('/nomenclature/suppliers');
      this.suppliers = data.suppliers || [];
      const unmappedCount = data.unmapped_count || 0;
      this.renderSupplierList(unmappedCount);
    } catch (e) {
      console.error('Failed to load suppliers', e);
      App.notify('Ошибка загрузки поставщиков', 'error');
    }
  },

  renderSupplierList(unmappedCount) {
    const container = document.getElementById('supplier-list');
    const unmappedItem = `
      <div class="supplier-item ${this.currentSupplier === '__unmapped__' ? 'active' : ''}"
           onclick="Mappings.selectSupplier('__unmapped__')">
        🔴 Не сопоставлено <span class="supplier-count">${unmappedCount}</span>
      </div>
    `;
    const rows = this.suppliers.map(s => `
      <div class="supplier-item ${this.currentSupplier === s.supplier ? 'active' : ''}"
           onclick="Mappings.selectSupplier(${JSON.stringify(s.supplier).replace(/"/g, '&quot;')})">
        ${s.supplier} <span class="supplier-count">${s.mappings_count}</span>
      </div>
    `).join('');
    container.innerHTML = unmappedItem + rows;
  },

  async selectSupplier(supplier) {
    this.currentSupplier = supplier;
    const header = document.getElementById('supplier-header');
    const qs = supplier === '__unmapped__' ? '?unmapped=true' : `?supplier=${encodeURIComponent(supplier)}`;
    header.textContent = supplier === '__unmapped__' ? 'Несопоставленные маппинги' : supplier;
    try {
      const { data } = await App.apiJson('/mappings' + qs);
      this.currentSupplierMappings = data || [];
      this.renderSupplierMappings();
      // Re-render sidebar to update active highlight
      await this.loadSuppliers();
    } catch (e) {
      App.notify('Ошибка загрузки маппингов поставщика', 'error');
    }
  },

  renderSupplierMappings() {
    const tbody = document.getElementById('supplier-mappings-tbody');
    if (this.currentSupplierMappings.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state">Нет данных</div></td></tr>';
      return;
    }
    tbody.innerHTML = this.currentSupplierMappings.map(m => {
      if (this.editingId === m.id) return this.editRow(m);
      const guidShort = m.onec_guid ? m.onec_guid.substring(0, 8) + '…' : '<span style="color:#b91c1c">—</span>';
      return `
        <tr>
          <td>${m.id}</td>
          <td>${m.scanned_name}</td>
          <td>${m.mapped_name_1c}</td>
          <td><code style="font-size:11px">${guidShort}</code></td>
          <td style="text-align:right">${m.times_seen || 0}</td>
          <td>
            <button class="btn btn-outline btn-sm" onclick="Mappings.startEdit(${m.id})">Ред.</button>
            <button class="btn btn-danger btn-sm" onclick="Mappings.remove(${m.id})">Удалить</button>
          </td>
        </tr>
      `;
    }).join('');
  },
};
```

- [ ] **Step 3: Add CSS for tabs + supplier layout**

Append to `public/css/style.css`:

```css
/* Tabs inside nomenclature section */
.tabs {
  display: flex;
  gap: 8px;
  border-bottom: 1px solid var(--border, #e2e8f0);
  padding-bottom: 0;
}
.tab-btn {
  background: transparent;
  border: none;
  padding: 10px 16px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-muted, #64748b);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: color 0.15s, border-color 0.15s;
}
.tab-btn:hover { color: var(--primary, #3b82f6); }
.tab-btn.active {
  color: var(--primary, #3b82f6);
  border-bottom-color: var(--primary, #3b82f6);
}

/* Supplier-by-supplier layout */
.supplier-layout {
  display: grid;
  grid-template-columns: 260px 1fr;
  gap: 16px;
  min-height: 400px;
}
.supplier-sidebar {
  background: var(--bg, #f8fafc);
  border: 1px solid var(--border, #e2e8f0);
  border-radius: 8px;
  overflow: hidden;
  max-height: 600px;
  overflow-y: auto;
}
.supplier-sidebar-header {
  padding: 10px 14px;
  font-weight: 600;
  font-size: 13px;
  color: var(--text-muted, #64748b);
  background: #fff;
  border-bottom: 1px solid var(--border, #e2e8f0);
  position: sticky;
  top: 0;
}
.supplier-item {
  padding: 10px 14px;
  font-size: 13px;
  cursor: pointer;
  border-bottom: 1px solid var(--border, #e2e8f0);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.supplier-item:hover { background: #fff; }
.supplier-item.active {
  background: var(--primary, #3b82f6);
  color: #fff;
}
.supplier-item.active .supplier-count {
  background: rgba(255,255,255,0.25);
  color: #fff;
}
.supplier-count {
  background: var(--border, #e2e8f0);
  color: var(--text, #1e293b);
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
  flex-shrink: 0;
}
.supplier-content {
  min-width: 0;
}
.supplier-content-header {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 12px;
  color: var(--text, #1e293b);
}
```

- [ ] **Step 4: Smoke test**

Start `npm run dev`. In the browser open `http://localhost:3000/#/mappings`. Check:
- Status row shows "Справочник не выгружен" if `onec_nomenclature` is empty
- Toggle "По поставщикам" switches pane
- Adding a mapping shows the autocomplete input

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/js/mappings.js public/css/style.css
git commit -m "Dashboard: nomenclature tab with mode toggle + supplier view"
```

---

## Task 15: 1С BSL — new "Выгрузить номенклатуру" command

**Files:**
- Modify: `1c/КНД_ЗагрузкаНакладныхСканер/КНД_ЗагрузкаНакладныхСканер/Ext/ObjectModule.bsl`
- Modify: `1c/КНД_ЗагрузкаНакладныхСканер/КНД_ЗагрузкаНакладныхСканер/Forms/Форма/Ext/Form.xml`
- Modify: `1c/КНД_ЗагрузкаНакладныхСканер/КНД_ЗагрузкаНакладныхСканер/Forms/Форма/Ext/Form/Module.bsl`

- [ ] **Step 1: Add second command in `СведенияОВнешнейОбработке`**

In `ObjectModule.bsl`, locate the `СведенияОВнешнейОбработке` function. After the existing `ДобавитьКоманду(...)` call for `КНД_ЗагрузкаНакладныхСканер`, add another call:

```bsl
	ДобавитьКоманду(ТаблицаКоманд,
		"Выгрузить номенклатуру на сайт",
		"КНД_ВыгрузкаНоменклатуры",
		"ВызовСерверногоМетода");
```

- [ ] **Step 2: Add dispatch in `ВыполнитьКоманду`**

Replace the `ВыполнитьКоманду` procedure with:

```bsl
Процедура ВыполнитьКоманду(ИдентификаторКоманды, ПараметрыВыполненияКоманды) Экспорт

	Если ИдентификаторКоманды = "КНД_ЗагрузкаНакладныхСканер" Тогда
		ЗагрузитьНакладныеСоСканера();
	ИначеЕсли ИдентификаторКоманды = "КНД_ВыгрузкаНоменклатуры" Тогда
		ВыгрузитьНоменклатуруНаСайт();
	КонецЕсли;

КонецПроцедуры
```

- [ ] **Step 3: Implement `ВыгрузитьНоменклатуруНаСайт` at the end of the module**

Append to `ObjectModule.bsl` (before the final `// ============...` comment or at the very end):

```bsl
// ============================================================================
// ВЫГРУЗКА СПРАВОЧНИКА НОМЕНКЛАТУРЫ НА САЙТ
// ============================================================================

Функция ВыгрузитьНоменклатуруНаСайт() Экспорт

	Отчёт = Новый Массив;
	Отчёт.Добавить("=== Выгрузка номенклатуры на сайт ===");
	Отчёт.Добавить("Сервер: " + КОНСТ_АдресСервиса() + ":" + Строка(КОНСТ_Порт()));
	Отчёт.Добавить("");

	Запрос = Новый Запрос;
	Запрос.Текст =
		"ВЫБРАТЬ
		|	Номенклатура.Ссылка КАК Ссылка,
		|	Номенклатура.Код КАК Код,
		|	Номенклатура.Наименование КАК Наименование,
		|	Номенклатура.НаименованиеПолное КАК НаименованиеПолное,
		|	Номенклатура.ЕдиницаИзмерения.Наименование КАК ЕдиницаИзмерения,
		|	Номенклатура.Родитель КАК Родитель,
		|	Номенклатура.ЭтоГруппа КАК ЭтоГруппа,
		|	Номенклатура.Весовой КАК Весовой
		|ИЗ
		|	Справочник.Номенклатура КАК Номенклатура
		|ГДЕ
		|	НЕ Номенклатура.ПометкаУдаления";

	Выборка = Запрос.Выполнить().Выбрать();

	РазмерБатча = 500;
	Батч = Новый Массив;
	ВсегоВыгружено = 0;
	ВсегоПапок = 0;
	ВсегоТоваров = 0;

	Пока Выборка.Следующий() Цикл

		Запись = Новый Структура;
		Запись.Вставить("guid", Строка(Выборка.Ссылка.УникальныйИдентификатор()));
		Запись.Вставить("code", СокрЛП(Выборка.Код));
		Запись.Вставить("name", Выборка.Наименование);
		Запись.Вставить("full_name", Выборка.НаименованиеПолное);
		Запись.Вставить("unit", Выборка.ЕдиницаИзмерения);
		Запись.Вставить("is_folder", Выборка.ЭтоГруппа = Истина);
		Запись.Вставить("is_weighted", Выборка.Весовой = Истина);

		Если ЗначениеЗаполнено(Выборка.Родитель) Тогда
			Запись.Вставить("parent_guid", Строка(Выборка.Родитель.УникальныйИдентификатор()));
		Иначе
			Запись.Вставить("parent_guid", Неопределено);
		КонецЕсли;

		Батч.Добавить(Запись);

		Если Выборка.ЭтоГруппа Тогда
			ВсегоПапок = ВсегоПапок + 1;
		Иначе
			ВсегоТоваров = ВсегоТоваров + 1;
		КонецЕсли;

		Если Батч.Количество() >= РазмерБатча Тогда
			Результат = ОтправитьБатчНоменклатуры(Батч);
			Если НЕ Результат.Успех Тогда
				Отчёт.Добавить("✗ Ошибка отправки батча: " + Результат.Ошибка);
				Возврат СоздатьОтчётСтроку(Отчёт);
			КонецЕсли;
			ВсегоВыгружено = ВсегоВыгружено + Результат.Выгружено;
			Батч.Очистить();
		КонецЕсли;

	КонецЦикла;

	// Последний батч
	Если Батч.Количество() > 0 Тогда
		Результат = ОтправитьБатчНоменклатуры(Батч);
		Если НЕ Результат.Успех Тогда
			Отчёт.Добавить("✗ Ошибка отправки последнего батча: " + Результат.Ошибка);
			Возврат СоздатьОтчётСтроку(Отчёт);
		КонецЕсли;
		ВсегоВыгружено = ВсегоВыгружено + Результат.Выгружено;
	КонецЕсли;

	Отчёт.Добавить("Выгружено позиций: " + Строка(ВсегоВыгружено));
	Отчёт.Добавить("  Папок:   " + Строка(ВсегоПапок));
	Отчёт.Добавить("  Товаров: " + Строка(ВсегоТоваров));

	Возврат СоздатьОтчётСтроку(Отчёт);

КонецФункции

Функция ОтправитьБатчНоменклатуры(Батч)

	Соединение = СоздатьHTTPСоединение();
	Если Соединение = Неопределено Тогда
		Возврат Новый Структура("Успех, Ошибка, Выгружено", Ложь, "Нет соединения", 0);
	КонецЕсли;

	Тело = Новый Структура;
	Тело.Вставить("items", Батч);

	ЗаписьJSON = Новый ЗаписьJSON;
	ЗаписьJSON.УстановитьСтроку();
	ЗаписатьJSON(ЗаписьJSON, Тело);
	СтрокаТела = ЗаписьJSON.Закрыть();

	Запрос = Новый HTTPЗапрос("/api/nomenclature/sync");
	Запрос.Заголовки.Вставить("X-API-Key", КОНСТ_КлючAPI());
	Запрос.Заголовки.Вставить("Content-Type", "application/json");
	Запрос.УстановитьТелоИзСтроки(СтрокаТела, "UTF-8");

	Попытка
		Ответ = Соединение.ОтправитьДляОбработки(Запрос);
	Исключение
		Возврат Новый Структура("Успех, Ошибка, Выгружено", Ложь, ОписаниеОшибки(), 0);
	КонецПопытки;

	Если Ответ.КодСостояния <> 200 Тогда
		Возврат Новый Структура("Успех, Ошибка, Выгружено", Ложь,
			"HTTP " + Строка(Ответ.КодСостояния), 0);
	КонецЕсли;

	Возврат Новый Структура("Успех, Ошибка, Выгружено", Истина, "", Батч.Количество());

КонецФункции
```

- [ ] **Step 4: Add a button for the new command on the form**

In `Forms/Форма/Ext/Form.xml`, find the `<ChildItems>` block. Add a second Button element inside it (after the existing `ЗагрузитьНакладные` button):

```xml
		<Button name="ВыгрузитьНоменклатуру" id="3">
			<Type>UsualButton</Type>
			<CommandName>Form.Command.ВыгрузитьНоменклатуру</CommandName>
			<ExtendedTooltip name="ВыгрузитьНоменклатуруРасширеннаяПодсказка" id="4"/>
		</Button>
```

And in the same file, inside `<Commands>`, add a second Command:

```xml
		<Command name="ВыгрузитьНоменклатуру" id="2">
			<Title>
				<v8:item>
					<v8:lang>ru</v8:lang>
					<v8:content>Выгрузить номенклатуру</v8:content>
				</v8:item>
			</Title>
			<ToolTip>
				<v8:item>
					<v8:lang>ru</v8:lang>
					<v8:content>Выгрузить справочник Номенклатура на scan.magday.ru</v8:content>
				</v8:item>
			</ToolTip>
			<Action>ВыгрузитьНоменклатуру</Action>
		</Command>
```

- [ ] **Step 5: Add the form handler**

In `Forms/Форма/Ext/Form/Module.bsl`, append to the end of the file:

```bsl

&НаСервере
Функция ВыгрузитьНоменклатуруНаСервере()
	ОбъектОбработка = РеквизитФормыВЗначение("Объект");
	Возврат ОбъектОбработка.ВыгрузитьНоменклатуруНаСайт();
КонецФункции

&НаКлиенте
Процедура ВыгрузитьНоменклатуру(Команда)
	Отчёт = ВыгрузитьНоменклатуруНаСервере();
	ПоказатьПредупреждение(, Отчёт, 60);
КонецПроцедуры
```

- [ ] **Step 6: Commit**

```bash
git add 1c/КНД_ЗагрузкаНакладныхСканер/
git commit -m "1С BSL: add 'Выгрузить номенклатуру' command (catalog sync to scan.magday.ru)"
```

---

## Task 16: 1С BSL — GUID-first resolution in `СоздатьПриходнуюНакладную`

**Files:**
- Modify: `1c/КНД_ЗагрузкаНакладныхСканер/КНД_ЗагрузкаНакладныхСканер/Ext/ObjectModule.bsl`

- [ ] **Step 1: Find the item loop in `СоздатьПриходнуюНакладную`**

Search for the block that reads `ИмяНоменклатуры` from `Товар.mapped_name` / `Товар.original_name` and calls `НайтиИлиСоздатьНоменклатуру(ИмяНоменклатуры)`. It looks like:

```bsl
		// Приоритет: mapped_name (уже сопоставлено на сервере), потом original_name
		ИмяНоменклатуры = "";
		Если Товар.Свойство("mapped_name") И ЗначениеЗаполнено(Товар.mapped_name) Тогда
			ИмяНоменклатуры = Товар.mapped_name;
		ИначеЕсли Товар.Свойство("original_name") И ЗначениеЗаполнено(Товар.original_name) Тогда
			ИмяНоменклатуры = Товар.original_name;
		Иначе
			Продолжить;
		КонецЕсли;

		Номенклатура = НайтиИлиСоздатьНоменклатуру(ИмяНоменклатуры);
```

- [ ] **Step 2: Insert GUID-first lookup before the name-based call**

Replace the `Номенклатура = НайтиИлиСоздатьНоменклатуру(ИмяНоменклатуры);` line with:

```bsl
		Номенклатура = Неопределено;

		// Fast path: onec_guid already set by dashboard — resolve directly
		Если Товар.Свойство("onec_guid") И ЗначениеЗаполнено(Товар.onec_guid) Тогда
			Попытка
				УИД = Новый УникальныйИдентификатор(Товар.onec_guid);
				СсылкаКандидат = Справочники.Номенклатура.ПолучитьСсылку(УИД);
				Если ЗначениеЗаполнено(СсылкаКандидат) И НЕ СсылкаКандидат.ЭтоГруппа Тогда
					Номенклатура = СсылкаКандидат;
				КонецЕсли;
			Исключение
				// Invalid GUID string — fall through to name lookup
			КонецПопытки;
		КонецЕсли;

		// Fallback: name-based lookup
		Если НЕ ЗначениеЗаполнено(Номенклатура) Тогда
			Номенклатура = НайтиИлиСоздатьНоменклатуру(ИмяНоменклатуры);
		КонецЕсли;
```

- [ ] **Step 3: Commit**

```bash
git add 1c/КНД_ЗагрузкаНакладныхСканер/КНД_ЗагрузкаНакладныхСканер/Ext/ObjectModule.bsl
git commit -m "1С BSL: GUID-first resolution in СоздатьПриходнуюНакладную"
```

---

## Task 17: Final regression + deploy

**Files:** none (verification only)

- [ ] **Step 1: Run all test scripts**

```bash
cd c:/www/1C-JPGExchange
npx ts-node src/scripts/test-onec-nomenclature.ts
npx ts-node src/scripts/test-nomenclature-mapper.ts
npx ts-node src/scripts/test-invoice-number-normalization.ts
npx ts-node src/scripts/test-position-parser.ts
npx ts-node src/scripts/test-delete-invoice.ts
```

Expected: every script ends with `Results: N passed, 0 failed`.

- [ ] **Step 2: Run TypeScript check across the entire project**

```bash
cd c:/www/1C-JPGExchange && npx tsc --noEmit
```

Expected: exit code 0, no output.

- [ ] **Step 3: Start the dev server once to verify boot + migrations**

```bash
cd c:/www/1C-JPGExchange && timeout 10 npx ts-node src/index.ts 2>&1 | tail -30
```

Expected: contains `Database migrations completed`, `API server listening on port 3000`, and no error stack traces.

- [ ] **Step 4: Run the API integration test against local**

Start `npm run dev` in a separate terminal, then:

```bash
cd c:/www/1C-JPGExchange && BASE_URL=http://localhost:3000 API_KEY=your-secret-api-key npx ts-node src/scripts/test-nomenclature-sync-api.ts
```

Expected: `Results: N passed, 0 failed`. Stop the dev server.

- [ ] **Step 5: Push to main (GitHub Actions will deploy automatically)**

```bash
cd c:/www/1C-JPGExchange && git push origin main
```

Wait ~40 seconds for deploy to finish.

- [ ] **Step 6: Smoke test production**

```bash
curl -s https://scan.magday.ru/health
echo
# Check that the new sync endpoint is mounted (will 400 on empty body)
curl -s -X POST -H "X-API-Key: your-secret-api-key" -H "Content-Type: application/json" -d '{}' https://scan.magday.ru/api/nomenclature/sync
echo
# Stats should work
curl -s -H "X-API-Key: your-secret-api-key" https://scan.magday.ru/api/nomenclature/stats
```

Expected:
- `/health` → `{"status":"ok",...}`
- `/api/nomenclature/sync` with empty body → `{"error":"items must be a non-empty array"}`
- `/api/nomenclature/stats` → `{"data":{"total":0,"folders":0,"items":0,"last_synced_at":null}}` (or whatever current state)

- [ ] **Step 7: User-side verification (hand off instructions to user)**

Tell the user:

> Backend is deployed. Next steps on your side:
>
> 1. Rebuild `.epf` from the updated BSL:
>    - Open Configurator → open the existing `.epf` via `Файл → Открыть`
>    - Replace modules: `ObjectModule.bsl`, `Form.xml`, `Form/Module.bsl`
>    - Save as `.epf` (overwrite)
>    - In УНФ: `Дополнительные отчёты и обработки` → карточка обработки → **Обновить из файла**
>
> 2. Click the new command **"Выгрузить номенклатуру"** — it will sync the entire `Справочник.Номенклатура` to scan.magday.ru. Wait for the report modal showing "Выгружено N позиций".
>
> 3. Open [scan.magday.ru/#/mappings](http://scan.magday.ru/#/mappings) — you should see "Справочник из 1С: N товаров".
>
> 4. Open any invoice that has `processed` status — in the "Название (1С)" column each row should now be an autocomplete. Items that auto-matched will be green. For red rows, type to search and click to pick the right 1C item.
>
> 5. Once all rows are green, click **"Отправить в 1С"** → 1С will pick it up via the existing "Загрузить накладные" command, with the correct Номенклатура resolved via GUID.

- [ ] **Step 8: Mark plan complete**

```bash
echo "Nomenclature mapping feature complete, commit $(git rev-parse --short HEAD)"
```

---

## Self-review

**1. Spec coverage** — walking the spec:

- ✅ Migration v6 (`onec_nomenclature`): Task 1
- ✅ Migration v7 (`onec_guid` on mappings + invoice_items, stats columns): Task 2
- ✅ Migration v8 (`mapping_supplier_usage`): Task 3
- ✅ `onecNomenclatureRepo` with bulk upsert: Task 4
- ✅ `mappingRepo.recordUsage`, `getAllFiltered`, `getSupplierList`, `getUnmappedCount`: Task 5
- ✅ `invoiceRepo.mapItem`, `addItem` with `onec_guid`: Task 6
- ✅ `NomenclatureMapper` with learned → onec_fuzzy → none: Task 7
- ✅ `POST /api/nomenclature/sync`, `GET /api/nomenclature`, `/stats`, `/suppliers`: Task 8
- ✅ `PUT /api/invoices/:invoiceId/items/:itemId/map` with learning: Task 9
- ✅ `/api/mappings` supplier + unmapped filters, accept `onec_guid`: Task 10
- ✅ `fileWatcher` passes `onec_guid` + records usage: Task 11
- ✅ `OnecCatalog` client helper with Fuse.js: Task 12
- ✅ Invoice detail autocomplete + "Отправить в 1С" gating: Task 13
- ✅ Mappings tab mode toggle + supplier sidebar: Task 14
- ✅ BSL "Выгрузить номенклатуру" command: Task 15
- ✅ BSL GUID-first resolution: Task 16
- ✅ Regression + deploy: Task 17

**2. Placeholder scan** — no TODOs, no "similar to task N", no "add appropriate error handling". All code blocks are concrete.

**3. Type consistency** —

- `MappingResult` shape (Task 7) includes `onec_guid`, `mapping_id`, `source` — consumers in Task 11 (`fileWatcher`) use `mapping.onec_guid` and `mapping.mapping_id`. Matches.
- `OnecCatalog.search()` returns `{ guid, name, ... }` — consumers in Tasks 13/14 call with `r.guid`, `r.name`. Matches.
- `onec_guid` vs `onecGuid` — spec and code consistently use `onec_guid` (snake) in JSON/SQL and `onecGuid` (camel) only as local TS variable. Checked: Task 6 uses `onecGuid` as parameter name, returns JSON with `onec_guid`. Task 9 reads `onec_guid` from body. Matches.
- `mapping_supplier_usage` PK: `(mapping_id, supplier)`. Task 5 `recordUsage` uses `ON CONFLICT(mapping_id, supplier)`. Matches.

No issues found.
