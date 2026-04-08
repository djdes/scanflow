# Project Audit and Improvement Roadmap - 2026-04-07

> Start with [2026-04-07-tomorrow-runbook.md](./2026-04-07-tomorrow-runbook.md). This file is the long-lived summary of what was found and why the order matters.

## Summary

The project is already substantial and coherent: backend, OCR, parsing, mappings, dashboard, 1C integration, and local persistence are separated well enough to keep evolving. `npm run build` passed, and the main parser/mapping test scripts completed successfully in the current workspace.

The biggest risks are not "micro-optimizations". They are:

1. Security issues that should be fixed before scaling anything.
2. Heavy API payloads and unnecessary full-table/full-catalog reads.
3. A denormalized model for multi-page invoices that will age poorly.
4. Synchronous file I/O and long non-atomic processing paths.
5. Missing isolation between test workflows and the real SQLite database.

## Current Signals From The Workspace

- Build status: `npm run build` passed.
- Local script checks passed:
  - `npm run test:invoice-number`
  - `npm run test:nomenclature-mapper`
  - `npm run test:onec-nomenclature`
  - `npm run test:position-parser`
- Important caveat: the existing `test:*` scripts are not isolated from the real local DB and can mutate rows under `data/database.sqlite`.
- Current local DB snapshot observed during analysis:
  - `invoices`: `1141`
  - `invoice_items`: `2160`
  - `statuses`: `ocr_processing=812`, `processed=213`, `error=115`, `sent_to_1c=1`
  - average `raw_text` length: about `1611` chars
  - max `raw_text` length: above `12000` chars

That status distribution strongly suggests the project needs stale-job recovery and a more explicit processing lifecycle.

## Priority Matrix

### P0 - Fix First

- Remove hardcoded secrets from source and rotate them.
- Protect unauthenticated debug/recovery endpoints.
- Stop accepting API keys through query string.
- Stop leaking API keys into image URLs.
- Tighten CORS and mailer TLS defaults.

### P1 - Highest ROI Performance

- Stop returning `raw_text` and other heavy fields in invoice list endpoints.
- Remove N+1 behavior from `/api/invoices/pending`.
- Stop loading the full 1C nomenclature catalog into both server and browser.
- Load invoice detail before or in parallel with the catalog.
- Move request-log pruning out of the request hot path.
- Add SQLite pragmas and indexes that match real queries.

### P2 - Reliability And Scaling

- Replace comma-separated `file_name` storage with a normalized `invoice_files` table.
- Move invoice matching closer to SQL with normalized columns.
- Reduce sync file system calls in the OCR/file watcher path.
- Add stale `ocr_processing` recovery and better observability.
- Isolate test DB from dev/prod DB.
- Add automated test gates before deployment.

## Recommended Delivery Order

### Phase 1 - Tomorrow

Use these plans in this order:

1. [2026-04-07-day1-security-hardening.md](./2026-04-07-day1-security-hardening.md)
2. [2026-04-07-day1-performance-pass.md](./2026-04-07-day1-performance-pass.md)
3. [2026-04-07-day1-quality-and-ops.md](./2026-04-07-day1-quality-and-ops.md)

### Phase 2 - Next Refactors

- Normalize invoice pages into a separate table.
- Introduce a clearer processing job model with retries, lease/timeout logic, and recovery.
- Move nomenclature lookup to server-driven search with pagination and caching.
- Add an explicit API contract layer for list/detail/pending/export payloads.

## Most Valuable Improvements Per Hour

If time is limited, the best return will likely come from this exact sequence:

1. Remove secrets from code and rotate them.
2. Lock down `/api/errors` and `/api/reprocess-errors`.
3. Remove `?key=` auth and stop exposing keys in image requests.
4. Split invoice list DTOs from invoice detail DTOs.
5. Rework `/pending` into a batch query instead of per-invoice reads.
6. Stop loading the full 1C catalog by default on the client.
7. Add isolated test DB support and a real `npm test`.

## Notes For Tomorrow

- Do not run the current `test:*` scripts against production data.
- Back up `data/database.sqlite` before touching migrations or processing logic.
- Treat secret rotation as mandatory, not optional, because values have existed in source.
- Do not mix the security pass with the deeper schema refactor on the same first branch unless the smaller fixes are already green.

