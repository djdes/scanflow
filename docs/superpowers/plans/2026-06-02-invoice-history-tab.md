# Invoice «История» tab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fourth tab «История» to the invoice detail view showing upload time, source/User-Agent, recognition-finish time, total duration, lifecycle timestamps (1С/Сбер), and a live list of remarks (unmapped items, sum mismatch, elevated prices).

**Architecture:** Three new nullable columns on `invoices` (`recognized_at`, `upload_source`, `upload_user_agent`). `recognized_at` is set once on the first `→ processed` transition via `COALESCE`. Source/UA are captured at `POST /api/upload` and threaded through `FileWatcher.processFile` → `invoiceRepo.create`. The tab is rendered entirely client-side from the data `GET /api/invoices/:id` already returns (remarks derived live); the Sber payment timestamp comes from the existing `/sber-status` endpoint. No new API endpoints, no new tables beyond the three columns.

**Tech Stack:** Node 25 + TypeScript (strict), Express 5, MariaDB (mysql2/promise), vanilla HTML/CSS/JS frontend, Vitest.

**Spec:** [docs/superpowers/specs/2026-06-02-invoice-history-tab-design.md](../specs/2026-06-02-invoice-history-tab-design.md)

---

## Testing reality (read before starting)

This project's DB-backed Vitest suite is currently **dormant** — every test under
`tests/database/` is a `describe.skip` placeholder awaiting the SQLite→MariaDB
async rewrite, and this environment has **no localhost test schema** (the
`tests/helpers/db.ts` guard hard-refuses any non-localhost DB and any `DB_NAME`
without `"test"` — incident 2026-05-26, never disable it). The app's MariaDB is a
shared prod/dev instance at `192.168.33.3`.

Consequence for this plan:
- The **one piece that is genuinely unit-testable without a DB** — upload-source
  inference — is extracted into a pure helper and covered by a **real, runnable**
  Vitest test (Task 3).
- The migration, `recognized_at` behaviour, and the vanilla-JS frontend are
  verified by a **concrete manual procedure** (Task 6) against the running app +
  a SQL check. This matches how the project currently operates (the spec says
  the frontend is "verified manually"). Do **not** add `describe.skip` placeholder
  tests — they add no value.

Run the whole suite with: `npm test` (PowerShell: `npm test`).

---

## File Structure

**Backend (TypeScript):**
- `src/database/migrations.ts` — append migration 31 (Modify).
- `src/database/repositories/invoiceRepo.ts` — `Invoice` + `CreateInvoiceData` types, `create()` INSERT, `updateStatus()` `recognized_at` branch (Modify).
- `src/utils/uploadSource.ts` — pure `inferUploadSource()` helper + `UploadSource` type (Create).
- `src/api/routes/upload.ts` — capture source/UA, pass into `processFile` (Modify).
- `src/watcher/fileWatcher.ts` — `processFile` accepts optional `meta`, passes to `create` (Modify).

**Tests:**
- `tests/utils/uploadSource.test.ts` — unit test for the inference helper (Create, runnable).

**Frontend (vanilla JS/HTML):**
- `public/js/app.js` — `formatDateTime()` + `formatDuration()` helpers (Modify).
- `public/app.html` — «История» tab button + container div (Modify).
- `public/js/invoices.js` — `switchTab()` + `showDetail()` reset, `renderHistory()` + call site (Modify).

---

## Task 1: Migration 31 — three columns on `invoices`

**Files:**
- Modify: `src/database/migrations.ts` (append after the migration with `version: 30`, before the closing `];` of `MIGRATIONS` at ~line 696)

- [ ] **Step 1: Append migration 31**

Insert this object as the last element of the `MIGRATIONS` array (immediately after the `version: 30` object, keeping the trailing comma style):

