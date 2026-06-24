# Per-tenant supplier directory — design

> Status: **DRAFT / not started.** Follow-up to
> [`2026-06-24-multitenant-data-isolation-design.md`](2026-06-24-multitenant-data-isolation-design.md)
> ("STILL TODO: suppliers directory model"). Invoice-level ownership already shipped
> (migration 40, `invoices.owner_user_id`, flag `DATA_SCOPING_ENABLED`, admin bypass).
> This spec extends the same flag/pattern to the `suppliers` table so one tenant cannot
> read another tenant's bank details. Reuse the invoice rollout verbatim where possible —
> do NOT invent a second scoping mechanism.

## Context — what exists today

- `suppliers` table (migration 8, `src/database/migrations.ts:486`) has **`inn VARCHAR(32) PRIMARY KEY`** — a single global row per ИНН. Columns: `name, kpp, account, bank_bic, bank_corr_account, bank_name, address, verified, source, notes, created_at, updated_at, last_used_at`.
- `supplierRepo` (`src/database/repositories/supplierRepo.ts`) keys **everything** on `inn`: `findByInn`, `create`, `upsert`, `mergeEmpty`, `update`, `touchLastUsed`, `delete` all use `WHERE inn = ?` / `INSERT … (inn, …)`. `list()` has no owner filter.
- The whole `/api/suppliers` router (`src/api/server.ts:232`) runs under `apiKeyAuth`, so **`req.user` is always populated** there (`{ id, username, role }`, see `src/api/middleware/auth.ts:14`). That is the owner context for all CRUD routes.
- Suppliers are read in three system/integration places that have **no `req.user`**:
  1. `enrichInvoiceWithSupplier` (`src/services/enrichSupplier.ts`) — substitutes verified requisites into invoice payloads (UI list/detail, **1C `/pending`**, Sber send).
  2. `resolveSupplierName` (`src/services/resolveSupplierName.ts`) — picks the canonical supplier NAME for a freshly-OCR'd invoice. Called from the watcher (`src/watcher/fileWatcher.ts:253`) and the dispatcher callback (`src/api/routes/dispatcher.ts:41`).
  3. The **Sber send path** (`src/api/routes/invoices.ts:1522`) — `findByInn` → `upsert` (on overrides) → `touchLastUsed`.

> The watcher does **not** auto-create suppliers (it only `mappingRepo.upsert`s nomenclature). Supplier rows are created only via: `POST /api/suppliers`, `POST /api/suppliers/merge` (`mergeEmpty`), and the Sber-send `upsert` on `supplier_overrides`. Keep that surface in mind — those are the only stamping sites.

---

## 1. The primary-key problem

`PK = inn` makes the directory **structurally single-tenant**: two tenants who both pay
ИНН `7707083893` cannot each keep their own card (different `account`, `notes`,
`verified`, even a different preferred `name`). The first writer wins and the second
tenant either sees/edits the first tenant's bank details or is blocked by the PK.

### Option A — surrogate `id` PK + `UNIQUE(owner_user_id, inn)` (RECOMMENDED)

```
id            INT AUTO_INCREMENT PRIMARY KEY
owner_user_id INT NULL
inn           VARCHAR(32) NOT NULL
… (existing columns) …
UNIQUE KEY uq_suppliers_owner_inn (owner_user_id, inn)
```

- **Pro:** matches the rest of the schema (every other table is surrogate-`id`; `invoices`, `sber_payments`, `nomenclature_mappings` are all `INT AUTO_INCREMENT PRIMARY KEY`). FK targets stay stable: nothing currently FKs `suppliers.inn`, but a surrogate id is the safe future target.
- **Pro:** dedup becomes per-owner naturally (`UNIQUE(owner_user_id, inn)`); `findByInn(inn, owner)` is an index seek on the unique key.
- **Pro:** admin/system rows (`owner_user_id = NULL` after backfill, or the platform admin id) coexist with tenant rows for the same ИНН.
- **Con:** the repo no longer round-trips on `inn` alone — every method must take an owner. Callers change (see §3). This is the bulk of the work but it is mechanical.
- **Con:** `NULL` in a MySQL `UNIQUE` is **not** deduped (two `(NULL, '770…')` rows are allowed). If we keep `owner_user_id NULL` for legacy rows we lose the dedup guarantee for them. Mitigation: backfill legacy rows to the lowest-id admin (a concrete id, not NULL) so the unique key is enforced — same approach migration 40 used for invoices.

