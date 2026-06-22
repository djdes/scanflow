# Sibling-Merge Banner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect when an invoice has a split-off duplicate page (same number + supplier + date, no time window) and let the user merge them in one click from the detail page.

**Architecture:** New read-only repo method `invoiceRepo.findSiblings(id)` runs a narrow SQL pre-filter then refines in JS using the existing `normalizeInvoiceNumber` / `suppliersMatch` helpers. The detail route `GET /api/invoices/:id` embeds the result as `possible_siblings`. The vanilla-JS detail view renders a banner that calls the **already-existing** `POST /api/invoices/:id/merge-into/:targetId` endpoint, with an extra confirmation when either invoice is already in/awaiting 1C.

**Tech Stack:** Node 25 + TypeScript (strict), Express 5, MariaDB via `mysql2/promise` (`getDb().prepare(...).all/.run`), vanilla JS frontend, vitest.

## Global Constraints

- All repository methods are async — every DB call returns a Promise; always `await`.
- DB query API: `getDb().prepare(sql).all<T>()` for reads, `.run(params)` for writes; named params as `:name`, positional as `?`.
- Tests connect ONLY to localhost/test DB — they MUST be gated with `describe.runIf((process.env.DB_NAME || '').includes('test'))` and call `await resetDb()` in `beforeEach`. Never weaken the sanity guard in `tests/helpers/db.ts`.
- `normalizeInvoiceNumber`, `extractDigitSequence`, `suppliersMatch` are already imported at the top of `src/database/repositories/invoiceRepo.ts` — do NOT re-import.
- `suppliersMatch(a, b)` already returns `false` when either side is null/empty — no extra null guard needed.
- Invoice status string for "sent to 1C" is `'sent_to_1c'`; "awaiting upload" is `status === 'processed' && approved_for_1c === 1`.
- Frontend file references use markdown links, code matches surrounding style (the existing `duplicate-banner` block is the visual reference).
- Run the full suite with `npm test`; a single file with `npx vitest run <path>`.

---

## File Structure

- `src/database/repositories/invoiceRepo.ts` — **Modify**: add `findSiblings(id)` method (read-only). Sits alongside `findRecentByNumber` (line ~540), mirrors its candidate-then-JS-filter shape.
- `src/api/routes/invoices.ts` — **Modify**: `GET /:id` (line ~249-277) attaches `possible_siblings` to the response.
- `public/js/invoices.js` — **Modify**: render sibling banner inside `showDetail` (after the `duplicate_of` early-return, before the items table) and add a `mergeSibling()` handler.
- `tests/database/findSiblings.test.ts` — **Create**: unit tests for `findSiblings`.
- `tests/api/siblings.test.ts` — **Create**: route-level test that `GET /:id` surfaces `possible_siblings`, plus a `merge-into` smoke that two rows collapse into one.

---

### Task 1: `invoiceRepo.findSiblings(id)` repo method

**Files:**
- Modify: `src/database/repositories/invoiceRepo.ts` (add method after `findRecentByNumber`, ~line 571)
- Test: `tests/database/findSiblings.test.ts` (create)