```typescript
  {
    version: 31,
    name: 'history tab: recognized_at + upload_source + upload_user_agent on invoices',
    detect: async (exec) =>
      (await hasColumn(exec, 'invoices', 'recognized_at')) &&
      (await hasColumn(exec, 'invoices', 'upload_source')) &&
      (await hasColumn(exec, 'invoices', 'upload_user_agent')),
    run: async (exec) => {
      if (!(await hasColumn(exec, 'invoices', 'recognized_at'))) {
        await exec.query(`ALTER TABLE invoices ADD COLUMN recognized_at DATETIME NULL`);
      }
      if (!(await hasColumn(exec, 'invoices', 'upload_source'))) {
        await exec.query(`ALTER TABLE invoices ADD COLUMN upload_source VARCHAR(32) NULL`);
      }
      if (!(await hasColumn(exec, 'invoices', 'upload_user_agent'))) {
        await exec.query(`ALTER TABLE invoices ADD COLUMN upload_user_agent VARCHAR(512) NULL`);
      }
    },
  },
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS (no errors). The migration uses the existing `hasColumn` helper and `Executor` type already in the file.

- [ ] **Step 3: Apply the migration against the dev DB**

The migration runs automatically on app start. Start the app once:

Run: `npm run dev`
Expected log line: `Applying migration { version: 31, name: 'history tab: ...' }` then `Migration applied`. Stop the app (Ctrl-C) after you see it.

- [ ] **Step 4: Verify the columns exist (idempotency check)**

Restart the app a second time.
Expected: NO `Applying migration { version: 31 }` line on the second start (it's recorded in `migration_history`); startup completes cleanly. This proves `detect`/history-skip works.

- [ ] **Step 5: Commit**

```bash
git add src/database/migrations.ts
git commit -m "feat(db): migration 31 — recognized_at + upload_source + upload_user_agent on invoices"
```

---

## Task 2: invoiceRepo — types, create(), recognized_at

**Files:**
- Modify: `src/database/repositories/invoiceRepo.ts`

- [ ] **Step 1: Add the three fields to the `Invoice` interface**

In the `Invoice` interface (ends at ~line 37 with `duplicate_of: number | null;`), add three fields right after `duplicate_of`:

```typescript
  duplicate_of: number | null;
  recognized_at: string | null;
  upload_source: string | null;
  upload_user_agent: string | null;
}
```

- [ ] **Step 2: Add the two optional fields to `CreateInvoiceData`**

In `CreateInvoiceData` (ends at ~line 72 with `file_hash?: string | null;`), add after `file_hash`:

```typescript
  file_hash?: string | null;
  upload_source?: string;
  upload_user_agent?: string | null;
}
```

- [ ] **Step 3: Write the two new columns in `create()`**

In `create()`, update the INSERT statement (~lines 111-113) to include the two columns, and the `.run({...})` payload (~lines 114-132) to bind them. The new INSERT:

```typescript
      const result = await db.prepare(`
        INSERT INTO invoices (file_name, file_path, invoice_number, invoice_date, supplier, invoice_type, supplier_inn, supplier_kpp, supplier_bik, supplier_account, supplier_corr_account, supplier_address, total_sum, vat_sum, raw_text, ocr_engine, file_hash, upload_source, upload_user_agent)
        VALUES (:file_name, :file_path, :invoice_number, :invoice_date, :supplier, :invoice_type, :supplier_inn, :supplier_kpp, :supplier_bik, :supplier_account, :supplier_corr_account, :supplier_address, :total_sum, :vat_sum, :raw_text, :ocr_engine, :file_hash, :upload_source, :upload_user_agent)
      `).run({
        file_name: data.file_name,
        file_path: data.file_path,
        invoice_number: data.invoice_number ?? null,
        invoice_date: data.invoice_date ?? null,
        supplier: data.supplier ?? null,
        invoice_type: data.invoice_type ?? null,
        supplier_inn: data.supplier_inn ?? null,
        supplier_kpp: data.supplier_kpp ?? null,
        supplier_bik: data.supplier_bik ?? null,
        supplier_account: data.supplier_account ?? null,
        supplier_corr_account: data.supplier_corr_account ?? null,
        supplier_address: data.supplier_address ?? null,
        total_sum: data.total_sum ?? null,
        vat_sum: data.vat_sum ?? null,
        raw_text: data.raw_text ?? null,
        ocr_engine: data.ocr_engine ?? null,
        file_hash: data.file_hash ?? null,
        upload_source: data.upload_source ?? null,
        upload_user_agent: data.upload_user_agent ?? null,
      });
