# Multi-tenant data isolation — design

> Status: **IN PROGRESS (model B chosen).** Surfaced by the 2026-06-24 full code review.
> **DONE (branch `code-review-hardening`):** invoice-level ownership — migration 40
> (`invoices.owner_user_id` + backfill), owner stamping on upload/watcher, and flag-gated
> per-tenant invoice scoping with admin bypass (`DATA_SCOPING_ENABLED`, default OFF).
> Verified both modes. **To activate:** set `DATA_SCOPING_ENABLED=true` after creating real
> tenant accounts and confirming the dashboard/1C/Sber flows for the owner are unaffected.
>
> **STILL TODO (needs decisions / dedicated PRs):** suppliers directory model (PK=INN is
> global today — bank details still visible to all authenticated users), per-tenant
> integration config (1C/Sber/OCR keys are single shared rows), per-tenant 1C polling, and
> registration policy. These touch the 1C pull, dispatcher, and watcher (no user context) —
> do NOT implement ad hoc.

## Problem

`/api/auth/register` is open (self-service signup) and the deployment is multi-tenant
(real external registrations exist). But the data model is **single-tenant**:

- No `user_id`/`owner_id` column on `invoices`, `invoice_items`, `nomenclature_mappings`,
  `suppliers`. Every authenticated user's queries return **all** rows — one tenant sees
  every other tenant's invoices, suppliers, prices and item data.
- `apiKeyAuth` resolves a user but **no route scopes queries by `req.user.id`**.
- Background/integration code assumes one owner: `userRepo.firstUserId()` is used as the
  recipient for notifications and the api_key for dispatcher auto-send; comments say
  "current single-user setup".
- Integration config is a **single shared row**: `analyzer_config` (id=1, OCR + Anthropic/
  DaData/ProjectsFlow keys), `sber_tokens` (id=1, one bank connection + payer), `webhook_config`
  (id=1). One tenant's settings/secrets/bank connection are the platform's.

### Already mitigated on branch `code-review-hardening` (Phase 0)
- `GET /api/settings/analyzer` no longer returns Anthropic/DaData/ProjectsFlow secrets to
  non-admins.
- `/api/webhook`, `/api/debug`, and the Sber connect/write routes are admin-only; Sber payer
  bank details redacted from `/status` for non-admins.
- This stops secret/config theft, but does **NOT** isolate invoice/supplier/mapping data.

## The hard part — code with no user context

A naive `WHERE user_id = req.user.id` on every query is insufficient because several flows
have no `req.user`:

1. **1C pull** — `GET /api/invoices/pending` is called by the 1C processing with the admin
   api_key. Which tenant's approved invoices should it return? Today: all. Needs a per-tenant
   key→tenant mapping (1C already authenticates with an api_key → that key's user *is* the
   tenant; scope `pending`/`confirm` by that user).
2. **Dispatcher callbacks** — `/api/dispatcher/*` authenticate by per-task token, not api_key.
   The owning tenant must be derived from the invoice row, which therefore needs an owner column
   set at creation.
3. **File watcher** — `data/inbox/` files have no user. Whose invoice is a dropped JPG? Options:
   per-tenant inbox subfolders, or treat watcher/camera uploads as always belonging to the admin/owner.
4. **`/camera`** (LAN, no auth) and **`POST /api/upload`** — upload must stamp the owner
   (`req.user.id` for `/api/upload`; a configured default for `/camera`).
5. **Notifications / auto-send** — replace `firstUserId()` with the invoice's owner.

## Tenancy model decision (REQUIRED FIRST)

Pick one — the rest of the design forks here:

- **(A) Owner + staff (recommended if "registrations" are your own team).** Not true SaaS:
  one organization, multiple logins, shared data is acceptable. Then the fix is mainly
  **authorization** (done in Phase 0) + **close/gate registration** (invite-only or admin-approval)
  so strangers can't get in. No data-scoping migration needed. Lowest risk.
- **(B) True multi-tenant SaaS (strangers sign up, must not see each other's data).** Requires
  the full data-scoping migration below. Integration config likely must become per-tenant
  (each tenant brings their own 1C/Sber/keys), which is a large change.

## Phased plan for model (B)

> Every migration must be idempotent (CLAUDE.md rule 16) and tested against a **copy** of the
> DB, never the live shared instance (dev=prod; see MEMORY.md). Add tests first (TDD) per CLAUDE.md.

- **Phase 1 — ownership column.** New migration: add `owner_user_id INT NULL` to `invoices`,
  `suppliers`, `nomenclature_mappings` (+ index). Backfill existing rows to the admin user id.
  No behavior change yet (column unused).
- **Phase 2 — stamp owner on write.** `POST /api/upload`, `/camera`, watcher, dispatcher result,
  supplier/mapping create → set `owner_user_id`. Still no read scoping.
- **Phase 3 — scope reads/writes.** Add `owner_user_id = :uid` to every list/detail/update/delete
  in `invoiceRepo`/`supplierRepo`/`mappingRepo`, threading `req.user.id`. Admin role bypasses the
  filter (sees all). 1C `pending`/`confirm` scoped to the calling key's user. Dispatcher/watcher
  use the invoice's stored owner. Cover with API tests asserting tenant A cannot read tenant B.
- **Phase 4 — per-tenant integration config (only if true SaaS).** Convert `analyzer_config`,
  `sber_tokens`, `webhook_config` from singleton id=1 rows to per-`user_id` rows; update every
  `getAnalyzerConfig()`/`sberTokenRepo`/`webhook` call site. Largest blast radius — sequence last.
- **Phase 5 — registration policy.** Decide invite-only vs open + email verification; the current
  `register-email`/`magic-link` flow already exists and can gate this.

## Risk / rollback

- Phases 1–2 are additive and safe to deploy independently.
- Phase 3 is the behavior-changing core; ship behind a feature flag (e.g. `DATA_SCOPING_ENABLED`)
  so it can be toggled off without a redeploy if a flow regresses.
- Phase 4 should be its own release with a dedicated migration + verification of 1C/Sber paths.

## Recommendation

Confirm the tenancy model first. If (A), do invite-gating of registration and stop — Phase 0
already closed the secret/config exposure. If (B), execute Phases 1→5 as separate spec'd PRs
with tests, on copies of the DB, never as a single sweep.
