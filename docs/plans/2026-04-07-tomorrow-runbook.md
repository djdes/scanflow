# Tomorrow Runbook - 2026-04-08

> Read this file first. It is the shortest path through the highest-value work found in the audit.

## Goal

Ship the highest ROI improvements in one focused day without mixing risky deep refactors into the same first pass.

## Start Conditions

- [ ] Create a branch for the work, for example: `git checkout -b chore/day1-hardening-and-performance`
- [ ] Back up the local DB before touching migrations or running mutable test scripts:
  - `Copy-Item data\database.sqlite data\database.sqlite.bak-2026-04-08`
- [ ] Prepare replacement secrets before editing code:
  - new API key
  - new Anthropic key if still needed
  - new SMTP password if mail stays enabled
- [ ] Do not run the existing `test:*` scripts against production data

## Work Order

### Block 1 - Security First

Run the full checklist in [2026-04-07-day1-security-hardening.md](./2026-04-07-day1-security-hardening.md).

Target outcome:

- no secrets in source
- no auth through query string
- no public recovery/debug endpoints
- no key leakage in image URLs

### Block 2 - Quick Performance Pass

Run the must-do items in [2026-04-07-day1-performance-pass.md](./2026-04-07-day1-performance-pass.md).

Target outcome:

- invoice list payloads are much smaller
- `/pending` no longer performs obvious N+1 reads
- invoice detail becomes faster to open
- full catalog is no longer loaded by default where not required

### Block 3 - Quality And Ops

Run the must-do items in [2026-04-07-day1-quality-and-ops.md](./2026-04-07-day1-quality-and-ops.md).

Target outcome:

- test execution no longer mutates the real working DB by default
- deployment has a real verification gate
- stuck processing states become observable and recoverable

## Verification Sequence

After each block:

- [ ] `npm run build`
- [ ] Start the app once and confirm boot
- [ ] Exercise the modified endpoint or UI path locally

After all blocks:

- [ ] Run the new safe test workflow
- [ ] Smoke-test invoice list, invoice detail, upload, and nomenclature search
- [ ] Review git diff only for intended changes

## Explicitly Not For Tomorrow Unless Time Remains

- Full `invoice_files` schema refactor
- Full background queue/job system
- Rewriting OCR flow into worker processes
- Large front-end redesign
- 1C protocol redesign

## If There Is Extra Time

- Add a dedicated `/health/details` or admin metrics view for processing state.
- Add request timing instrumentation for the slowest endpoints.
- Add a small benchmark or payload-size regression note to the docs.