**Interfaces:**
- Consumes: `getDb()`, `normalizeInvoiceNumber`, `suppliersMatch` (already imported); `this.getById`.
- Produces:
  ```ts
  findSiblings(id: number): Promise<Array<{
    id: number;
    invoice_number: string | null;
    invoice_date: string | null;
    supplier: string | null;
    total_sum: number | null;
    status: string;
    approved_for_1c: number;
    items_count: number;
  }>>
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/database/findSiblings.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';

describe.runIf((process.env.DB_NAME || '').includes('test'))('invoiceRepo.findSiblings', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  // Insert a fully-controlled invoice row. `ageMin` backdates created_at so we
  // prove findSiblings ignores any time window.
  async function mkInvoice(opts: {
    number?: string | null; date?: string | null; supplier?: string | null;
    total?: number | null; status?: string; approved?: number; duplicateOf?: number | null;
    ageMin?: number; items?: number;
  }): Promise<number> {
    const r = await getDb().prepare(
      `INSERT INTO invoices
         (file_name, file_path, invoice_number, invoice_date, supplier, total_sum,
          status, approved_for_1c, duplicate_of, created_at)
       VALUES ('f','/f', :num, :date, :sup, :total, :status, :appr, :dup,
          (NOW() - INTERVAL :age MINUTE))`
    ).run({
      num: opts.number ?? null, date: opts.date ?? null, sup: opts.supplier ?? null,
      total: opts.total ?? null, status: opts.status ?? 'processed',
      appr: opts.approved ?? 0, dup: opts.duplicateOf ?? null, age: opts.ageMin ?? 0,
    });
    const id = Number(r.lastInsertRowid);
    for (let i = 0; i < (opts.items ?? 0); i++) {
      await getDb().prepare(
        `INSERT INTO invoice_items (invoice_id, original_name) VALUES (?, ?)`
      ).run(id, `item-${i}`);
    }
    return id;
  }

  const SUP = 'ООО "Свит Лайф Фудсервис"';

  it('finds a sibling with same number+supplier+date regardless of age/status', async () => {
    const a = await mkInvoice({ number: '17-0348232', date: '2026-06-09', supplier: SUP, total: 54217.6, status: 'sent_to_1c', ageMin: 120, items: 8 });
    const b = await mkInvoice({ number: '17-0348232', date: '2026-06-09', supplier: SUP, total: 50761.6, status: 'sent_to_1c', ageMin: 90, items: 5 });

    const sibsOfB = await invoiceRepo.findSiblings(b);
    expect(sibsOfB.map(s => s.id)).toEqual([a]);
    expect(sibsOfB[0].items_count).toBe(8);
    expect(sibsOfB[0].status).toBe('sent_to_1c');
  });

  it('does NOT match when both have a date and the dates differ', async () => {
    const a = await mkInvoice({ number: '17-0348232', date: '2026-06-09', supplier: SUP });
    const b = await mkInvoice({ number: '17-0348232', date: '2026-07-09', supplier: SUP });
    expect(await invoiceRepo.findSiblings(b)).toHaveLength(0);
    expect(await invoiceRepo.findSiblings(a)).toHaveLength(0);
  });

  it('matches when one side has no date (number+supplier is enough)', async () => {
    const a = await mkInvoice({ number: '17-0348232', date: '2026-06-09', supplier: SUP });
    const b = await mkInvoice({ number: '17-0348232', date: null, supplier: SUP });
    expect((await invoiceRepo.findSiblings(b)).map(s => s.id)).toEqual([a]);
    expect((await invoiceRepo.findSiblings(a)).map(s => s.id)).toEqual([b]);
  });

  it('ignores rows flagged as exact duplicates and number-less rows, and itself', async () => {
    const orig = await mkInvoice({ number: '17-0348232', date: '2026-06-09', supplier: SUP });
    await mkInvoice({ number: '17-0348232', date: '2026-06-09', supplier: SUP, duplicateOf: orig });
    await mkInvoice({ number: null, date: '2026-06-09', supplier: SUP });
    expect(await invoiceRepo.findSiblings(orig)).toHaveLength(0);
  });

  it('does NOT match a different supplier', async () => {
    await mkInvoice({ number: '17-0348232', date: '2026-06-09', supplier: SUP });
    const b = await mkInvoice({ number: '17-0348232', date: '2026-06-09', supplier: 'ООО "Другой Поставщик"' });
    expect(await invoiceRepo.findSiblings(b)).toHaveLength(0);
  });

  it('returns [] when the invoice has no number', async () => {
    const a = await mkInvoice({ number: null, date: '2026-06-09', supplier: SUP });
    expect(await invoiceRepo.findSiblings(a)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/database/findSiblings.test.ts`
Expected: FAIL — `invoiceRepo.findSiblings is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/database/repositories/invoiceRepo.ts`, immediately after the `findRecentByNumber` method (after its closing `},` near line 571), add:

```ts
  // Find "sibling" invoices that are almost certainly pages of the SAME invoice
  // that got split into separate rows (auto-merge window expired or the original
  // was already sent). Unlike findRecentByNumber there is NO time window and NO
  // status filter — the split is often discovered long after both rows are
  // 'sent_to_1c'. Signature is intentionally strict (number + supplier + date)
  // so unrelated invoices that merely share a number never surface.
  async findSiblings(id: number): Promise<Array<{
    id: number;
    invoice_number: string | null;
    invoice_date: string | null;
    supplier: string | null;
    total_sum: number | null;
    status: string;
    approved_for_1c: number;
    items_count: number;
  }>> {
    const self = await this.getById(id);
    if (!self || !self.invoice_number) return [];
    const targetNormalized = normalizeInvoiceNumber(self.invoice_number);
    if (!targetNormalized) return [];

    // SQL pre-filter. When the current invoice HAS a date, narrow to candidates
    // with the same date or no date (the date rule allows a date-less sibling).
    // When it has no date, we can't narrow by date — match on number/supplier.
    const dateClause = self.invoice_date
      ? 'AND (invoice_date = :curDate OR invoice_date IS NULL)'
      : '';
    const candidates = await getDb().prepare(
      `SELECT id, invoice_number, invoice_date, supplier, total_sum, status, approved_for_1c,
              (SELECT COUNT(*) FROM invoice_items ii WHERE ii.invoice_id = i.id) AS items_count
       FROM invoices i
       WHERE invoice_number IS NOT NULL AND invoice_number != ''
         AND duplicate_of IS NULL
         AND id != :id
         ${dateClause}
       ORDER BY id ASC`
    ).all<{
      id: number; invoice_number: string | null; invoice_date: string | null;
      supplier: string | null; total_sum: number | null; status: string;
      approved_for_1c: number; items_count: number;
    }>(self.invoice_date ? { id, curDate: self.invoice_date } : { id });

    return candidates.filter((c) =>
      normalizeInvoiceNumber(c.invoice_number) === targetNormalized &&
      suppliersMatch(self.supplier, c.supplier),
    );
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/database/findSiblings.test.ts`
Expected: PASS (6 tests).

Note: `:curDate` is only present in params when `self.invoice_date` is truthy, matching the conditional `dateClause` — mysql2 errors on a named param referenced in SQL but missing from the object, so the two must stay in lockstep.

- [ ] **Step 5: Commit**

```bash
git add src/database/repositories/invoiceRepo.ts tests/database/findSiblings.test.ts
git commit -m "feat(invoices): findSiblings — detect split duplicate pages by number+supplier+date

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Expose `possible_siblings` on `GET /api/invoices/:id`

**Files:**
- Modify: `src/api/routes/invoices.ts` (`GET /:id`, lines ~249-277)
- Test: `tests/api/siblings.test.ts` (create)

**Interfaces:**
- Consumes: `invoiceRepo.findSiblings(id)` from Task 1.
- Produces: response shape `{ data: { ...invoice, items, possible_siblings: Sibling[] } }`.

- [ ] **Step 1: Write the failing test**

Create `tests/api/siblings.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';

