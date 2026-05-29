# Supplier requisite recognition via dispatcher

**Date:** 2026-05-29
**Status:** approved

## Problem

The suppliers page has a "Распознать реквизиты с фото" panel that uploads a photo
and extracts ИНН/КПП/БИК/счёт/корсчёт/адрес/название for review before saving a
supplier. Two issues:

1. **Broken now:** the frontend calls `App.getApiKey()` (no such method — the key
   is the property `App.apiKey`), so it throws before uploading.
2. **Wrong engine:** `POST /api/suppliers/extract-from-photo` runs
   `analyzeImageWithClaudeApi` synchronously with a Claude API key. Production runs
   `analyzer_config.mode === 'dispatcher'` (no API key), so it would 503 anyway.

Goal: route requisite recognition through the **dispatcher** (ProjectsFlow task →
external Claude Code session → callback), the same engine invoices use, so it costs
no Anthropic API tokens.

## Decisions (from brainstorming)

- **Async UX:** background queue + polling. Upload → "распознаётся…" card → poll →
  fill the editable card when the dispatcher answers. User may leave and return
  (state in DB). Latency is minutes, same as invoices.
- **Dedicated requisites prompt** (not the invoice prompt) — many sources are
  платёжки/счета with no goods table; extract the **получатель/payee** requisites.
- **PDF support:** accept PDF in addition to images; the dispatcher serves it as
  `application/pdf` and the Claude Code session reads PDF natively.
- **Mode-aware:** `mode==='dispatcher'` → async dispatch; otherwise keep the
  existing synchronous Claude-API path (both modes keep working).
- **Isolated job table** (not the `invoices` table) — avoids polluting dashboard,
  stats, pending and the multi-page merge queries.

## Architecture

### Migration 29 — `supplier_extract_jobs`
`id PK, token CHAR(64), task_id VARCHAR(64) NULL, status ENUM-ish VARCHAR(20)
('processing'|'done'|'error'), file_name VARCHAR(255), file_path TEXT,
content_type VARCHAR(64), result_json TEXT NULL, error TEXT NULL,
created_at DATETIME DEFAULT NOW`. Idempotent (`CREATE TABLE IF NOT EXISTS`).

### `supplierExtractJobRepo`
`create({file_name, file_path, content_type, token}) → id`, `getById`,
`setTaskId`, `setResult(id, json)` (→ done), `setError(id, msg)` (→ error),
`markStaleAsFailed(minutes)` (processing older than N → error).

### `buildSupplierPrompt()` (new, in claudeApiAnalyzer or sibling)
Lean prompt: return JSON `{ inn, kpp, name, bank_bic, account,
bank_corr_account, bank_name, address }` for the **получатель/payee**. Works on
invoices, счета, and платёжные поручения (pick получатель, never плательщик).

### createTask.ts
- Extract `postPfTask(token, projectId, description) → taskId` (shared with
  `dispatchInvoice`).
- `dispatchSupplierExtract(jobId)`: build description with
  `photo_url=/api/dispatcher/photo-job/:jobId?token=`,
  `callback_url=/api/dispatcher/supplier-result/:jobId`,
  `prompt_url=/api/dispatcher/prompt-supplier`; POST task; store task_id.
- `validateSupplierJobToken(jobId, token)` → job row if token matches and status
  is `processing`.

### dispatcher.ts routes (no apiKeyAuth; per-task token)
- `GET /prompt-supplier` → `buildSupplierPrompt()` as text/plain.
- `GET /photo-job/:jobId?token=` → validate, stream file with its `content_type`
  (image or `application/pdf`).
- `POST /supplier-result/:jobId` → `{ token, success, data?, error? }`. Success:
  store requisites JSON, status=done, delete file (best-effort). Error: status=error.

### suppliers.ts
- `POST /extract-from-photo`: accept image **or PDF** (multer fileFilter). If
  `mode==='dispatcher'`: persist file to a jobs dir, create job+token,
  `dispatchSupplierExtract`, return `{ jobId }`. Else: existing sync path →
  `{ extracted }`.
- `GET /extract-status/:jobId` → `{ status, extracted?, error? }`.

### Frontend `suppliers.js`
- `App.getApiKey()` → `App.apiKey`.
- `_handleFiles`: POST → `{jobId}` ⇒ show "распознаётся…" and poll
  `extract-status` ~5 s until terminal, then render the existing editable card;
  `{extracted}` ⇒ render immediately. Accept `.pdf`; panel text "JPG/PNG/PDF".

### Stale sweep
Wire `supplierExtractJobRepo.markStaleAsFailed(15)` into the existing dispatcher
cron sweep so jobs never spin forever in the UI.

## Testing
- Repo unit: create/setResult/setError/markStaleAsFailed.
- Dispatcher callback route: success stores requisites + done; error → error;
  bad/again token → 401.
- suppliers extract: dispatcher mode returns `{jobId}` and creates a job;
  extract-status returns the stored result.
- No real PF/Claude calls in tests (dispatch is mocked / mode-gated).

## Out of scope
- Sync-path PDF (sync stays image-only; prod is dispatcher mode).
- Recognising both parties / choosing плательщик vs получатель in UI (always payee).
