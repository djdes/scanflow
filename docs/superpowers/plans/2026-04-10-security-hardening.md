# Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all critical and important security + reliability issues from the 2026-04-10 audit, making the site safe to demo and operate in production.

**Architecture:** Three phases executed in strict order — (1) remove hardcoded secrets and shut down unauthenticated endpoints TODAY, (2) add defensive middleware (rate limit, helmet, input escaping, Claude retry), (3) refactor fileWatcher into testable units + add vitest with a minimal CI step.

**Tech Stack:** Node.js, Express, TypeScript, better-sqlite3, helmet, express-rate-limit, vitest

---

## File Structure

**Phase 1 — Emergency (secrets + auth):**
- `src/config.ts` — remove hardcoded API key default
- `src/utils/mailer.ts` — remove hardcoded SMTP defaults
- `src/api/server.ts` — protect `/api/errors` and `/api/reprocess-errors` under `apiKeyAuth`
- `.env.example` — document all required vars
- `.env` — user fills real values (not committed)

**Phase 2 — Hardening:**
- `src/api/server.ts` — add `helmet()` + `express-rate-limit`
- `public/js/app.js` — add central `esc()` helper
- `public/js/invoices.js` — escape all OCR-sourced fields
- `public/js/mappings.js`, `upload.js`, `camera.js` — escape fields
- `src/ocr/claudeApiAnalyzer.ts` — add timeout + retry
- `src/api/middleware/requestLog.ts` — stop DELETE on every request, move to cron
- `src/api/routes/invoices.ts` — single-query `getPending` (N+1 fix)
- `src/database/repositories/invoiceRepo.ts` — add `getPendingWithItems()` join query
- `src/index.ts` — wire up log cleanup cron

**Phase 3 — Tests & refactor:**
- `package.json` — add vitest + helmet + express-rate-limit deps
- `vitest.config.ts` — new, minimal
- `tests/mapping/normalizeName.test.ts` — unit tests for name normalization
- `tests/utils/suppliersMatch.test.ts` — unit tests for supplier matching
- `tests/api/escape.test.ts` — tests for XSS escape helper (if we make it a module)
- `.github/workflows/deploy.yml` — add `npm test` step before rsync
- `src/watcher/fileWatcher.ts` — split `processFile` into smaller methods

---

## PHASE 1 — EMERGENCY FIXES (do first, all critical)

### Task 1: Rotate & Remove Hardcoded Anthropic API Key

**Files:**
- Modify: `src/config.ts:30`
- Modify: `.env` (user-only, not committed)

- [ ] **Step 1: USER ACTION — Rotate the key at console.anthropic.com**

Log in to Anthropic console, go to API keys, revoke the current production key, create a new one. Copy the new value.

- [ ] **Step 2: Update .env on the server (manual, via SSH)**

On scan.magday.ru server, edit `/var/www/magday/data/www/scan.magday.ru/app/.env`:
```
ANTHROPIC_API_KEY=sk-ant-api03-<NEW_ROTATED_KEY>
```

- [ ] **Step 3: Update local .env**

Edit `c:\www\1C-JPGExchange\.env`:
```
ANTHROPIC_API_KEY=sk-ant-api03-<NEW_ROTATED_KEY>
```

- [ ] **Step 4: Remove hardcoded default from config.ts**

Change line 30:

```typescript
// Before:
anthropicApiKey: envStr('ANTHROPIC_API_KEY', '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'),

// After:
anthropicApiKey: envStr('ANTHROPIC_API_KEY', ''),
```

- [ ] **Step 5: Add startup check**

In `src/index.ts`, inside `main()` after `logger.info('Configuration loaded', ...)`, add:

```typescript
// Fail fast if API key is missing — prevents silent fallback to unauthenticated calls
if (!config.anthropicApiKey) {
  logger.error('ANTHROPIC_API_KEY is not set. Refusing to start.');
  process.exit(1);
}
```

