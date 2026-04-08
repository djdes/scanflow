# Day 1 Plan - Performance Pass

> Focus on the highest-value wins that reduce payload size, blocking work, and unnecessary client/server effort. Do not start with deep schema changes on Day 1.

## Scope

Ship the fastest performance wins with minimal architectural risk.

## Main Findings To Address

- Invoice list endpoints return too much data, including `raw_text`.
- `/api/invoices/pending` performs N+1 reads.
- Invoice detail waits for the full 1C catalog before loading its own data.
- The browser eagerly loads the full nomenclature catalog and fuzzy-indexes it.
- Request-log pruning runs on every request.
- SQLite runtime tuning is still very basic.

## Files Likely In Scope

- `src/database/repositories/invoiceRepo.ts`
- `src/api/routes/invoices.ts`
- `src/api/routes/nomenclature.ts`
- `src/database/repositories/onecNomenclatureRepo.ts`
- `src/api/middleware/requestLog.ts`
- `src/database/db.ts`
- `src/database/migrations.ts`
- `public/js/invoices.js`
- `public/js/onecCatalog.js`
- `public/js/mappings.js`

## Must-Do Tasks

### 1. Split List DTO From Detail DTO

- [ ] Add a lightweight query path for invoice lists that does not return `raw_text` and other large detail-only fields.
- [ ] Keep `getById` or detail endpoints as the place where full text is loaded.
- [ ] Update `/api/invoices` to return the lightweight representation.

Done when:

- invoice list responses no longer contain `raw_text`
- dashboard list still renders correctly

### 2. Remove N+1 From `/api/invoices/pending`

- [ ] Replace `getPending()` + `map(getWithItems)` with a batch-oriented query strategy.
- [ ] At minimum, fetch pending invoices once and fetch all related items in one extra query.
- [ ] Return only the fields 1C actually needs.

Done when:

- `/pending` no longer issues one invoice read per row
- response shape still satisfies 1C import

### 3. Stop Blocking Invoice Detail On Catalog Load

- [ ] In `public/js/invoices.js`, fetch invoice detail immediately.
- [ ] Load the 1C catalog in parallel or only when the user enters an editing path that needs it.
- [ ] Keep the UI responsive even if the catalog is large or slow.

Done when:

- invoice detail opens before the catalog is fully ready

### 4. Stop Full-Catalog Loading By Default

- [ ] Add server-side search + limit behavior for nomenclature endpoints.
- [ ] Avoid loading the entire catalog at page open unless explicitly requested.
- [ ] Keep client-side Fuse only if the catalog is intentionally cached and bounded.

Done when:

- the default dashboard path does not download the full nomenclature catalog
- catalog search still works for the user

### 5. Move Log Pruning Out Of The Request Hot Path

- [ ] Remove the unconditional `DELETE` from every request completion.
- [ ] Replace it with one of:
  - periodic cleanup on startup and interval
  - probabilistic cleanup every N requests
  - a tiny maintenance command

Done when:

- normal requests do not always pay for retention cleanup

## Good Next Tasks If Time Remains

### 6. SQLite Tuning

- [ ] Evaluate `busy_timeout`
- [ ] Evaluate `synchronous = NORMAL`
- [ ] Evaluate memory/temp pragmas appropriate for this local deployment model
- [ ] Add indexes that match real filter patterns, not only generic columns

### 7. Frontend Large-List Rendering

- [ ] Avoid full in-memory render/filter for very large mappings/catalog views
- [ ] Add pagination or incremental rendering where it matters most

## Verification

- [ ] `npm run build`
- [ ] invoice list works
- [ ] invoice detail loads faster than before
- [ ] `/api/invoices` payload is visibly smaller
- [ ] `/api/invoices/pending` still supports the 1C flow
- [ ] nomenclature search remains usable

## Explicitly Deferred From This Plan

- `invoice_files` schema refactor
- full queue/worker redesign
- deep OCR flow rewrite

