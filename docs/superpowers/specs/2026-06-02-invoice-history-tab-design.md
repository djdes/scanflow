# Invoice «История» tab

**Date:** 2026-06-02
**Status:** approved

## Problem

Each invoice detail view has three tabs (Товары / Фото / OCR-текст). There's no
single place that answers "когда и откуда пришла эта накладная, сколько
распознавалась, и что с ней не так". The metadata is scattered: upload time is
implied by `created_at`, issues are shown piecemeal (price-warning banner,
unmapped badge, mismatch badge), recognition-finish time isn't recorded at all,
and the upload source/device is discarded.

Goal: add a fourth tab **«История»** showing:
- дата/время отправки пользователем;
- откуда отправлено (источник + USER-AGENT);
- во сколько завершилось распознавание;
- суммарно затраченное время (отдельной строкой);
- все замечания по накладной: что не сопоставилось и по каким товарам, где
  средняя цена расходится, расхождение суммы.

## Decisions (from brainstorming)

- **Scope = listed items + lifecycle events.** Beyond the five listed items, also
  show the lifecycle timestamps we already store: «одобрено для 1С»
  (`approved_at`), «отправлено в 1С» (`sent_at`), «платёж в Сбер создан»
  (`sber_payments.created_at`). **No** per-edit audit log (would need a new audit
  table + instrumenting every mutation — out of scope).
- **Remarks = live current state.** Recomputed each time the tab opens, from the
  same data the detail endpoint already returns. Reflects the user's edits and
  mappings. Not a frozen snapshot.
- **Lightweight implementation.** 3 new nullable columns + client-side
  derivation. No new tables, no new endpoints. (A full `invoice_events` audit
  table was considered and rejected — unnecessary given the two decisions above.)
- **Forward-only.** Source/UA and recognition-finish are captured going forward
  only; pre-existing invoices never recorded them and show «—».
- **Source + raw UA both shown** (the task says "USER-AGENT / источник"): a
  friendly source label with the raw UA string muted underneath.
- **Duration is human-friendly** ("42 сек" / "1 мин 5 сек").

## Architecture

### Migration 31 — three columns on `invoices`

All nullable, idempotent (`hasColumn` guards), with a `detect()`:

- `recognized_at DATETIME NULL` — set on the **first** transition to `processed`.
- `upload_source VARCHAR(32) NULL` — `'web'` | `'camera'` | `'inbox'`.
- `upload_user_agent VARCHAR(512) NULL` — raw UA string when known.

`detect`: all three columns present. Pre-existing rows stay NULL.

### Capture points

**`recognized_at`** — in `invoiceRepo.updateStatus(id, status, …)`: when
`status === 'processed'`, set `recognized_at = NOW()` **only if it is currently
NULL** (`SET recognized_at = COALESCE(recognized_at, NOW())`). This:
- covers every "→ processed" path for free (main processFile success ~line 1119,
  multi-page merge ~line 877, reprocessInvoice ~line 400);
- means a later **rescan does not overwrite** the original recognition time, so
  `duration = recognized_at − created_at` stays meaningful (≈ original OCR time,
  not "days since upload").

**`upload_source` / `upload_user_agent`** — captured at the HTTP entry point and
threaded down to the row insert:

- `POST /api/upload` (`src/api/routes/upload.ts`): compute
  `source = /^photo_\d+_[\w-]+\.\w+$/.test(filenameQuery) ? 'camera' : 'web'`
  (camera page posts `?filename=photo_…`; dashboard posts plain `/upload`),
  `userAgent = req.headers['user-agent'] ?? null`. Pass as a `meta` object into
  `fileWatcher.processFile`.
- `FileWatcher.processFile(filePath, fileName, forceEngine?, meta?)` — new
  optional `meta: { source?: string; userAgent?: string | null }`. Passed into
  `invoiceRepo.create`. The watcher's own `onAdd` inbox handler (~line 120) calls
  `processFile` without `meta` → defaults to `source = 'inbox'`, UA `null`.
- `invoiceRepo.create(data)` — `CreateInvoiceData` gains optional
  `upload_source?` and `upload_user_agent?`; INSERT writes them (default
  `upload_source = 'inbox'` when omitted, UA `null`).

### Repository / type changes

- `Invoice` interface: add `recognized_at: string | null`,
  `upload_source: string | null`, `upload_user_agent: string | null`.
- `CreateInvoiceData`: add optional `upload_source`, `upload_user_agent`.
- `invoiceRepo.create`: include the two columns in the INSERT.
- `invoiceRepo.updateStatus`: `COALESCE(recognized_at, NOW())` branch on
  `status === 'processed'`.

### API