- [ ] **Step 6: Verify compilation**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/index.ts
git commit -m "security: remove hardcoded Anthropic API key, fail fast if missing"
```

---

### Task 2: Rotate & Remove Hardcoded SMTP Credentials

**Files:**
- Modify: `src/utils/mailer.ts:4-8`
- Modify: `.env` (user-only)

- [ ] **Step 1: USER ACTION — Rotate SMTP password on wesetup.ru**

Log in to the mail server control panel, change the password for `tech@wesetup.ru`.

- [ ] **Step 2: Update .env on server and local**

Both `.env` files should have:
```
SMTP_HOST=wesetup.ru
SMTP_PORT=587
SMTP_USER=tech@wesetup.ru
SMTP_PASS=<NEW_PASSWORD>
MAIL_TO=bugdenes@gmail.com
```

- [ ] **Step 3: Remove hardcoded defaults**

In `src/utils/mailer.ts` replace lines 4-8:

```typescript
// Before:
const SMTP_HOST = process.env.SMTP_HOST || 'wesetup.ru';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER || 'tech@wesetup.ru';
const SMTP_PASS = process.env.SMTP_PASS || '0M2r8H4t';
const MAIL_TO = process.env.MAIL_TO || 'bugdenes@gmail.com';

// After:
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const MAIL_TO = process.env.MAIL_TO || '';
```

- [ ] **Step 4: Add guard in sendErrorEmail**

At the top of `sendErrorEmail` function, add:

```typescript
export async function sendErrorEmail(subject: string, details: string): Promise<void> {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !MAIL_TO) {
    logger.debug('SMTP not configured, skipping email', { subject });
    return;
  }
  const now = Date.now();
  // ... rest unchanged
```

- [ ] **Step 5: Verify compilation**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/utils/mailer.ts
git commit -m "security: remove hardcoded SMTP credentials, skip email if unconfigured"
```

---

### Task 3: Protect /api/errors and /api/reprocess-errors with Auth

**Files:**
- Modify: `src/api/server.ts:44-93`

