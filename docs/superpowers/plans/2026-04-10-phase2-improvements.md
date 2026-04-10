# Phase 2 Improvements — Hygiene + Observability + UX

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Clean up the repo, prevent disk fill-up, make the dashboard respond under load, and add operational observability so problems surface before users notice.

**Architecture:** Four independent phases by risk level — (A) safe cleanup and hygiene, (B) observability for disk/queue/DB, (C) UX polish, (D) smarter mapping workflows. Each phase is independently shippable.

**Tech Stack:** Same as production — TypeScript, Express, winston, vanilla JS, node-cron

---

## What's NOT in this plan (deferred)

- **processFile monolith refactor** — high risk, touches the hottest path, defer until we have more test coverage
- **recalculateTotal double-bookkeeping** — needs product discussion on which total is truth
- **Supplier-specific mapping precedence** — new feature, not cleanup
- **Multi-page Claude re-billing optimization** — nice-to-have, not broken
- **Undo auto-mappings** — new feature, separate spec

---

## PHASE A — Hygiene & Cleanup

### Task 1: Delete dead code and temp files

**Files:**
- Delete: `src/ocr/claudeCodeBridge.ts` (dead — CLI can't read images)
- Delete: `src/ocr/claudeTextAnalyzer.ts` (dead — superseded by claudeApiAnalyzer)
- Delete: `temp_*.json` files in repo root (10+ scratch files)
- Delete: `eng.traineddata`, `rus.traineddata` (10+ MB Tesseract data)
- Modify: `src/ocr/ocrManager.ts` — remove imports of deleted modules

- [ ] **Step 1: Verify nothing imports claudeCodeBridge or claudeTextAnalyzer**

```bash
cd c:/www/1C-JPGExchange
grep -r "claudeCodeBridge\|claudeTextAnalyzer" src/ --include="*.ts"
```

Expected: only lines inside the two files themselves, plus imports in `ocrManager.ts`. Nothing in active code paths.

- [ ] **Step 2: Remove imports from ocrManager.ts**

Open `src/ocr/ocrManager.ts` and delete the import lines for `claudeCodeBridge` and `claudeTextAnalyzer` at the top. Delete any code paths that reference them (check for `analyzeTextWithClaude` calls — those should be gone since we use `analyzeMultiPageTextWithClaudeApi` now).

- [ ] **Step 3: Delete the dead files**

```bash
rm c:/www/1C-JPGExchange/src/ocr/claudeCodeBridge.ts
rm c:/www/1C-JPGExchange/src/ocr/claudeTextAnalyzer.ts
```

- [ ] **Step 4: Delete temp artifacts in repo root**

```bash
cd c:/www/1C-JPGExchange
rm -f temp_invoice.json cwww1C-JPGExchangetemp_invoice.json eng.traineddata rus.traineddata nul
rm -f architecture.excalidraw architecture.png improvements.excalidraw improvements.png
```

- [ ] **Step 5: Verify compilation**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Run tests**

```bash
npm test
```

Expected: 7 passed.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: remove dead code (claudeCodeBridge, claudeTextAnalyzer) and temp artifacts"
```

---

### Task 2: Winston daily log rotation

**Files:**
- Modify: `package.json` (add winston-daily-rotate-file)
- Modify: `src/utils/logger.ts` (swap File transport)

- [ ] **Step 1: Install**

```bash
cd c:/www/1C-JPGExchange
npm install winston-daily-rotate-file
```

- [ ] **Step 2: Update logger.ts**

Open `src/utils/logger.ts`. Find the `winston.transports.File` entries (there should be 2 — error.log and combined.log). Replace with:

```typescript
import 'winston-daily-rotate-file';

// ... inside createLogger transports array:
new (winston.transports as any).DailyRotateFile({
  filename: 'logs/error-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  level: 'error',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '30d',
}),
new (winston.transports as any).DailyRotateFile({
  filename: 'logs/combined-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '30d',
}),
```

- [ ] **Step 3: Verify compilation**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/utils/logger.ts
git commit -m "feat(logging): daily log rotation with 30-day retention + gzip"
```

---

### Task 3: Photo retention cron

**Files:**
- Create: `src/utils/photoRetention.ts`
- Modify: `src/index.ts` (schedule cron)

- [ ] **Step 1: Create retention helper**

Create `c:\www\1C-JPGExchange\src\utils\photoRetention.ts`:

```typescript
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from './logger';

const RETENTION_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Delete photos in processed/ that are older than RETENTION_DAYS.
 * Does NOT touch the database — old invoices stay, only the source image
 * is gone. If the user needs the photo again, re-upload.
 */
export function cleanupOldPhotos(): { deleted: number; freedMB: number } {
  try {
    if (!fs.existsSync(config.processedDir)) {
      return { deleted: 0, freedMB: 0 };
    }
    const cutoff = Date.now() - (RETENTION_DAYS * MS_PER_DAY);
    const files = fs.readdirSync(config.processedDir);
    let deleted = 0;
    let freedBytes = 0;
    for (const file of files) {
      const filePath = path.join(config.processedDir, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          freedBytes += stat.size;
          fs.unlinkSync(filePath);
          deleted++;
        }
      } catch {
        // ignore individual file errors
      }
    }
    const freedMB = Math.round(freedBytes / 1024 / 1024 * 100) / 100;
    if (deleted > 0) {
      logger.info('Photo retention cleanup', { deleted, freedMB, retentionDays: RETENTION_DAYS });
    }
    return { deleted, freedMB };
  } catch (err) {
    logger.error('Photo retention cleanup failed', { error: (err as Error).message });
    return { deleted: 0, freedMB: 0 };
  }
}
```

- [ ] **Step 2: Schedule in index.ts**

In `src/index.ts`, add import:

```typescript
import { cleanupOldPhotos } from './utils/photoRetention';
```

After the existing `cron.schedule('5 3 * * *', ...)` line, add:

```typescript
  // Weekly photo cleanup on Sunday at 03:10 — deletes processed/ files
  // older than 90 days to prevent unbounded disk growth.
  cron.schedule('10 3 * * 0', () => {
    logger.info('Running weekly photo retention cleanup...');
    cleanupOldPhotos();
  });
```

- [ ] **Step 3: Verify compilation**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/utils/photoRetention.ts src/index.ts
git commit -m "feat(cleanup): weekly cron deletes processed photos older than 90 days"
```

---

## PHASE B — Observability

### Task 4: Real health check

**Files:**
- Modify: `src/api/server.ts:40-42`

- [ ] **Step 1: Replace health endpoint**

Find the health route in `src/api/server.ts`:

```typescript
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });
```

Replace with:

```typescript
  app.get('/health', (_req, res) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};
    let allOk = true;

    // DB ping
    try {
      const { getDb } = require('../database/db');
      const db = getDb();
      db.prepare('SELECT 1').get();
      checks.database = { ok: true };
    } catch (e) {
      checks.database = { ok: false, detail: (e as Error).message };
      allOk = false;
    }

    // Google credentials file readable
    try {
      const fs = require('fs');
      if (config.googleCredentials) {
        fs.accessSync(config.googleCredentials, fs.constants.R_OK);
        checks.google_credentials = { ok: true };
      } else {
        checks.google_credentials = { ok: true, detail: 'not configured (claude_api mode)' };
      }
    } catch (e) {
      checks.google_credentials = { ok: false, detail: (e as Error).message };
      // Not fatal — claude_api mode doesn't need Google
    }

    // Anthropic key present
    checks.anthropic_api_key = config.anthropicApiKey
      ? { ok: true }
      : { ok: false, detail: 'ANTHROPIC_API_KEY not set' };
    if (!config.anthropicApiKey) allOk = false;

    // Inbox queue size (alert if stuck)
    try {
      const fs = require('fs');
      const pendingFiles = fs.existsSync(config.inboxDir)
        ? fs.readdirSync(config.inboxDir).filter((f: string) => !f.startsWith('.')).length
        : 0;
      checks.inbox_queue = {
        ok: pendingFiles < 50,
        detail: `${pendingFiles} files pending`,
      };
      if (pendingFiles >= 50) allOk = false;
    } catch (e) {
      checks.inbox_queue = { ok: false, detail: (e as Error).message };
    }

    res.status(allOk ? 200 : 503).json({
      status: allOk ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      checks,
    });
  });
