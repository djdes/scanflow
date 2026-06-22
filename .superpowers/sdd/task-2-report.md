# Task 2 Report — Expose `possible_siblings` on `GET /api/invoices/:id`

## Status
DONE

## Commits
- Test file + route edit committed as single commit per plan Step 5.

## Files Changed
- `src/api/routes/invoices.ts` — Added two lines before `res.json({ data: enriched })` in `GET /:id`: assigns `possible_siblings` via `await invoiceRepo.findSiblings(id)`.
- `tests/api/siblings.test.ts` — Created verbatim from plan Task 2 Step 1.

## Test Command and Results
```
DB_NAME=scanflow_test npx vitest run tests/api/siblings.test.ts
```
Result: **2 passed (2)** — all tests pass.

## TypeScript Check
```
npx tsc --noEmit
```
Result: **0 errors** (clean compile, no pre-existing errors either).

## Route Edit Applied
In `src/api/routes/invoices.ts` at the `GET /:id` handler (around line 276), replaced:
```ts
res.json({ data: enriched });
```
with:
```ts
(enriched as typeof enriched & { possible_siblings: unknown }).possible_siblings =
  await invoiceRepo.findSiblings(id);

res.json({ data: enriched });
```

## Notes
- `tests/api/` directory already existed (other tests live there); no directory creation needed.
- Task 1 (`findSiblings` repo method) was confirmed present at line 579 of `invoiceRepo.ts`.
- Both test cases run successfully against the test DB: sibling detection surfaces the split row, and the merge-into sequence correctly collapses 8+5=13 items and removes the source row.