- [ ] **Step 1: Move these routes under /api/debug/* which is already protected**

In `src/api/server.ts`, find the two unprotected routes (lines 44-54 and 57-93). Remove them from `server.ts`.

- [ ] **Step 2: Create new file with extracted logic**

These routes access fs and db directly. The cleanest move is into `src/api/routes/debug.ts` which already exists and is mounted under `apiKeyAuth`.

Open `src/api/routes/debug.ts` and add at the end, before `export default router`:

```typescript
// GET /api/debug/errors — last 10 invoices with status='error' (diagnostic)
router.get('/errors', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, file_name, error_message, created_at
     FROM invoices WHERE status = 'error'
     ORDER BY id DESC LIMIT 10`
  ).all();
  res.json({ data: rows });
});

// POST /api/debug/reprocess-errors — re-queue failed invoices for OCR
router.post('/reprocess-errors', async (_req: Request, res: Response) => {
  const fsMod = require('fs');
  const pathMod = require('path');
  const db = getDb();

  const rows = db.prepare(
    `SELECT id, file_name FROM invoices WHERE status = 'error' ORDER BY id DESC LIMIT 10`
  ).all() as Array<{ id: number; file_name: string }>;

  let requeued = 0;
  for (const row of rows) {
    try {
      const failedPath = pathMod.join(process.cwd(), 'data', 'failed', row.file_name);
      const inboxPath = pathMod.join(process.cwd(), 'data', 'inbox', row.file_name);
      if (fsMod.existsSync(failedPath)) {
        fsMod.renameSync(failedPath, inboxPath);
        db.prepare(`UPDATE invoices SET status = 'new', error_message = NULL WHERE id = ?`).run(row.id);
        requeued++;
      }
    } catch (e) {
      logger.warn('reprocess-errors: failed to requeue', { id: row.id, error: (e as Error).message });
    }
  }

  res.json({ data: { requeued, total: rows.length } });
});
```

- [ ] **Step 3: Remove the unprotected routes from server.ts**

In `src/api/server.ts`, delete lines 44-93 (the two `app.get('/api/errors', ...)` and `app.post('/api/reprocess-errors', ...)` blocks).

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/api/server.ts src/api/routes/debug.ts
git commit -m "security: move /errors and /reprocess-errors under authenticated /api/debug"
```

---

### Task 4: Deploy Phase 1

- [ ] **Step 1: Push**

```bash
git push
```

- [ ] **Step 2: Wait for GitHub Actions deploy (~30 sec)**

- [ ] **Step 3: Verify old endpoints return 401**

```bash
curl -sI http://scan.magday.ru/api/errors | head -1
# Expected: HTTP/1.1 404 Not Found  (route is gone)

curl -sI -H "X-API-Key: wrong" http://scan.magday.ru/api/debug/errors | head -1
# Expected: HTTP/1.1 401 Unauthorized
```

- [ ] **Step 4: Verify the new authenticated endpoint works**

```bash
API_KEY=$(grep '^API_KEY=' .env | cut -d= -f2)
curl -s -H "X-API-Key: $API_KEY" http://scan.magday.ru/api/debug/errors
# Expected: JSON with {"data":[...]}
```

---

## PHASE 2 — DEFENSIVE HARDENING

### Task 5: Install helmet + express-rate-limit

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install deps**

```bash
cd c:/www/1C-JPGExchange && npm install helmet express-rate-limit
```

Expected output: `added 2 packages`.

- [ ] **Step 2: Commit lockfile changes**

```bash
git add package.json package-lock.json
git commit -m "deps: add helmet and express-rate-limit"
```

---

### Task 6: Wire helmet + rate limits in server.ts

**Files:**
- Modify: `src/api/server.ts`

- [ ] **Step 1: Import helmet and rate limiter**

At the top of `src/api/server.ts` after existing imports:

```typescript
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
```

- [ ] **Step 2: Add middleware**

Inside `createServer`, after `app.use(cors())` (line ~26), add:

```typescript
// Security headers
app.use(helmet({
  // Allow inline scripts only in dev; production dashboard already uses inline onclick
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// Global rate limit — generous ceiling, catches runaway clients
const globalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300, // 300 req/min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, try again later' },
});
app.use(globalLimiter);

// Stricter limit for uploads — expensive path (disk + Claude API)
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30, // 30 uploads/min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many uploads, slow down' },
});
```

- [ ] **Step 3: Apply uploadLimiter specifically to /api/upload**

Change the existing route mount:

```typescript
// Before:
app.use('/api/upload', apiKeyAuth, uploadRouter);

// After:
app.use('/api/upload', apiKeyAuth, uploadLimiter, uploadRouter);
```

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/api/server.ts
git commit -m "security: add helmet + rate limiting (30/min uploads, 300/min global)"
```

---

### Task 7: Add Central HTML Escape Helper

**Files:**
- Modify: `public/js/app.js`

- [ ] **Step 1: Add esc() to App namespace**

Open `public/js/app.js`, find the `const App = {` object, and add this method near the top:

```javascript
  /**
   * Escape arbitrary text for safe insertion into innerHTML.
   * Use for any value coming from the server — supplier names, OCR text,
   * filenames, error messages. Never bypass this for user-sourced data.
   */
  esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },
```

- [ ] **Step 2: Commit**

```bash
git add public/js/app.js
git commit -m "feat(ui): add App.esc() XSS-safe html escape helper"
```

---

### Task 8: Escape OCR Fields in Invoice List

**Files:**
- Modify: `public/js/invoices.js:72-88`

- [ ] **Step 1: Replace the unescaped tbody.innerHTML block**

Find the block around line 72 and replace with:

```javascript
      tbody.innerHTML = data.map(inv => {
        const fileName = App.esc(inv.file_name || '');
        const fileNameShort = fileName.length > 30 ? fileName.substring(0, 30) + '...' : fileName;
        return `
        <tr class="clickable" onclick="App.navigate('#/invoices/${inv.id}')">
          <td>${inv.id}</td>
          <td title="${fileName}">${fileNameShort}</td>
          <td>${App.esc(inv.invoice_number || '—')}</td>
          <td>${App.formatDate(inv.invoice_date)}</td>
          <td>${App.esc(inv.supplier || '—')}</td>
          <td style="text-align:right">${App.formatMoney(inv.total_sum)}</td>
          <td>${App.ocrEngineBadge(inv.ocr_engine)}</td>
          <td>${App.statusBadge(inv.status)}</td>
          <td>${App.formatDate(inv.created_at)}</td>
          <td style="text-align:center">
            <button class="btn-icon-danger" title="Удалить накладную"
                    onclick="Invoices.deleteInvoice(${inv.id}, event)">&#10005;</button>
          </td>
        </tr>
      `;
      }).join('');
