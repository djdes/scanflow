# Day 1 Plan - Quality And Ops Stabilization

> This plan makes the project safer to change after the first hardening/performance pass.

## Scope

Reduce accidental data mutation, improve deploy confidence, and make stuck processing easier to diagnose.

## Main Findings To Address

- Existing `test:*` scripts operate on the real SQLite DB.
- There is no clear isolated default test workflow.
- Deploy does not appear to block on meaningful regression checks.
- Many invoices are currently stuck in `ocr_processing` in the local workspace DB.
- OCR mode docs/config/UI are drifting apart.

## Files Likely In Scope

- `package.json`
- `src/database/db.ts`
- `src/scripts/test-*.ts`
- `.github/workflows/deploy.yml`
- `src/watcher/fileWatcher.ts`
- `src/ocr/ocrManager.ts`
- `src/ocr/claudeTextAnalyzer.ts`
- `public/index.html`
- any new lightweight test bootstrap helpers under `src/scripts/` or `src/test/`

## Must-Do Tasks

### 1. Create A Safe Test Database Path

- [ ] Introduce a test DB path override, for example through environment or a dedicated bootstrap helper.
- [ ] Make the default test workflow point to a disposable DB file.
- [ ] Ensure the test DB is created and cleaned automatically.

Done when:

- running the recommended test command does not mutate `data/database.sqlite`

### 2. Add A Real Aggregate Test Command

- [ ] Add an `npm test` or `npm run test:safe` entry that runs the supported checks in one place.
- [ ] Document which legacy scripts are still mutable or manual-only.

Done when:

- there is one obvious command to validate the project safely

### 3. Add A Deploy Gate

- [ ] Update `.github/workflows/deploy.yml` so deployment runs only after build and safe tests pass.
- [ ] Keep the pipeline simple for Day 1; even a small gate is better than none.

Done when:

- a broken test run stops deploy

### 4. Add Recovery/Visibility For Stuck Processing

- [ ] Decide what should happen to invoices that remain in `ocr_processing` too long.
- [ ] Add at least one of:
  - timeout-based requeue
  - marking stale jobs as error with reason
  - admin endpoint/report to list stale work
- [ ] Document the rule in code comments or docs.

Done when:

- the system can surface or recover stuck processing instead of leaving it silent

### 5. Align OCR Configuration Across Layers

- [ ] Update stale comments describing Claude CLI where the runtime now uses Anthropic API text analysis.
- [ ] Align UI model IDs with the migration/runtime defaults.
- [ ] Make the configured analyzer modes clear and consistent.

Done when:

- code, UI, and migration defaults all describe the same current behavior

## Nice-To-Have Tasks

- [ ] Add lightweight timing logs for OCR, parsing, and webhook delivery.
- [ ] Add a simple admin stats screen for processing status counts by age.
- [ ] Document a local recovery checklist for failed/stuck files.

## Verification

- [ ] `npm run build`
- [ ] new safe test command passes
- [ ] deploy workflow includes the new gate
- [ ] stale processing can be identified or recovered intentionally

## Suggested Commit Shape

1. `test: isolate SQLite path for safe local validation`
2. `ci: gate deploy on build and safe tests`
3. `ops: add stale processing visibility and config cleanup`