```

(Note: `create()` writes `null` when source is omitted; the default of `'inbox'` is applied upstream in `processFile`, Task 4, so the watcher's direct inbox pickups are labelled correctly while keeping `create()` a dumb writer consistent with its other `?? null` fields.)

- [ ] **Step 4: Set `recognized_at` once in `updateStatus()`**

Replace the body of `updateStatus()` (~lines 237-244) with a three-branch version that stamps `recognized_at` on the first `→ processed`:

```typescript
  async updateStatus(id: number, status: string, errorMessage?: string): Promise<void> {
    const db = getDb();
    if (errorMessage) {
      await db.prepare('UPDATE invoices SET status = ?, error_message = ? WHERE id = ?').run(status, errorMessage, id);
    } else if (status === 'processed') {
      // Stamp recognition-finish time the FIRST time the invoice reaches
      // 'processed'. COALESCE preserves the original on later reprocess/rescan,
      // so «Затрачено» (recognized_at − created_at) stays the real OCR time.
      await db.prepare(
        'UPDATE invoices SET status = ?, recognized_at = COALESCE(recognized_at, NOW()) WHERE id = ?'
      ).run(status, id);
    } else {
      await db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run(status, id);
    }
  },
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS. (The `Invoice` type is now satisfied because `getById` does `SELECT *`, which returns the new columns; no call-site needs updating since the new `CreateInvoiceData` fields are optional.)

- [ ] **Step 6: Commit**

```bash
git add src/database/repositories/invoiceRepo.ts
git commit -m "feat(invoiceRepo): persist upload source/UA + stamp recognized_at on first processed"
```

---

## Task 3: Upload-source inference helper (TDD) + route capture + watcher threading

**Files:**
- Create: `src/utils/uploadSource.ts`
- Test: `tests/utils/uploadSource.test.ts`
- Modify: `src/api/routes/upload.ts`
- Modify: `src/watcher/fileWatcher.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/utils/uploadSource.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { inferUploadSource } from '../../src/utils/uploadSource';

describe('inferUploadSource', () => {
  it("returns 'camera' for the mobile camera filename pattern", () => {
    expect(inferUploadSource('photo_1717326000000_abc-12.jpg')).toBe('camera');
    expect(inferUploadSource('photo_42_x.png')).toBe('camera');
  });

  it("returns 'web' for a plain dashboard upload (no filename query)", () => {
    expect(inferUploadSource(undefined)).toBe('web');
    expect(inferUploadSource('')).toBe('web');
  });

  it("returns 'web' for a filename that does not match the camera pattern", () => {
    expect(inferUploadSource('invoice-scan.jpg')).toBe('web');
    expect(inferUploadSource('photo_no_extension')).toBe('web');
    expect(inferUploadSource('photo_abc_def.jpg')).toBe('web'); // first group must be digits
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/utils/uploadSource.test.ts`
Expected: FAIL — `Cannot find module '../../src/utils/uploadSource'` (file not created yet).

- [ ] **Step 3: Write the helper**

Create `src/utils/uploadSource.ts`:

```typescript
// Where an invoice photo came from, recorded for the «История» tab.
//   'web'    — uploaded from the dashboard (POST /api/upload, no filename query)
//   'camera' — mobile camera page (POST /api/upload?filename=photo_<ts>_<id>.<ext>)
//   'inbox'  — dropped straight into data/inbox/ (watcher pickup, no HTTP request)
export type UploadSource = 'web' | 'camera' | 'inbox';

// Same pattern the upload route's multer filename guard uses to accept the
// camera page's custom name (see src/api/routes/upload.ts).
const CAMERA_FILENAME_RE = /^photo_\d+_[\w-]+\.\w+$/;

/**
 * Infer the upload source from the optional `?filename=` query the client sent.
 * The mobile camera page sends a `photo_<ts>_<id>.<ext>` name; the dashboard
 * sends nothing. Inbox pickups never reach this code (no HTTP request).
 */
export function inferUploadSource(filenameQuery: string | undefined | null): UploadSource {
  if (filenameQuery && CAMERA_FILENAME_RE.test(filenameQuery)) return 'camera';
  return 'web';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/utils/uploadSource.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Capture source + UA in the upload route**

In `src/api/routes/upload.ts`:

(a) Add the import near the top with the other imports (after the `logger` import, ~line 6):

```typescript
import { inferUploadSource } from '../../utils/uploadSource';
```

(b) In the `POST /` handler, after the existing `const forceEngine = ...` line (~line 57), add:

```typescript
  const forceEngine = req.query.engine as string | undefined;
  const uploadSource = inferUploadSource(req.query.filename as string | undefined);
  const userAgent = (req.headers['user-agent'] as string | undefined) ?? null;