```

- [ ] **Step 2: Verify compilation**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Test locally**

Manually inspect behavior: `GET /health` should return all checks. If you rename `google-credentials.json` it should flag that check red.

- [ ] **Step 4: Commit**

```bash
git add src/api/server.ts
git commit -m "feat(health): real checks — DB ping, credentials, anthropic key, inbox queue"
```

---

### Task 5: Disk space monitoring with email alert

**Files:**
- Create: `src/utils/diskMonitor.ts`
- Modify: `src/index.ts` (schedule cron)

- [ ] **Step 1: Create disk monitor helper**

Create `c:\www\1C-JPGExchange\src\utils\diskMonitor.ts`:

```typescript
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from './logger';
import { sendErrorEmail } from './mailer';

const WARNING_THRESHOLD_GB = 5;

/**
 * Check free disk space on the partition holding the database.
 * Emails an alert if below WARNING_THRESHOLD_GB. Rate-limited via mailer.
 */
export async function checkDiskSpace(): Promise<void> {
  try {
    const dbDir = path.dirname(config.dbPath);
    if (!fs.existsSync(dbDir)) return;

    const stat = fs.statfsSync(dbDir);
    const freeBytes = stat.bavail * stat.bsize;
    const freeGB = freeBytes / 1024 / 1024 / 1024;

    logger.info('Disk space check', { path: dbDir, freeGB: freeGB.toFixed(2) });

    if (freeGB < WARNING_THRESHOLD_GB) {
      const msg = `Free disk space below threshold: ${freeGB.toFixed(2)} GB at ${dbDir}`;
      logger.warn(msg);
      await sendErrorEmail(
        'Мало места на диске',
        `${msg}\n\nПорог: ${WARNING_THRESHOLD_GB} GB\n\nРекомендации:\n- Проверить data/processed/\n- Проверить logs/\n- Проверить data/backups/`
      );
    }
  } catch (err) {
    logger.error('Disk space check failed', { error: (err as Error).message });
  }
}
```

- [ ] **Step 2: Schedule every 6 hours**

In `src/index.ts`:

```typescript
import { checkDiskSpace } from './utils/diskMonitor';