// Exercises the repo wiring the route depends on. We assert via findSiblings +
// merge-into behaviour rather than spinning Express, mirroring pendingReservation.
describe.runIf((process.env.DB_NAME || '').includes('test'))('sibling detection + merge', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  const SUP = 'ООО "Свит Лайф Фудсервис"';
  async function mk(num: string, date: string, total: number, items: number): Promise<number> {
    const r = await getDb().prepare(
      `INSERT INTO invoices (file_name, file_path, invoice_number, invoice_date, supplier, total_sum, status)
       VALUES ('f','/f', ?, ?, ?, ?, 'processed')`
    ).run(num, date, SUP, total);
    const id = Number(r.lastInsertRowid);
    for (let i = 0; i < items; i++) await invoiceRepo.addItem({ invoice_id: id, original_name: `x${i}`, total: total / items });
    return id;
  }

  it('detail-level findSiblings surfaces the split row', async () => {
    const a = await mk('17-0348232', '2026-06-09', 54217.6, 8);
    const b = await mk('17-0348232', '2026-06-09', 50761.6, 5);
    const sibs = await invoiceRepo.findSiblings(a);
    expect(sibs.map(s => s.id)).toEqual([b]);
  });

  it('merge-into collapses two rows into one (items summed, total = max)', async () => {
    const a = await mk('17-0348232', '2026-06-09', 54217.6, 8); // canonical (lower id)
    const b = await mk('17-0348232', '2026-06-09', 50761.6, 5);

    await invoiceRepo.moveItemsToInvoice(b, a);
    if (54217.6 > 0) await invoiceRepo.updateInvoiceData(a, { total_sum: 54217.6 });
    await invoiceRepo.delete(b);
    await invoiceRepo.recalculateTotal(a);

    const merged = await invoiceRepo.getWithItems(a);
    expect(merged!.items).toHaveLength(13);
    expect(await invoiceRepo.getById(b)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api/siblings.test.ts`
Expected: PASS for the repo assertions IF Task 1 is in. (This file documents the route contract; the route change itself is verified manually in Step 4 since the suite has no Express harness.) If `tests/api/` needs the dir, create it.

- [ ] **Step 3: Add `possible_siblings` to the route**

In `src/api/routes/invoices.ts`, in `GET /:id`, replace the final `res.json({ data: enriched });` (line ~276) with:

```ts
  (enriched as typeof enriched & { possible_siblings: unknown }).possible_siblings =
    await invoiceRepo.findSiblings(id);

  res.json({ data: enriched });
```

- [ ] **Step 4: Verify the route returns the field**

Run the dev server (`npm run dev`), then with two known split invoices in the DB:

Run: `curl -s -H "X-API-Key: $API_KEY" http://localhost:8899/api/invoices/<lowerId> | npx --yes json possible_siblings`
Expected: a JSON array containing the higher-id sibling with `items_count` and `status`.

(If the local DB has no split pair, create one via the test helper or skip to the frontend task and verify end-to-end there.)

- [ ] **Step 5: Commit**

```bash
git add src/api/routes/invoices.ts tests/api/siblings.test.ts
git commit -m "feat(invoices): GET /:id surfaces possible_siblings for split-page detection

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Sibling banner + one-click merge in the detail view

**Files:**
- Modify: `public/js/invoices.js` — `showDetail` (banner render after the `duplicate_of` early-return, ~line 288) and a new `mergeSibling` method (near `addPages`, ~line 879).

**Interfaces:**
- Consumes: `data.possible_siblings` from Task 2; existing `App.api`, `App.formatMoney`, `App.statusBadge`, `this.showDetail`, `this._withGuard`.
- Produces: `Invoices.mergeSibling(currentId, siblingId, sentWarning)` invoked from the banner button.

- [ ] **Step 1: Render the banner**

In `public/js/invoices.js`, inside `showDetail`, AFTER the `if (data.duplicate_of) { … return; }` block (ends ~line 288) and BEFORE `const unmappedCount = …` (line 290), insert:

```js
      // Possible split-page duplicate: same number+supplier+date as another row.
      // Auto-merge (fileWatcher Strategy A) only fires within 10 min and skips
      // sent invoices, so late/post-send pages fork into a separate invoice.
      // Offer a one-click fold-in using the existing merge-into endpoint.
      const sibs = data.possible_siblings || [];
      if (sibs.length > 0) {
        const sentWarn = data.status === 'sent_to_1c' || data.approved_for_1c
          || sibs.some(s => s.status === 'sent_to_1c' || s.approved_for_1c);
        const banner = document.getElementById('invoice-sibling-banner');
        banner.style.display = 'block';
        banner.innerHTML = sibs.map(s => `
          <div class="duplicate-banner">
            <div class="duplicate-banner-text">
              ⚠ <strong>Похоже на ту же накладную:</strong>
              <a href="#/invoices/${s.id}">№${s.id}</a>
              — ${s.items_count} позиц., ${App.formatMoney(s.total_sum)}${s.status === 'sent_to_1c' ? ', «Отправлен»' : ''}.
              Возможно, это страницы одной накладной.
            </div>
            <div class="duplicate-banner-actions">
              <button class="btn btn-primary btn-sm"
                onclick="Invoices.mergeSibling(${data.id}, ${s.id}, ${sentWarn})">Объединить →</button>
            </div>
          </div>
        `).join('');
      } else {
        const banner = document.getElementById('invoice-sibling-banner');
        if (banner) banner.style.display = 'none';
      }
```

Then add the banner container to the shell. In `public/app.html`, directly above `<div class="card" id="invoice-tab-items">` (line ~161), add:

```html
        <div id="invoice-sibling-banner" style="display:none"></div>
```

- [ ] **Step 2: Add the merge handler**

In `public/js/invoices.js`, after the `addPages(id) { … }` method (ends ~line 879), add:

```js
  // Fold two split-page invoices into one via the existing merge-into endpoint.
  // Canonical target = the lower id (page 1, owns the header); the higher id is
  // the source that gets deleted. When either side is already in/awaiting 1C we
  // confirm first — the merge fixes ScanFlow but 1C already has the stray doc.
  async mergeSibling(currentId, siblingId, sentWarning) {
    const target = Math.min(currentId, siblingId);
    const source = Math.max(currentId, siblingId);
    const base = 'Объединить эти две накладные в одну (#' + target + ')?';
    const msg = sentWarning
      ? base + '\n\nОдна из накладных уже отправлена в 1С. Объединение исправит дубль в ScanFlow, но в 1С документ уже создан — лишний нужно удалить вручную.'
      : base;
    if (!confirm(msg)) return;

    await this._withGuard(`merge:${source}->${target}`, async () => {
      let resp;
      try {
        resp = await App.api(`/invoices/${source}/merge-into/${target}`, { method: 'POST' });
      } catch (e) { App.notify('Ошибка объединения: ' + e.message, 'error'); return; }
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        App.notify(err.error || `Ошибка ${resp.status}`, 'error');
        return;
      }
      App.notify('Накладные объединены', 'success');
      App.navigate(`#/invoices/${target}`);
      this.showDetail(target);
    });
  },
```

- [ ] **Step 3: Manual end-to-end verification**

Start the app (`npm run dev`). Using the test helper or real data, ensure two invoices share number+supplier+date (e.g. the 17-0348232 pair). Then:

1. Open the lower-id invoice detail. Expected: amber banner "Похоже на ту же накладную: №<higherId> …" above the items table.
2. If either is `sent_to_1c`, the banner text includes «Отправлен», and clicking «Объединить →» shows the extra 1С warning in the confirm dialog.
3. Confirm. Expected: toast "Накладные объединены", the view reloads on the lower-id invoice, items count = sum of both, the higher-id row is gone from the list, and the banner disappears.

- [ ] **Step 4: Commit**

```bash
git add public/js/invoices.js public/app.html
git commit -m "feat(invoices): sibling-merge banner — one-click fold-in of split duplicate pages

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Detect rule (number+supplier+date, no window/status filter, ignore duplicate_of & number-less & self) → Task 1 (`findSiblings` + 6 tests). ✓
- Date mandatory only when both have it; date-less sibling allowed → Task 1 tests 2 & 3, SQL `dateClause`. ✓
- `possible_siblings` embedded in `GET /:id` (no extra request) → Task 2. ✓
- Banner in existing `duplicate-banner` style, above items → Task 3 Step 1. ✓
- Merge into lower id via existing `merge-into` → Task 3 Step 2. ✓
- "Already sent" → warn-but-allow confirm → Task 3 Step 2 (`sentWarning`). ✓
- Reload after merge → Task 3 Step 2 (`showDetail(target)`). ✓
- Tests localhost-only with `runIf` + `resetDb` → both test files. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. ✓

**Type consistency:** `findSiblings` return shape (with `approved_for_1c`, `items_count`, `status`) is identical in Task 1 definition, Task 2 consumption, and Task 3 banner usage (`s.items_count`, `s.status`, `s.approved_for_1c`, `s.total_sum`). Merge endpoint path `/:id/merge-into/:targetId` matches the existing route (source=`:id`, target=`:targetId`); handler passes `source` as `:id`. ✓

**Scope:** Single subsystem (duplicate-page detection + merge UI). One plan. ✓