No new endpoint. `GET /api/invoices/:id` already does `SELECT *`, so the three new
columns appear automatically once added to the `Invoice` type. `approved_at` /
`sent_at` are already in the payload. The Sber payment timestamp is read from the
existing `GET /api/invoices/:id/sber-status` (its row carries `created_at`).

### Frontend — «История» tab

**`public/app.html`** (~lines 154–187): add a 4th tab button
`<button class="tab-btn" onclick="Invoices.switchTab('history', this)">История</button>`
and a `<div class="card" id="invoice-tab-history" style="display:none"></div>`.

**`public/js/invoices.js`:**
- `switchTab()` (~line 946) and the reset block in `showDetail()` (~lines 152–156):
  add `invoice-tab-history` to the hide/show set.
- New `renderHistory(data)`, called from `showDetail()` after `data` loads. Builds
  two sections from the already-loaded invoice+items (plus one `sber-status`
  fetch). Lazy-render on first switch to «История» is acceptable but simplest is
  to render eagerly in `showDetail` since the data is in hand.

Layout:

```
┌─ Обработка ───────────────────────────────────┐
│ Отправлено              02.06.2026, 14:31      │
│ Источник                Камера телефона        │
│                         Mozilla/5.0 (iPhone…)  │  ← raw UA, muted, if present
│ Распознавание завершено 02.06.2026, 14:31      │
│ Затрачено               42 сек                 │
│ Одобрено для 1С         02.06.2026, 14:35      │  ← lifecycle rows, if set
│ Отправлено в 1С         —                      │
│ Платёж в Сбер создан    02.06.2026, 14:36      │
└────────────────────────────────────────────────┘
┌─ Замечания ───────────────────────────────────┐
│ ⚠ 3 товара не сопоставлены: Сахар, Мука, …     │
│ ⚠ Сумма позиций расходится с суммой документа  │
│ ⚠ 2 позиции дороже обычного: Масло (+34%), …   │
└────────────────────────────────────────────────┘   (or «Замечаний нет ✓»)
```

Derivations (client-side, reuse existing fields):
- **Источник label:** `web → «Загрузка с сайта»`, `camera → «Камера телефона»`,
  `inbox → «Папка-инбокс / автозагрузка»`, null → «—». Raw `upload_user_agent`
  shown muted underneath when present.
- **Затрачено:** `recognized_at − created_at`, formatted («N сек» / «N мин M
  сек»). Shown only when both timestamps exist.
- **Не сопоставлено:** `items.filter(it => !it.onec_guid)` → count + first ~3
  names. Reuses the same `unmappedCount` logic already in `showDetail`.
- **Повышенная цена:** `items.filter(it => it.price_deviation_pct > 10)` → count +
  worst names. Same source as the existing `_renderPriceWarning` banner.
- **Расхождение суммы:** `items_total_mismatch` flag.
- **Ошибка / Дубликат:** `error_message`, `duplicate_of` (with link to original)
  when present.
- Empty state: «Замечаний нет ✓» when none of the above fire.

The existing header shows date-only via `App.formatDate`; the История tab wants
date+time, so add a `App.formatDateTime(value)` helper in `app.js` (date +
HH:MM, «—» on null) and use it for all timestamp rows here.

## Error handling / edge cases

- Pre-migration invoices: `recognized_at` / `upload_source` / `upload_user_agent`
  NULL → «—»; «Затрачено» row hidden.
- Rescan after first recognition: `recognized_at` preserved (COALESCE guard);
  «Отправлено» stays the original `created_at`.
- Duplicate invoices: items aren't saved, so «не сопоставлено» won't fire; the
  «Дубликат» remark with a link to the original is shown instead.
- Sber fetch failure: the «Платёж в Сбер создан» row degrades to «—»; never
  blocks the rest of the tab.
- UA string is escaped (`App.esc`) and may be long — render muted/wrapped, no
  truncation needed at DB level (column is 512).

## Testing

Vitest (localhost-only per the `tests/helpers/db.ts` guard — never disabled):
- Migration 31 idempotency (run twice, columns present once).
- `invoiceRepo.updateStatus` sets `recognized_at` on first `processed` and does
  **not** overwrite it on a second `processed` call.
- `invoiceRepo.create` persists `upload_source` / `upload_user_agent`, and
  defaults `upload_source` to `'inbox'` when omitted.
- Upload route source inference: `?filename=photo_123_abc.jpg → 'camera'`, plain
  upload → `'web'` (route-level or unit test of the inference helper).

Frontend is vanilla JS with no test harness — verified manually (open an invoice,
switch to «История», check rows + remarks; test web vs camera upload source).

## Out of scope

- Per-edit audit log (who changed qty/price/mapping/requisites and when).
- Backfilling source/recognition-finish for historical invoices.
- Any new notification event — this is a read-only view over existing data.