### Option B — composite PK `(owner_user_id, inn)`

```
owner_user_id INT NOT NULL
inn           VARCHAR(32) NOT NULL
PRIMARY KEY (owner_user_id, inn)
```

- **Pro:** no surrogate column; the PK *is* the tenant+inn tuple, so dedup is enforced by the PK and there is no "which row" ambiguity.
- **Con:** `owner_user_id` must be `NOT NULL` (PK columns can't be NULL) → forces a non-null value for every legacy row at migration time and removes the "system/global, owner unknown" sentinel that migration 40 deliberately allows for invoices (`owner_user_id NULL` = system-owned). Inconsistent with the invoice model.
- **Con:** composite PK is a churn risk if anything ever FKs a supplier (would need both columns). Reordering a PK on a populated table is a heavier DDL than adding a column + unique key.
- **Con:** diverges from the established surrogate-`id` convention; future joins/CRUD that assume a single-column key break.

### Decision

**Adopt Option A.** It mirrors migration 40's choices (additive nullable column, backfill to lowest-id admin, surrogate id stays the join target) and keeps the repo's external contract close to today's (`findByInn(inn, ownerUserId?)` with an optional second arg → inert when the flag is off / arg omitted).

---

## 2. Migration sketch (version **41**, additive + idempotent, MySQL-9)

Append to `MIGRATIONS` in `src/database/migrations.ts` (current max version is 40, `:860`).
Match the exact object style — `version` / `name` / `detect` / `run`, using the existing
`hasColumn` / `hasIndex` helpers (`:25`, `:43`).

```ts
{
  version: 41,
  name: 'suppliers.owner_user_id — per-tenant supplier directory (scoping flag-gated via DATA_SCOPING_ENABLED)',
  // Additive + idempotent, mirrors migration 40 for invoices. The column +
  // unique key are harmless until DATA_SCOPING_ENABLED is on (the supplier
  // scoping layer is the only reader). Backfill assigns every existing
  // supplier card to the platform owner (lowest-id admin) so enabling scoping
  // never hides historical cards from the only real tenant today. See
  // docs/superpowers/specs/2026-06-24-per-tenant-suppliers-design.md
  detect: async (exec) => {
    if (!(await hasColumn(exec, 'suppliers', 'owner_user_id'))) return false;
    if (!(await hasIndex(exec, 'suppliers', 'uq_suppliers_owner_inn'))) return false;
    const [rows] = await exec.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS cnt FROM suppliers WHERE owner_user_id IS NULL`
    );
    return rows[0].cnt === 0;
  },
  run: async (exec) => {
    // 1) Add the column (no UNIQUE yet — duplicate (NULL, inn) can't exist
    //    because today inn is the PK, so every inn is already unique).
    if (!(await hasColumn(exec, 'suppliers', 'owner_user_id'))) {
      await exec.query(`ALTER TABLE suppliers ADD COLUMN owner_user_id INT NULL`);
    }
    // 2) Backfill NULLs to the lowest-id admin BEFORE adding the unique key,
    //    so the post-backfill state has no NULLs that would dodge dedup.
    await exec.query(
      `UPDATE suppliers SET owner_user_id = (SELECT MIN(id) FROM users WHERE role='admin')
        WHERE owner_user_id IS NULL AND EXISTS (SELECT 1 FROM users WHERE role='admin')`
    );
    // 3) Drop the old PK on inn and add surrogate id + UNIQUE(owner_user_id,inn).
    //    Guarded so a partial re-run is a no-op.
    if (!(await hasColumn(exec, 'suppliers', 'id'))) {
      // MySQL 8/9: dropping a PK that other code keys on is the risky step.
      // Add the surrogate as a new AUTO_INCREMENT PRIMARY KEY in one ALTER so
      // the table is never without a primary key.
      await exec.query(`ALTER TABLE suppliers DROP PRIMARY KEY,
        ADD COLUMN id INT AUTO_INCREMENT PRIMARY KEY FIRST`);
    }
    if (!(await hasIndex(exec, 'suppliers', 'uq_suppliers_owner_inn'))) {
      await exec.query(
        `ALTER TABLE suppliers ADD UNIQUE KEY uq_suppliers_owner_inn (owner_user_id, inn)`
      );
    }
    if (!(await hasIndex(exec, 'suppliers', 'idx_suppliers_owner'))) {
      await exec.query(`CREATE INDEX idx_suppliers_owner ON suppliers(owner_user_id)`);
    }
  },
},
```

Notes / gotchas:
- **`DROP PRIMARY KEY, ADD … AUTO_INCREMENT PRIMARY KEY` must be one ALTER.** An AUTO_INCREMENT column must be a key; splitting the statement leaves an interim state MySQL rejects.
- The backfill runs **before** the unique key so post-state has no `(NULL, inn)` rows that would silently escape dedup.
- If no admin exists yet (empty-DB first run), the `EXISTS` guard leaves `owner_user_id NULL` — harmless, the unique key still allows it, and the first-run admin seeding will own future writes.
- Keep `idx_suppliers_name` (`:501`) — `list()` still orders/searches by name.
- DDL is non-transactional (CLAUDE.md rule 16); each step is `hasColumn`/`hasIndex`-guarded so a mid-fail re-run is clean.
- **MySQL-9:** `ALTER TABLE … DROP PRIMARY KEY, ADD COLUMN … PRIMARY KEY` and multi-action ALTER are supported; no syntax change vs. 8.

---

## 3. Full call-site touch-list

Repo signature changes (all owner args **optional**, so the change is inert until callers
pass them / the flag is on):

`src/database/repositories/supplierRepo.ts`
- `:52 findByInn(inn)` → `findByInn(inn, ownerUserId?)`. When `ownerUserId != null`, `WHERE inn = ? AND owner_user_id = ?`; else `WHERE inn = ?` (legacy/admin/system path). **Caution:** internal callers `create`/`upsert`/`mergeEmpty` re-read via `this.findByInn(input.inn)` at `:76, :80, :86, :95, :112` — these must pass the owner through or they'll read across tenants.
- `:59 create(input)` → accept `input.owner_user_id` and write it in the INSERT column list (`:61`). Stamp from caller.
- `:79 upsert(input)` → thread owner into the `findByInn` lookup (`:80`) and into `create`/`update`.
- `:94 mergeEmpty(input)` → thread owner into `findByInn` (`:95`) and `create`/`update` (`:97, :111`).
- `:115 update(inn, patch)` → `update(inn, patch, ownerUserId?)`; add `AND owner_user_id = ?` to the `WHERE` (`:127`) when scoped. **Do not** add `owner_user_id` to `SUPPLIER_UPDATE_COLUMNS` — owner is never client-settable.
- `:130 touchLastUsed(inn)` → `touchLastUsed(inn, ownerUserId?)`; scope the UPDATE `WHERE`.
- `:134 delete(inn)` → `delete(inn, ownerUserId?)`; scope the DELETE `WHERE`.
- `:138 list(opts)` → add `opts.ownerUserId?`; when set, push `owner_user_id = ?` into `wheres` (`:139`).

Add a helper mirroring `ownerScopeFor` from `src/api/routes/invoices.ts:153`:
```ts
function supplierScopeFor(req: Request): number | undefined {
  return config.dataScopingEnabled && req.user?.role !== 'admin' ? req.user?.id : undefined;
}
```

`src/api/routes/suppliers.ts` (all under `apiKeyAuth`, so `req.user` exists):
- `:78` `list({ q, verified, limit, offset })` → add `ownerUserId: supplierScopeFor(req)`.
- `:83` `GET /:inn` `findByInn(req.params.inn)` → `findByInn(inn, supplierScopeFor(req))`; non-owner → 404.
- `:92` `POST /` existence check `findByInn(body.inn)` → scope to owner (a duplicate ИНН for *another* tenant must NOT 409).
- `:95` `POST /` `create({…})` → add `owner_user_id: req.user!.id` (always stamp the creator, even when flag off, so data is ready when scoping is later enabled).
- `:108` `PATCH /:inn` existence `findByInn` → scoped.
- `:114` `PATCH /:inn` `update(inn, body)` → `update(inn, body, supplierScopeFor(req))`.
- `:115` `PATCH /:inn` re-read `findByInn` → scoped.
- `:119` `DELETE /:inn` `delete(inn)` → `delete(inn, supplierScopeFor(req))`.
- `:220` `POST /merge` `mergeEmpty({…})` → add `owner_user_id: req.user!.id` to the input.

`src/api/routes/invoices.ts` — Sber send (`POST /:id/send-sber`), owner = the invoice's `owner_user_id` (the request is `req.user`, but the system/auto-send path also hits this — derive owner from the invoice row, NOT `req.user`, so loopback auto-send works; see §4):
- `:1522` `findByInn(invoice.supplier_inn)` → `findByInn(inn, ownerOf(invoice))`.
- `:1532` `upsert({…})` → add `owner_user_id: ownerOf(invoice)`.
- `:1656` `touchLastUsed(supplier.inn)` → `touchLastUsed(inn, ownerOf(invoice))`.

`src/services/enrichSupplier.ts`
- `:27` `findByInn(invoice.supplier_inn)` → `findByInn(inn, invoice.owner_user_id ?? undefined)`. Requires the generic constraint `T extends Pick<Invoice, …>` (`:22`) to also include `owner_user_id`. All call sites already pass full `Invoice` rows (`src/api/routes/invoices.ts:197,207,224,294,432`; `pending` at `:224`) which carry `owner_user_id`, so this is type-only.

`src/services/resolveSupplierName.ts`
- `:25` add an `ownerUserId?: number | null` param. `:31` `findByInn(innTrim)` → `findByInn(innTrim, ownerUserId ?? undefined)`. Thread it from the two callers:
  - `src/watcher/fileWatcher.ts:253` `resolveSupplierName(rawSupplier, inn)` → pass `meta?.ownerUserId` (already plumbed through `FileMeta.ownerUserId`, `:47`, `:608`).
  - `src/api/routes/dispatcher.ts:41` `resolveSupplier()` wrapper → pass the invoice's `owner_user_id` (read the invoice row in the result handler; see §4).

> Exhaustiveness check: `grep "supplierRepo\."` returns exactly the sites above plus the repo's own internal re-reads. `grep "findByInn|enrichInvoiceWithSupplier|resolveSupplierName"` adds the two service callers and the dispatcher/watcher wrappers — all covered.

---

## 4. Owner context for system / integration paths (so they don't break)

The hard requirement (per the parent spec §"code with no user context"): paths without
`req.user` must resolve the **owning tenant** another way. For suppliers the answer is
almost always **"the owner of the invoice being processed"**.

| Path | File:line | Owner context source |
|------|-----------|----------------------|
| **Sber send** (`/:id/send-sber`) | `invoices.ts:1485` | The **invoice's** `owner_user_id`, NOT `req.user`. The interactive caller is the owner, but the dispatcher auto-send loops back with the **admin** api_key — so deriving from `req.user` would look up the admin's supplier card, not the tenant's. Read `invoice.owner_user_id` (already on the row) and pass it to `findByInn`/`upsert`/`touchLastUsed`. When the flag is off, pass `undefined` → global lookup (today's behaviour). |
| **`enrichInvoiceWithSupplier`** | `enrichSupplier.ts:27` | The invoice argument carries `owner_user_id`. Pass it straight in. Covers UI list/detail and **1C `/pending`** (`invoices.ts:224`) since both pass full invoice rows. |
| **1C `/pending`** | `invoices.ts:216` | 1C polls with the admin api_key (`req.user.role==='admin'`), so `enrich` already runs unscoped for admin — but the *correct* enrichment is per-invoice-owner. Because `enrich` keys on `invoice.owner_user_id`, each row gets ITS owner's verified card regardless of who polls. No 1C change needed. (Future per-tenant 1C polling is out of scope — see parent spec.) |
| **`resolveSupplierName`** (watcher) | `fileWatcher.ts:253` | `meta.ownerUserId` — already plumbed from `/api/upload` (`upload.ts:76`) and defaulted to the admin for `/camera`/inbox drops (`fileWatcher.ts:194`). Pass it as the new arg. |
| **`resolveSupplierName`** (dispatcher) | `dispatcher.ts:41` | Load the invoice row in the result handler (`POST /result/:invoiceId`) and pass `invoice.owner_user_id`. The dispatcher already authenticates by per-task token bound to the invoice, so the invoice's owner is authoritative. |
| **Dispatcher auto-send Sber** | `dispatcher.ts:74 autoSendSber` | Unchanged loopback with admin key; correctness comes from the send route reading `invoice.owner_user_id` (row above). The admin key is just transport; ownership is the invoice's. |

**Key invariant:** never resolve a supplier's owner from the *caller's* identity in
system paths — always from the **invoice** (or the watcher `meta`). The caller may be an
admin acting on behalf of a tenant.

---

## 5. Flag-gated rollout (reuse `DATA_SCOPING_ENABLED`)

Same flag as invoices (`config.dataScopingEnabled`, `src/config.ts:68`). No new env var —
suppliers and invoices flip together, which is correct (a tenant who can't see another's
invoices also can't see their supplier bank details). Admin bypass identical to
`ownerScopeFor` (admin → `undefined` → no filter → sees all).

Phasing — each step independently deployable and **inert until the flag is on**:

- **Phase S1 — migration 41 only.** Add column + surrogate id + unique key + backfill. No code reads the column. Deploy, confirm migration applied (`SELECT … FROM migration_history WHERE version=41`), confirm `suppliers` row count unchanged and every row has `owner_user_id` set. Pure schema; zero behaviour change.
- **Phase S2 — stamp owner on write.** `POST /api/suppliers`, `POST /merge`, and the Sber-send `upsert` set `owner_user_id`. Still no read scoping. Safe with flag off — new cards just carry an owner nobody filters on yet.
- **Phase S3 — repo owner args + thread through all read/write call sites** (§3). Each method/route takes the owner; `supplierScopeFor(req)` / `invoice.owner_user_id` supply it. **Behaviour is identical while the flag is off** (every scope resolves to `undefined`). This is the phase that "arms" isolation.
- **Phase S4 — enable.** Set `DATA_SCOPING_ENABLED=true` (already gates invoices). Run the §6 test plan against real tenant accounts first.

Rollback at any phase: S1 is additive (leave it); S2/S3 are inert with the flag off, so
flipping the flag back to `false` restores global behaviour with no redeploy.

---

## 6. Risks + test plan

### Risks
- **Sber send regression (highest).** If the send path resolves the owner from `req.user` instead of `invoice.owner_user_id`, dispatcher auto-send (admin key) would fail to find the tenant's verified card and either 409 `needs_supplier_confirmation` or send the admin's requisites. Mitigation: §4 invariant + test below. Respect CLAUDE.md rules 12–14 (bare token, purpose ≤210 chars, one payment per invoice) — none change here.
- **1C `/pending` enrichment drift.** If `enrich` is scoped to the *polling* user instead of the invoice owner, a tenant's invoice could be exported with another tenant's (or no) verified requisites. Mitigation: key `enrich` on `invoice.owner_user_id` (§4), not the request.
- **Supplier-name forking.** `resolveSupplierName` not receiving the owner would look up the global directory and could snap a tenant's invoice to a *different* tenant's card name. Mitigation: thread owner into both callers (§3).
- **Dedup loss on legacy NULL rows.** Mitigated by backfilling to the admin id before adding the unique key (§2).
- **Cross-tenant 409 on create.** `POST /api/suppliers` existence check must be owner-scoped, else tenant B can't add ИНН that tenant A already has. Covered in §3 `:92`.
- **Double-owned ИНН after enable.** If two tenants legitimately have the same ИНН, each keeps a row — by design. Verify the unique key is `(owner_user_id, inn)`, not `(inn)`.

### Test plan (vitest, `tests/`, real DB guard per CLAUDE.md rule 17 — localhost + `test` DB only)
1. **Migration idempotency:** run migration 41 twice; assert column/id/unique-key present, row count preserved, `detect()` returns true on the second pass.
2. **Backfill:** seed legacy supplier rows (no owner) + one admin; run migration; assert all rows `owner_user_id = MIN(admin id)`.
3. **Isolation read:** create users A (role user) + B (role user); A creates supplier ИНН X; with flag ON, `GET /api/suppliers` and `GET /api/suppliers/X` as B → empty list / 404. As A → visible.
4. **Per-tenant duplicate:** with flag ON, A creates ИНН X, B creates ИНН X with *different* bank details; both succeed (no 409); each reads back their own.
5. **Admin bypass:** admin `GET /api/suppliers` with flag ON → sees both A's and B's rows.
6. **Flag OFF parity:** all of the above with flag OFF → behaves exactly as today (global directory, dedup by ИНН via the path that passes `undefined`).
7. **Sber owner-context:** invoice owned by A with supplier_inn X (verified card owned by A); `POST /:id/send-sber` resolves A's card and builds a valid payload — even when invoked via the admin-key loopback (simulate `autoSendSber`). Assert the payee requisites come from A's card, not admin's.
8. **enrich / 1C `/pending`:** `GET /api/invoices/pending` returns each invoice enriched from ITS owner's verified card (seed two invoices owned by A and B with same ИНН but different verified cards; assert each row carries its own requisites).
9. **resolveSupplierName:** watcher/dispatcher path with `ownerUserId` set snaps the name to the owner's verified card and does not see another owner's card.

---

## 7. Do-NOT list (would break prod if rushed)

- **Do NOT add `owner_user_id` to `SUPPLIER_UPDATE_COLUMNS`** (`supplierRepo.ts:46`). Owner must never be client-settable — it's a second-order SQLi/ownership-takeover vector.
- **Do NOT drop the PK on `suppliers` in a separate ALTER from adding the surrogate `id`.** One combined `DROP PRIMARY KEY, ADD … AUTO_INCREMENT PRIMARY KEY` only — an AUTO_INCREMENT column with no key is rejected mid-migration.
- **Do NOT make `owner_user_id` NOT NULL** (Option B). The invoice model uses nullable owner as the "system-owned" sentinel; keep parity and avoid a forced non-null on first-run empty DBs.
- **Do NOT resolve the supplier owner from `req.user` in the Sber send / dispatcher / 1C paths.** Derive it from `invoice.owner_user_id` (or watcher `meta`). The admin-key loopback makes `req.user` the wrong tenant.
- **Do NOT introduce a second feature flag.** Reuse `DATA_SCOPING_ENABLED` so suppliers and invoices isolate together; a half-isolated state (invoices private, bank details public) is the bug we're fixing.
- **Do NOT scope reads/writes by default.** Every new owner arg is optional and resolves to `undefined` while the flag is off — ship S1–S3 fully inert, enable only in S4 after the test plan passes.
- **Do NOT run the migration or tests against the shared `192.168.33.3` DB** (dev=prod; MEMORY.md + CLAUDE.md rule 17). Use a `test`-named DB on localhost; the `resetDb()` guard must stay.
- **Do NOT edit migration 40 or any earlier migration.** New schema = new object, version 41 (CLAUDE.md rule 16, workflow conventions).
- **Do NOT change `enrichInvoiceWithSupplier`'s "only verified=1 cards substitute" rule** — per-tenant scoping is orthogonal to the verified gate; keep both.