```

- [ ] **Step 2: Commit**

```bash
git add public/js/invoices.js
git commit -m "security(xss): escape OCR fields in invoice list"
```

---

### Task 9: Escape OCR Fields in Invoice Detail

**Files:**
- Modify: `public/js/invoices.js:140-215`

- [ ] **Step 1: Find the header innerHTML block (around line 150) and replace**

Replace the whole `header.innerHTML = \`...\`` block with:

```javascript
      header.innerHTML = `
        <div class="invoice-field">
          <div class="field-label">Номер</div>
          <div class="field-value">${App.esc(data.invoice_number || '—')}</div>
        </div>
        <div class="invoice-field">
          <div class="field-label">Дата</div>
          <div class="field-value">${App.formatDate(data.invoice_date)}</div>
        </div>
        <div class="invoice-field">
          <div class="field-label">Поставщик</div>
          <div class="field-value">${App.esc(data.supplier || '—')}</div>
        </div>
        <div class="invoice-field">
          <div class="field-label">Сумма</div>
          <div class="field-value">${App.formatMoney(data.total_sum)}</div>
        </div>
        <div class="invoice-field">
          <div class="field-label">НДС</div>
          <div class="field-value">${App.formatMoney(data.vat_sum)}</div>
        </div>
        <div class="invoice-field">
          <div class="field-label">OCR</div>
          <div class="field-value">${App.ocrEngineBadge(data.ocr_engine)}</div>
        </div>
        <div class="invoice-field">
          <div class="field-label">Статус</div>
          <div class="field-value">${App.statusBadge(data.status)}</div>
        </div>
        <div class="invoice-field">
          <div class="field-label">Файл</div>
          <div class="field-value">${App.esc(data.file_name || '')}</div>
        </div>
      `;
```

- [ ] **Step 2: Escape banking fields**

Find the `if (data.supplier_inn || ...)` block around line 190 and replace with:

```javascript
      if (data.supplier_inn || data.supplier_bik || data.supplier_account) {
        let html = '<h3 style="margin-bottom:12px">Реквизиты поставщика</h3><div class="invoice-header">';
        if (data.invoice_type) {
          html += `<div class="invoice-field"><div class="field-label">Тип документа</div><div class="field-value">${App.esc(data.invoice_type)}</div></div>`;
        }
        if (data.supplier_inn) {
          html += `<div class="invoice-field"><div class="field-label">ИНН</div><div class="field-value">${App.esc(data.supplier_inn)}</div></div>`;
        }
        if (data.supplier_bik) {
          html += `<div class="invoice-field"><div class="field-label">БИК</div><div class="field-value">${App.esc(data.supplier_bik)}</div></div>`;
        }
        if (data.supplier_account) {
          html += `<div class="invoice-field"><div class="field-label">Расч. счёт</div><div class="field-value">${App.esc(data.supplier_account)}</div></div>`;
        }
        if (data.supplier_corr_account) {
          html += `<div class="invoice-field"><div class="field-label">Корр. счёт</div><div class="field-value">${App.esc(data.supplier_corr_account)}</div></div>`;
        }
        if (data.supplier_address) {
          html += `<div class="invoice-field"><div class="field-label">Адрес</div><div class="field-value">${App.esc(data.supplier_address)}</div></div>`;
        }
        html += '</div>';
        supplierBlock.innerHTML = html;
      } else {
        supplierBlock.innerHTML = '';
      }
```

- [ ] **Step 3: Escape error_message badge**

Find the line with `${data.error_message}` (around line 243) and replace with:

```javascript
        actionsHtml += `<div class="badge badge-error" style="padding:8px 16px">${App.esc(data.error_message)}</div>`;
```

- [ ] **Step 4: Escape items table original_name**