```

(c) Change the background `processFile` call (~line 70) to pass the meta object:

```typescript
      await fileWatcher.processFile(filePath, fileName, forceEngine, {
        source: uploadSource,
        userAgent,
      });
```

- [ ] **Step 6: Thread `meta` through `processFile`**

In `src/watcher/fileWatcher.ts`:

(a) Add an exported meta type near the top of the file (after the imports, before the class declaration). If unsure where, place it immediately above `export class FileWatcher`:

```typescript
export interface UploadMeta {
  source?: string;
  userAgent?: string | null;
}
```

(b) Change the `processFile` signature (~line 409) to accept the optional meta:

```typescript
  async processFile(filePath: string, fileName: string, forceEngine?: string, meta?: UploadMeta): Promise<number> {
```

(c) In the `invoiceRepo.create({...})` call inside `processFile` (~lines 450-454), add the two fields:

```typescript
      invoice = await invoiceRepo.create({
        file_name: fileName,
        file_path: filePath,
        file_hash: fileHash,
        upload_source: meta?.source ?? 'inbox',
        upload_user_agent: meta?.userAgent ?? null,
      });
```

(The watcher's own `onAdd` handler at ~line 120 calls `processFile(filePath, fileName)` with no `meta` → defaults to `source: 'inbox'`. Leave that call unchanged.)

- [ ] **Step 7: Type-check + full test run**

Run: `npx tsc --noEmit`
Expected: PASS.

Run: `npm test`
Expected: PASS — including the new `uploadSource` test; pre-existing skipped suites remain skipped.

- [ ] **Step 8: Commit**

```bash
git add src/utils/uploadSource.ts tests/utils/uploadSource.test.ts src/api/routes/upload.ts src/watcher/fileWatcher.ts
git commit -m "feat(upload): capture source (web/camera/inbox) + User-Agent per invoice"
```

---

## Task 4: Frontend formatters — `formatDateTime` + `formatDuration`

**Files:**
- Modify: `public/js/app.js`

- [ ] **Step 1: Add the two helpers**

In `public/js/app.js`, immediately after the `formatDate(dateStr) { ... }` method (ends at ~line 252 with `},`), insert:

```javascript
  // Date + time, ru-RU (DD.MM.YYYY, HH:MM). MariaDB returns "YYYY-MM-DD HH:MM:SS"
  // (dateStrings:true) — normalise the space to 'T' so Safari/iOS parses it too.
  formatDateTime(dateStr) {
    if (!dateStr) return '—';
    try {
      const d = new Date(String(dateStr).replace(' ', 'T'));
      if (isNaN(d.getTime())) return dateStr;
      return d.toLocaleString('ru-RU', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    } catch { return dateStr; }
  },

  // Human-friendly elapsed time between two date strings ("42 сек", "1 мин 5 сек").
  // Returns '' when either bound is missing or the delta is negative/non-finite.
  formatDuration(fromStr, toStr) {
    if (!fromStr || !toStr) return '';
    const ms = new Date(String(toStr).replace(' ', 'T')) - new Date(String(fromStr).replace(' ', 'T'));
    if (!isFinite(ms) || ms < 0) return '';
    const sec = Math.round(ms / 1000);
    if (sec < 60) return sec + ' сек';
    const min = Math.floor(sec / 60);
    const rem = sec % 60;
    return rem ? `${min} мин ${rem} сек` : `${min} мин`;
  },
```

- [ ] **Step 2: Smoke-check syntax in the browser console**

There is no JS test harness for `public/`. Start the app (`npm run dev`), open the dashboard, and in the browser devtools console run:

```javascript
App.formatDateTime('2026-06-02 14:31:42')   // → "02.06.2026, 14:31"
App.formatDuration('2026-06-02 14:31:00', '2026-06-02 14:31:42') // → "42 сек"
App.formatDuration('2026-06-02 14:31:00', '2026-06-02 14:32:05') // → "1 мин 5 сек"
App.formatDuration('2026-06-02 14:31:00', null)  // → ""
```

Expected: outputs match the comments above.

- [ ] **Step 3: Commit**

```bash
git add public/js/app.js
git commit -m "feat(ui): add App.formatDateTime + App.formatDuration helpers"
```

---

## Task 5: Frontend — «История» tab markup + render

**Files:**
- Modify: `public/app.html`
- Modify: `public/js/invoices.js`

- [ ] **Step 1: Add the tab button**

In `public/app.html`, in the invoice-detail tab bar (~lines 154-158), add the «История» button after the OCR-текст button:

```html
        <div class="tabs" style="margin-bottom:0">
          <button class="tab-btn active" onclick="Invoices.switchTab('items', this)">Товары</button>
          <button class="tab-btn" onclick="Invoices.switchTab('photos', this)">Фото</button>
          <button class="tab-btn" onclick="Invoices.switchTab('ocr', this)">OCR-текст</button>
          <button class="tab-btn" onclick="Invoices.switchTab('history', this)">История</button>
        </div>
```

- [ ] **Step 2: Add the tab container**

In `public/app.html`, after the `invoice-tab-ocr` card (~line 188 `</div>` closing it, before the `</div>` that closes `#invoice-detail` at ~line 189), add:

```html
        <div class="card" id="invoice-tab-ocr" style="display:none">
          <div class="ocr-text" id="invoice-ocr-text"></div>
        </div>
        <div class="card" id="invoice-tab-history" style="display:none"></div>
```

- [ ] **Step 3: Hide the history tab in `switchTab` and in the `showDetail` reset**

In `public/js/invoices.js`:

(a) In `switchTab()` (~lines 948-950), add the history hide line to the "Hide all tabs" block:

```javascript
    document.getElementById('invoice-tab-items').style.display = 'none';
    document.getElementById('invoice-tab-photos').style.display = 'none';
    document.getElementById('invoice-tab-ocr').style.display = 'none';
    document.getElementById('invoice-tab-history').style.display = 'none';
```

(b) In `showDetail()` reset block (~lines 153-155), add the history hide line:

```javascript
    document.getElementById('invoice-tab-items').style.display = 'block';
    document.getElementById('invoice-tab-photos').style.display = 'none';
    document.getElementById('invoice-tab-ocr').style.display = 'none';
    document.getElementById('invoice-tab-history').style.display = 'none';
```

- [ ] **Step 4: Add the `renderHistory` method**

In `public/js/invoices.js`, add this method right after `_renderPriceBadges(items) { ... }` (ends at ~line 424 with `},`). It reuses the existing `_plural` helper:

```javascript
  // «История» tab: processing/lifecycle timeline + live remarks. Built from the
  // already-loaded invoice `data`; the Sber payment timestamp is fetched lazily.
  async renderHistory(data) {
    const el = document.getElementById('invoice-tab-history');
    if (!el) return;

    const SOURCE_LABELS = {
      web: 'Загрузка с сайта',
      camera: 'Камера телефона',
      inbox: 'Папка-инбокс / автозагрузка',
    };
    const sourceLabel = data.upload_source
      ? (SOURCE_LABELS[data.upload_source] || App.esc(data.upload_source))
      : '—';
    const ua = data.upload_user_agent
      ? `<div class="muted" style="font-size:12px;margin-top:2px;word-break:break-all">${App.esc(data.upload_user_agent)}</div>`
      : '';
    const duration = App.formatDuration(data.created_at, data.recognized_at);

    const field = (label, valueHtml) =>
      `<div class="invoice-field"><div class="field-label">${label}</div><div class="field-value">${valueHtml}</div></div>`;

    const procRows = [
      field('Отправлено', App.formatDateTime(data.created_at)),
      field('Источник', `${sourceLabel}${ua}`),
      field('Распознавание завершено', App.formatDateTime(data.recognized_at)),
    ];
    if (duration) procRows.push(field('Затрачено', duration));
    if (data.approved_at) procRows.push(field('Одобрено для 1С', App.formatDateTime(data.approved_at)));
    if (data.sent_at) procRows.push(field('Отправлено в 1С', App.formatDateTime(data.sent_at)));

    // --- Live remarks ---
    const items = data.items || [];
    const remarks = [];
    if (data.error_message) {
      remarks.push('Ошибка распознавания: ' + App.esc(data.error_message));
    }
    if (data.duplicate_of) {
      remarks.push(`Дубликат накладной <a href="#/invoices/${data.duplicate_of}">№${data.duplicate_of}</a> — позиции в эту запись не сохранялись`);
    }
    const unmapped = items.filter(it => !it.onec_guid);
    if (unmapped.length) {
      const names = unmapped.slice(0, 5)
        .map(it => App.esc(it.original_name || it.mapped_name || '')).join(', ');
      const more = unmapped.length > 5 ? ` и ещё ${unmapped.length - 5}` : '';
      const noun = this._plural(unmapped.length, 'товар', 'товара', 'товаров');
      remarks.push(`Не сопоставлено с 1С: ${unmapped.length} ${noun} — ${names}${more}`);
    }
    if (data.items_total_mismatch) {
      remarks.push('Сумма позиций расходится с суммой документа более чем на 1% — проверьте глазами');
    }
    const overpriced = items.filter(it => it.price_deviation_pct != null && it.price_deviation_pct > 10);
    if (overpriced.length) {
      const top = overpriced
        .slice().sort((a, b) => b.price_deviation_pct - a.price_deviation_pct).slice(0, 3)
        .map(it => `${App.esc(it.mapped_name || it.original_name || '')} (+${Math.round(it.price_deviation_pct)}%)`)
        .join(', ');
      const more = overpriced.length > 3 ? ` и ещё ${overpriced.length - 3}` : '';
      const noun = this._plural(overpriced.length, 'позиция', 'позиции', 'позиций');
      remarks.push(`Цена выше обычной: ${overpriced.length} ${noun} — ${top}${more}`);
    }

    const remarksHtml = remarks.length
      ? '<ul style="margin:0;padding-left:18px;line-height:1.7">' +
          remarks.map(r => `<li>⚠ ${r}</li>`).join('') + '</ul>'
      : '<div class="muted">Замечаний нет ✓</div>';

    el.innerHTML = `
      <h3 style="margin-bottom:12px">Обработка</h3>
      <div class="invoice-header">${procRows.join('')}</div>
      <h3 style="margin:20px 0 12px">Замечания</h3>
      ${remarksHtml}
    `;

    // Lifecycle: Sber payment is stored in a separate table — fetch and append
    // its «создан» timestamp when present. Optional; failure degrades silently.
    try {
      const { payment } = await App.apiJson(`/invoices/${data.id}/sber-status`);
      if (payment && payment.created_at) {
        const header = el.querySelector('.invoice-header');
        if (header) {
          header.insertAdjacentHTML('beforeend',
            field('Платёж в Сбер создан', App.formatDateTime(payment.created_at)));
        }
      }
    } catch { /* sber status optional */ }
  },
```

- [ ] **Step 5: Call `renderHistory` from `showDetail`**

In `public/js/invoices.js`, in `showDetail()`, right after the price-badge calls (~line 380, after `this._renderPriceBadges(data.items || []);` and before the `// OCR text` comment at ~line 382), add:

```javascript
      this._renderPriceWarning(data.items || []);
      this._renderPriceBadges(data.items || []);

      // История tab (fire-and-forget; the Sber row patches in when it resolves)
      this.renderHistory(data);

      // OCR text
      document.getElementById('invoice-ocr-text').textContent = data.raw_text || 'Нет данных';
```

- [ ] **Step 6: Commit**

```bash
git add public/app.html public/js/invoices.js
git commit -m "feat(ui): invoice «История» tab — timeline, lifecycle, live remarks"
```

---

## Task 6: End-to-end manual verification

No code changes — this is the acceptance gate for the DB/frontend pieces that have no automated harness.

- [ ] **Step 1: Restart the app cleanly**

Run: `npm run dev`
Expected: starts on :8899, no migration errors, no TS errors.

- [ ] **Step 2: Verify a fresh dashboard upload records `web` + UA + `recognized_at`**

Upload a JPG via the dashboard. After it finishes processing, open the invoice, click the «История» tab.
Expected:
- «Отправлено» shows a date+time.
- «Источник» shows **Загрузка с сайта** with your browser UA string muted underneath.
- «Распознавание завершено» shows a date+time a few seconds later.
- «Затрачено» shows e.g. «12 сек».

Confirm in SQL (any MySQL client against the dev schema):

```sql
SELECT id, upload_source, recognized_at, LEFT(upload_user_agent,40)
FROM invoices ORDER BY id DESC LIMIT 1;
```
Expected: `upload_source = 'web'`, `recognized_at` non-NULL, UA populated.

- [ ] **Step 3: Verify the camera path records `camera`**

Open `/camera` on a phone (or hit `POST /api/upload?filename=photo_1717326000000_test.jpg` with a multipart file via curl/Postman). Open the resulting invoice → «История».
Expected: «Источник» = **Камера телефона**.

- [ ] **Step 4: Verify remarks render live**

Open an invoice that has unmapped items and/or an overprice flag and/or `items_total_mismatch`.
Expected: the «Замечания» section lists the matching ⚠ lines (unmapped count + names, sum mismatch, elevated-price positions). Map a previously-unmapped item, reopen «История» → that remark count drops (proves it's live, not a snapshot). An invoice with no issues shows «Замечаний нет ✓».

- [ ] **Step 5: Verify rescan does not move `recognized_at`**

Note the `recognized_at` of an invoice, click «🔄 Пересканировать фото», wait for it to finish, reopen «История».
Expected: «Распознавание завершено» is unchanged (the COALESCE guard preserved the original); «Затрачено» is still the original small value.

- [ ] **Step 6: Verify a pre-existing (old) invoice degrades gracefully**

Open an invoice created before this feature.
Expected: «Источник», «Распознавание завершено» show «—»; «Затрачено» row is absent; no JS errors in the console.

- [ ] **Step 7: Verify lifecycle rows**

On an invoice that has been approved for 1С / sent / paid via Сбер, confirm «Одобрено для 1С», «Отправлено в 1С», «Платёж в Сбер создан» rows appear with timestamps.

- [ ] **Step 8: Final full test + type-check**

Run: `npx tsc --noEmit && npm test`
Expected: both PASS; the new `uploadSource` test is green.

---

## Self-review notes (author)

- **Spec coverage:** upload time (Task 5 «Отправлено» ← `created_at`), source+UA (Tasks 1-3, 5), recognition-finish (Tasks 1-2 `recognized_at`, Task 5 row), duration (Task 4 `formatDuration`, Task 5 row), live remarks incl. unmapped/price/sum (Task 5), lifecycle 1С/Сбер (Task 5). All spec sections map to a task.
- **Forward-only** caveat handled by Task 6 Step 6 (old invoices → «—»).
- **Type consistency:** `inferUploadSource`/`UploadSource` (Task 3) ↔ `upload_source` column (Task 1) ↔ `CreateInvoiceData.upload_source` (Task 2) ↔ `meta.source` (Task 3) ↔ `data.upload_source` in `renderHistory` (Task 5) all agree on the `'web'|'camera'|'inbox'` vocabulary. `recognized_at` column (Task 1) ↔ `Invoice.recognized_at` (Task 2) ↔ `data.recognized_at` (Task 5). `formatDateTime`/`formatDuration` (Task 4) called only in Task 5.
- **No placeholders:** every code step shows complete code; commands have expected output.