// ... inside main() after existing crons:

  // Disk space check every 6 hours
  cron.schedule('0 */6 * * *', () => {
    checkDiskSpace();
  });

  // Also check once on startup
  checkDiskSpace();
```

- [ ] **Step 3: Verify compilation**

```bash
npx tsc --noEmit
```

Note: `fs.statfsSync` requires Node 18.15+. Our server runs Node 20, so fine.

- [ ] **Step 4: Commit**

```bash
git add src/utils/diskMonitor.ts src/index.ts
git commit -m "feat(observability): disk space monitor with email alert below 5 GB"
```

---

## PHASE C — UX Polish

### Task 6: Loading states in dashboard

**Files:**
- Modify: `public/css/style.css` (add spinner styles)
- Modify: `public/js/invoices.js`, `mappings.js`, `camera.js`

- [ ] **Step 1: Add spinner CSS**

Add at the end of `public/css/style.css`:

```css
/* ========== Loading states ========== */
.loading-overlay {
  position: absolute;
  inset: 0;
  background: rgba(255, 255, 255, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
  pointer-events: none;
}
.spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--border, #e2e8f0);
  border-top-color: var(--primary, #2563eb);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
.is-loading {
  opacity: 0.5;
  pointer-events: none;
}
```

- [ ] **Step 2: Add helper to app.js**

In `public/js/app.js`, add to the `App` object:

```javascript
  showSpinner(containerId) {
    const el = document.getElementById(containerId);
    if (el) el.classList.add('is-loading');
  },

  hideSpinner(containerId) {
    const el = document.getElementById(containerId);
    if (el) el.classList.remove('is-loading');
  },
```

- [ ] **Step 3: Wrap invoice list loading**

In `public/js/invoices.js`, find the `showList` method. Wrap the API call:

```javascript
  async showList() {
    App.showSpinner('view-invoices');
    try {
      // ... existing logic
    } finally {
      App.hideSpinner('view-invoices');
    }
  },
```

Do the same for `showDetail` (wrap around the API call, use `invoice-detail` as the element ID if it exists — otherwise add a wrapper).

- [ ] **Step 4: Commit**

```bash
git add public/css/style.css public/js/app.js public/js/invoices.js
git commit -m "feat(ui): loading spinners on invoice list and detail"
```

---

### Task 7: Accessibility basics

**Files:**
- Modify: `public/index.html`
- Modify: `public/js/invoices.js`

- [ ] **Step 1: Add labels to auth input**

Find the API key input in `index.html` (the login screen) and add a proper label. Example change — find:

```html
<input type="password" id="auth-api-key" placeholder="API-ключ">
```

Replace with:

```html
<label for="auth-api-key" class="sr-only">API-ключ</label>
<input type="password" id="auth-api-key" placeholder="API-ключ" aria-label="API-ключ">
```

- [ ] **Step 2: Add sr-only utility class**

Add to `public/css/style.css`:

```css
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
```

- [ ] **Step 3: aria-live on notifications**

In `public/index.html` find:

```html
<div id="notifications"></div>
```

Replace with:

```html
<div id="notifications" aria-live="polite" aria-atomic="false"></div>
```

- [ ] **Step 4: aria-label on delete buttons**

In `public/js/invoices.js`, find the delete button in `renderList`:

```javascript
<button class="btn-icon-danger" title="Удалить накладную"
        onclick="Invoices.deleteInvoice(${inv.id}, event)">&#10005;</button>
```

Add `aria-label`:

```javascript
<button class="btn-icon-danger" title="Удалить накладную" aria-label="Удалить накладную ${inv.id}"
        onclick="Invoices.deleteInvoice(${inv.id}, event)">&#10005;</button>
```

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/css/style.css public/js/invoices.js
git commit -m "feat(a11y): aria-labels, sr-only class, aria-live on notifications"
```

---

## PHASE D — Smarter Mapping

### Task 8: Batch rematch across all unmapped invoice items

**Files:**
- Modify: `src/api/routes/nomenclature.ts` (add endpoint)
- Modify: `src/database/repositories/invoiceRepo.ts` (add bulk query)
- Modify: `public/js/mappings.js` (add button)
- Modify: `public/index.html` (button in catalog tab)

- [ ] **Step 1: Add method to fetch all unmapped items**

In `src/database/repositories/invoiceRepo.ts`, add near the end of the exported object:

```typescript
  /**
   * All invoice items without an onec_guid, across all invoices in active
   * statuses. Used for bulk re-mapping after catalog sync.
   */
  getAllUnmappedItems(): InvoiceItem[] {
    const db = getDb();
    return db.prepare(
      `SELECT i.* FROM invoice_items i
       JOIN invoices inv ON inv.id = i.invoice_id
       WHERE (i.onec_guid IS NULL OR i.onec_guid = '')
       AND inv.status IN ('processed', 'new')
       ORDER BY i.id`
    ).all() as InvoiceItem[];
  },
```

- [ ] **Step 2: Add rematch-all endpoint**

In `src/api/routes/nomenclature.ts`, add a new route:

```typescript
// POST /api/nomenclature/rematch-all — re-run fuzzy matching on every unmapped
// invoice item, useful after syncing new catalog items from 1C.
router.post('/rematch-all', (_req: Request, res: Response) => {
  const { invoiceRepo } = require('../../database/repositories/invoiceRepo');
  const { NomenclatureMapper } = require('../../mapping/nomenclatureMapper');

  if (!mapper) {
    res.status(500).json({ error: 'Mapper not initialized' });
    return;
  }
  mapper.invalidateCache();

  const items = invoiceRepo.getAllUnmappedItems();
  let matched = 0;
  for (const item of items) {
    const result = mapper.map(item.original_name);
    if (result.onec_guid) {
      invoiceRepo.updateItemMapping(
        item.id,
        result.onec_guid,
        result.mapped_name,
        result.confidence
      );
      matched++;
    }
  }

  logger.info('Bulk rematch completed', { matched, total: items.length });
  res.json({ data: { matched, total: items.length } });
});
```

- [ ] **Step 3: Add button to catalog tab**

In `public/index.html`, find the catalog tab controls near the search input. Add a button:

```html
<button class="btn btn-outline btn-sm" onclick="Mappings.rematchAll()">Пересопоставить все несопоставленные</button>
```

In `public/js/mappings.js`, add the method:

```javascript
  async rematchAll() {
    if (!confirm('Пересопоставить все несопоставленные товары во всех накладных? Это может занять несколько секунд.')) return;
    try {
      const res = await App.api('/nomenclature/rematch-all', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        App.notify(`Сопоставлено: ${data.data.matched} из ${data.data.total}`, 'success');
        this.load();
      } else {
        App.notify('Ошибка', 'error');
      }
    } catch (e) {
      App.notify('Ошибка: ' + e.message, 'error');
    }
  },
```

- [ ] **Step 4: Verify compilation**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(mapping): bulk rematch unmapped items across all invoices"
```

---

### Task 9: OCR confidence surface in invoice list

**Files:**
- Modify: `src/database/repositories/invoiceRepo.ts` (add avg confidence)
- Modify: `public/js/invoices.js` (show warning badge)
- Modify: `public/css/style.css` (warning badge style)

- [ ] **Step 1: Compute avg mapping confidence per invoice**

In `src/database/repositories/invoiceRepo.ts`, find the `listAll` method (or whatever the route uses to fetch the list). After each invoice is loaded, compute:

```typescript
  /**
   * Return all invoices with an added `low_confidence_count` field —
   * number of items with mapping_confidence < 0.7. Used by the list
   * view to flag invoices that need human review.
   */
  listWithLowConfidenceFlag(limit: number, offset: number): Array<Invoice & { low_confidence_count: number }> {
    const db = getDb();
    return db.prepare(
      `SELECT i.*,
              (SELECT COUNT(*) FROM invoice_items it
               WHERE it.invoice_id = i.id
               AND (it.mapping_confidence < 0.7 OR it.onec_guid IS NULL))
              AS low_confidence_count
       FROM invoices i
       ORDER BY i.created_at DESC
       LIMIT ? OFFSET ?`
    ).all(limit, offset) as Array<Invoice & { low_confidence_count: number }>;
  },
```

Replace the existing list query in the invoices route with this one.

- [ ] **Step 2: Display warning badge in list**

In `public/js/invoices.js`, inside the list row template, after the status badge, add:

```javascript
${inv.low_confidence_count > 0
  ? `<span class="badge badge-warn" title="Требует проверки: ${inv.low_confidence_count} товаров">⚠ ${inv.low_confidence_count}</span>`
  : ''}
```

- [ ] **Step 3: Warn badge CSS**

In `public/css/style.css`:

```css
.badge-warn {
  background: #fef3c7;
  color: #92400e;
  border: 1px solid #fbbf24;
  padding: 2px 6px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
}
```

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit && npm test
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(ui): show warning badge on invoices with low-confidence items"
```

---

## Task 10: Deploy & verify

- [ ] **Step 1: Push all phases**

```bash
git push
```

- [ ] **Step 2: Wait for CI (~1 min)**

CI now runs tests. Verify in GitHub Actions that `npm test` passes.

- [ ] **Step 3: Verify new endpoints**

```bash
# Health check with details
curl -s http://scan.magday.ru/health | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d)))"

# Bulk rematch
API_KEY=$(grep '^API_KEY=' .env | cut -d= -f2)
curl -s -X POST http://scan.magday.ru/api/nomenclature/rematch-all -H "X-API-Key: $API_KEY"
```

Expected: health returns all green checks, rematch returns `{matched, total}`.

- [ ] **Step 4: Visual check**

Open scan.magday.ru:
- Invoice list loads with spinner briefly, then table
- Invoices with unmapped items show ⚠ badge
- Catalog tab has "Пересопоставить все несопоставленные" button

---

## Self-Review Checklist

- [x] **All tasks have concrete code** — no TBDs
- [x] **Each phase is independently shippable** — can stop after Phase A and still benefit
- [x] **Risk ordering** — Phase A is zero-risk cleanup, Phase D touches user-facing mapping logic
- [x] **Defers dangerous refactors** — processFile monolith, recalculateTotal — not in this plan
- [x] **Test coverage noted** — Task 10 step 2 verifies CI runs tests