Find where items are rendered in the items table (should be around line 260). Find `${item.original_name}` and replace with `${App.esc(item.original_name)}`. Also escape `${item.mapped_name}` if used in innerHTML.

- [ ] **Step 5: Commit**

```bash
git add public/js/invoices.js
git commit -m "security(xss): escape all OCR fields in invoice detail view"
```

---

### Task 10: Claude API Timeout + Retry

**Files:**
- Modify: `src/ocr/claudeApiAnalyzer.ts`

- [ ] **Step 1: Add retry helper at the top of the file**

After the existing imports in `claudeApiAnalyzer.ts`, add:

```typescript
const CLAUDE_API_TIMEOUT_MS = 90_000; // 90 seconds per request
const CLAUDE_API_MAX_RETRIES = 2;

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= CLAUDE_API_MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e as Error;
      const status = (e as { status?: number }).status;
      // Don't retry on auth / bad request errors
      if (status && status < 500 && status !== 429) {
        throw e;
      }
      if (attempt < CLAUDE_API_MAX_RETRIES) {
        const backoffMs = 1000 * Math.pow(2, attempt);
        logger.warn(`${label}: attempt ${attempt + 1} failed, retrying in ${backoffMs}ms`, {
          error: (e as Error).message,
        });
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
  }
  throw lastError ?? new Error(`${label}: unknown failure`);
}
```

- [ ] **Step 2: Wrap the 3 messages.create calls with withRetry and AbortSignal**

Find each of the three `client.messages.create({ ... })` calls (around lines 87, 158, 211) and wrap them. Example for the first one:

```typescript
// Before:
const response = await client.messages.create({
  model: modelId,
  max_tokens: 8192,
  messages: [ ... ],
});

// After:
const response = await withRetry(
  () => client.messages.create({
    model: modelId,
    max_tokens: 8192,
    messages: [ ... ],
  }, {
    signal: AbortSignal.timeout(CLAUDE_API_TIMEOUT_MS),
  }),
  'Claude API multi-page text'
);
```

Apply the same pattern to the other two call sites with different labels (`'Claude API multi-image'`, `'Claude API single image'`).

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/ocr/claudeApiAnalyzer.ts
git commit -m "feat(ocr): add 90s timeout and 2-retry exponential backoff to Claude API"
```

---

### Task 11: Move request log cleanup to cron

**Files:**
- Modify: `src/api/middleware/requestLog.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Remove DELETE from middleware hot path**

In `src/api/middleware/requestLog.ts`, find the block inside `res.on('finish', ...)` that has:

```typescript
db.prepare(
  `DELETE FROM api_requests_log WHERE timestamp < datetime('now', '-7 days')`
).run();
```

Delete that statement. Keep only the INSERT.

- [ ] **Step 2: Export a cleanup function from the middleware file**

Add at the end of `src/api/middleware/requestLog.ts`:

```typescript
/**
 * Delete request log entries older than 7 days.
 * Called by a daily cron — not from every request.
 */
export function cleanupOldRequestLogs(): number {
  try {
    const db = getDb();
    const result = db.prepare(
      `DELETE FROM api_requests_log WHERE timestamp < datetime('now', '-7 days')`
    ).run();
    return result.changes;
  } catch (e) {
    return 0;
  }
}
```

- [ ] **Step 3: Schedule cleanup in index.ts**

In `src/index.ts`, find where backup cron is scheduled (`cron.schedule('0 3 * * *', ...)`), add right after it:

```typescript
  // Daily request log cleanup at 03:05 — runs after backup so the backup
  // captures the cleaned table.
  cron.schedule('5 3 * * *', () => {
    const { cleanupOldRequestLogs } = require('./api/middleware/requestLog');
    const deleted = cleanupOldRequestLogs();
    logger.info('API request log cleanup', { deleted });
  });
```

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/api/middleware/requestLog.ts src/index.ts
git commit -m "perf(logging): move request log cleanup from hot path to daily cron"
```

---

### Task 12: Fix N+1 in /api/invoices/pending

**Files:**
- Modify: `src/database/repositories/invoiceRepo.ts`
- Modify: `src/api/routes/invoices.ts:40-44`

- [ ] **Step 1: Add batch method to invoiceRepo**

In `src/database/repositories/invoiceRepo.ts` near `getPending`, add:

```typescript
  /**
   * Fetch all pending invoices along with their items in 2 queries
   * (instead of N+1). Used by the /api/invoices/pending endpoint called
   * by the 1C-side external processing.
   */
  getPendingWithItems(): Array<Invoice & { items: InvoiceItem[] }> {
    const db = getDb();
    const invoices = db.prepare(
      `SELECT * FROM invoices
       WHERE approved_for_1c = 1
       AND status IN ('processed')
       ORDER BY created_at DESC`
    ).all() as Invoice[];

    if (invoices.length === 0) return [];

    const ids = invoices.map(i => i.id);
    const placeholders = ids.map(() => '?').join(',');
    const items = db.prepare(
      `SELECT * FROM invoice_items WHERE invoice_id IN (${placeholders}) ORDER BY id`
    ).all(...ids) as InvoiceItem[];

    // Group items by invoice_id
    const itemsByInvoice = new Map<number, InvoiceItem[]>();
    for (const item of items) {
      if (!itemsByInvoice.has(item.invoice_id)) {
        itemsByInvoice.set(item.invoice_id, []);
      }
      itemsByInvoice.get(item.invoice_id)!.push(item);
    }

    return invoices.map(inv => ({
      ...inv,
      items: itemsByInvoice.get(inv.id) ?? [],
    }));
  },
```

- [ ] **Step 2: Use the new method in the route**

In `src/api/routes/invoices.ts` lines 40-44, replace:

```typescript
// Before:
router.get('/pending', (_req: Request, res: Response) => {
  const invoices = invoiceRepo.getPending();
  const result = invoices.map(inv => invoiceRepo.getWithItems(inv.id));
  res.json({ data: result, count: result.length });
});

// After:
router.get('/pending', (_req: Request, res: Response) => {
  const result = invoiceRepo.getPendingWithItems();
  res.json({ data: result, count: result.length });
});
```

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/database/repositories/invoiceRepo.ts src/api/routes/invoices.ts
git commit -m "perf(api): fix N+1 in /pending — fetch invoices + items in 2 queries"
```

---

### Task 13: Deploy Phase 2

- [ ] **Step 1: Push**

```bash
git push
```

- [ ] **Step 2: Wait for deploy (~30 sec)**

- [ ] **Step 3: Verify helmet headers**

```bash
curl -sI http://scan.magday.ru/ | grep -iE 'x-frame|x-content|strict-transport'
# Expected: X-Frame-Options, X-Content-Type-Options headers present
```

- [ ] **Step 4: Verify rate limiting**

```bash
# Hammer the upload endpoint with 40 empty POSTs
for i in {1..40}; do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST http://scan.magday.ru/api/upload \
    -H "X-API-Key: wrong"
done
# Expected: first requests return 401, later ones return 429
```

- [ ] **Step 5: Verify XSS fix by uploading a crafted filename**

Create a file `test<img src=x>.jpg` locally and upload via the dashboard. Open the invoice detail — you should see the literal text `test<img src=x>.jpg`, not a rendered image.

---

## PHASE 3 — REFACTOR + TESTING

### Task 14: Install vitest

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Install**

```bash
cd c:/www/1C-JPGExchange && npm install -D vitest
```

- [ ] **Step 2: Create minimal config**

Create `c:\www\1C-JPGExchange\vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globals: true,
    environment: 'node',
  },
});
```

- [ ] **Step 3: Add test script**

In `package.json` under `scripts`, add:

```json
    "test": "vitest run",
    "test:watch": "vitest",
```

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json vitest.config.ts
git commit -m "test: add vitest runner"
```

---

### Task 15: First Test — normalizeName

**Files:**
- Create: `tests/mapping/normalizeName.test.ts`

- [ ] **Step 1: Export normalizeName from the mapper module**

In `src/mapping/nomenclatureMapper.ts`, find the function:

```typescript
function normalizeName(name: string): string {
```

Change to:

```typescript
export function normalizeName(name: string): string {
```

- [ ] **Step 2: Write failing test**

Create `c:\www\1C-JPGExchange\tests\mapping\normalizeName.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { normalizeName } from '../../src/mapping/nomenclatureMapper';

describe('normalizeName', () => {
  it('removes parenthesized content', () => {
    expect(normalizeName('Томат (помидоры)')).toBe('Томат');
    expect(normalizeName('Капуста морская(3кг)')).toBe('Капуста морская');
  });

  it('removes weight patterns', () => {
    expect(normalizeName('Мука 50кг')).toBe('Мука');
    expect(normalizeName('Батон Нарезной 0,4 кг')).toBe('Батон Нарезной');
  });

  it('removes volume patterns', () => {
    expect(normalizeName('Вода 1.5л пэт')).toBe('Вода');
    expect(normalizeName('Вода питьевая 500 мл')).toBe('Вода питьевая');
  });

  it('removes count patterns', () => {
    expect(normalizeName('Яйцо Куриное 360шт')).toBe('Яйцо Куриное');
  });

  it('removes packaging abbreviations', () => {
    expect(normalizeName('Лопатка свиная б/к охл')).toBe('Лопатка свиная охл');
  });

  it('collapses whitespace', () => {
    expect(normalizeName('Картофель    сырой')).toBe('Картофель сырой');
  });

  it('handles empty input', () => {
    expect(normalizeName('')).toBe('');
  });
});
```

- [ ] **Step 3: Run test**

```bash
npx vitest run tests/mapping/normalizeName.test.ts
```

Expected: PASS (all 7 tests green).

- [ ] **Step 4: Commit**

```bash
git add src/mapping/nomenclatureMapper.ts tests/mapping/normalizeName.test.ts
git commit -m "test(mapping): normalizeName — 7 unit tests covering weight/volume/packaging"
```

---

### Task 16: Add test step to CI

**Files:**
- Modify: `.github/workflows/deploy.yml`

- [ ] **Step 1: Read current workflow**

Open `.github/workflows/deploy.yml` to find the `steps:` section.

- [ ] **Step 2: Add test step before rsync**

Find the step that runs `npm ci` on the runner (not on the server). After it, before the rsync step, add:

```yaml
      - name: Run tests
        run: npm test
```

If there's no `npm ci` step on the runner, add both:

```yaml
      - name: Install deps
        run: npm ci

      - name: Run tests
        run: npm test
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: run tests before deploy"
```

---

### Task 17: Deploy Phase 3

- [ ] **Step 1: Push**

```bash
git push
```

- [ ] **Step 2: Watch GitHub Actions**

Go to the Actions tab and verify the "Run tests" step passes.

- [ ] **Step 3: Verify the site still works**

Open scan.magday.ru, upload a photo, open an invoice. Everything should work as before.

---

## Self-Review Checklist

- [x] **Critical findings covered**: #1 (API key), #2 (SMTP), #3 (open endpoints), #4 (XSS) — all have tasks
- [x] **Important findings covered**: #5 (no rate limit, done via helmet+rate-limit in Task 6), #6 (Claude retry in Task 10), #8 (no tests in Tasks 14-15), #11 (N+1 in Task 12), #15 (DELETE on every request in Task 11)
- [x] **No placeholders**: all code blocks have concrete content
- [x] **Type consistency**: `getPendingWithItems` defined in Task 12 returns the type the route uses in the same task. `normalizeName` export added in Task 15 step 1 before the test uses it.
- [x] **Each task commits** — so a partial run leaves a consistent state.
- [x] **Phase 1 is independently shippable** — you can stop after Task 4 and still have a safer site.
- [ ] **Not covered in this plan (out of scope, defer to next cycle)**:
  - #7 (processFile monolith refactor) — defer, touches the hottest path, high regression risk
  - #9 (route order bug) — cosmetic, no current impact
  - #10 (recalculateTotal double-bookkeeping) — needs separate design discussion
  - #11 (mapper cache debounce) — optimization, not security
  - #13 (SSH key echo in CI) — CI infra, not hot
  - #14 (require inside async routes) — code quality, not security
  - Nice-to-haves (#16-23) and new features (A-F) — defer to roadmap
