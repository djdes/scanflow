# Per-tenant integrations + 1C polling + registration policy — design

> Status: **DESIGN ONLY (no code).** Companion to
> [`2026-06-24-multitenant-data-isolation-design.md`](2026-06-24-multitenant-data-isolation-design.md),
> which delivered invoice-level ownership (migration 40 `invoices.owner_user_id`, owner
> stamping on upload/watcher, and flag-gated read scoping behind `DATA_SCOPING_ENABLED`,
> admin bypass). That spec **explicitly deferred** the three areas covered here (see its
> "STILL TODO" header and Phases 4–5).
>
> This spec covers the remaining true-SaaS gap:
> 1. **Per-tenant integration config** — `analyzer_config`, `sber_tokens`, `webhook_config`
>    are singleton `id=1` rows shared across all tenants.
> 2. **Per-tenant 1C polling** — `GET /api/invoices/pending` / `POST /:id/confirm` return /
>    mutate **all** tenants' invoices regardless of which api_key called.
> 3. **Registration policy** — `POST /api/auth/register` (`src/api/routes/auth.ts:78`) is
>    fully open: an anonymous stranger gets a working api_key and full `role='user'` access.
>
> **PREREQUISITE DECISION (carried over, REQUIRED):** the parent spec asks you to pick tenancy
> model **(A) owner+staff** vs **(B) true multi-tenant SaaS**. *This document assumes (B).* If
> the org chooses (A), implement **only §3 (registration gating)** and stop — §1/§2 are
> unnecessary and high-risk for a single-org deployment. **This is a PRODUCT decision.**

---

## 0. Current state — verified call sites (read-only audit, 2026-06-24)

### 0.1 `analyzer_config` (singleton `id=1`)
Schema: created in migration v2 (`src/database/migrations.ts:131`) with **`CHECK (id = 1)`**;
columns added incrementally up to `dadata_api_key` (migration v38, line ~765). Holds: `mode`
(`hybrid`|`claude_api`|`dispatcher`), `anthropic_api_key`, `claude_model`, `llm_mapper_enabled`,
`auto_send_1c`, `auto_send_sber`, `projectsflow_token`, `projectsflow_project_id`,
`dadata_api_key`.

Repo: `src/database/repositories/invoiceRepo.ts:1011` `getAnalyzerConfig()` (`WHERE id = 1`)
and `:1028` `updateAnalyzerConfig(...)` (`WHERE id = 1`).

**Every caller of `getAnalyzerConfig()` (must take a tenant under model B):**
| # | File:line | Context | Has `req.user`? |
|---|-----------|---------|-----------------|
| 1 | `src/api/routes/settings.ts:12,60,74,77` | GET/PUT `/api/settings/analyzer` | ✅ (admin-gated PUT) |
| 2 | `src/api/routes/invoices.ts:858` | `/:id/llm-remap` | ✅ |
| 3 | `src/api/routes/dispatcher.ts:52` | dispatcher prompt/route | ⚠️ per-task token, no api_key |
| 4 | `src/api/routes/suppliers.ts:133,242` | extract-from-photo / status | ✅ |
| 5 | `src/dispatcher/createTask.ts:94` | `resolvePfConfig()` (PF token+project) | ❌ background |
| 6 | `src/ocr/ocrManager.ts:20,68,245,278,315,349` | OCR engine + Claude key selection | ❌ background |
| 7 | `src/watcher/fileWatcher.ts:303,370,470,648,973,1216,1356` | watcher OCR + auto-send | ❌ background |

`updateAnalyzerConfig()` callers: only `src/api/routes/settings.ts:82,84` (admin PUT).

### 0.2 `sber_tokens` (singleton `id=1`)
Schema: migration v? (`src/database/migrations.ts:467`) with **`CHECK (id = 1)`**. One OAuth
connection + payer requisites for the whole platform.

Repo: `src/database/repositories/sberTokenRepo.ts` — every method hard-codes `id = 1`
(`get` :32, `upsert` :44, `updateTokens` :77, `updatePayerDetails` :106, `clear` :110).

**Every `sberTokenRepo.*` call site:**
| # | File:line | Method | Has `req.user`? |
|---|-----------|--------|-----------------|
| 1 | `src/sber/oauth.ts:105,115` | `get`, `updateTokens` (in `getValidAccessToken()`) | ❌ — called from request + watcher |
| 2 | `src/api/routes/sber.ts:47,54,92,106,124,132,161` | OAuth callback / seed-token / payer / status / disconnect | ✅ admin-gated (callback is public redirect) |
| 3 | `src/api/routes/invoices.ts:1513` | `/:id/send-sber` reads payer row | ✅ |

`getValidAccessToken()` (`src/sber/oauth.ts:104`) callers: `src/api/routes/invoices.ts:1564`
(`/:id/send-sber`) and the watcher auto-send path (loopback HTTP — see below).

### 0.3 `webhook_config` (singleton `id=1`)
Schema: migration v1 (`src/database/migrations.ts:107`), `auto_send_1c` added v? (line 259).

Read/write sites — **all hard-code `WHERE id = 1`**:
- `src/api/routes/webhook.ts:18,27,29,32,36,47` — GET/PUT/POST `/api/webhook/*` (admin-gated mount).
- `src/integration/webhook.ts:15` — `getWebhookConfig()` inside `sendToWebhook(invoiceId)`.
  `sendToWebhook` is called from `src/api/routes/invoices.ts:465` (`/:id/send`).

### 0.4 1C polling — one shared admin key
- `GET /api/invoices/pending` (`src/api/routes/invoices.ts:216`) → `invoiceRepo.getPendingWithItems({limit,offset})`
  (`src/database/repositories/invoiceRepo.ts:207`). The `pendingWhere` clause has **no owner
  filter** — it returns every tenant's `approved_for_1c=1` rows. It also **stamps
  `onec_pulled_at`** (reservation, :256) across all tenants at once.
- `POST /api/invoices/:id/confirm` (`src/api/routes/invoices.ts:516`) — looks up by `id` only,
  no owner check; marks sent + clears `approved_for_1c`.
- Both authenticate via `apiKeyAuth` (`src/api/middleware/auth.ts:32`) which already resolves
  `req.user = { id, username, role }` from `users.api_key`. **The tenant identity is already in
  hand — it just isn't used to scope the query.**
- 1C side calls with ONE admin api_key (the `.env` `API_KEY`, seeded onto the admin user per
  CLAUDE.md "Local dev").

### 0.5 Background code with NO user context (the hard part)
- `src/ocr/ocrManager.ts`, `src/watcher/fileWatcher.ts`, `src/dispatcher/createTask.ts` run
  with no `req`. They call `getAnalyzerConfig()` / `getValidAccessToken()` directly.
- Watcher auto-send paths use `userRepo.firstUserId()` (`src/watcher/fileWatcher.ts:194`) as
  the admin api_key for loopback Sber send, and notifications fall back to `firstUserId()`
  (`src/database/repositories/userRepo.ts:158`, comment: "current single-user setup").
- Invoices already carry `owner_user_id` (migration 40). **This is the key that lets background
  code resolve a tenant: read the invoice row → `owner_user_id` → that tenant's config.**

### 0.6 Registration today
- `src/api/routes/auth.ts:78` `POST /register` — instant: validates username/password, creates
  `role='user'` + fresh `api_key`, returns the key in the 201 body. **No verification at all.**
- `src/api/routes/auth.ts:133` `POST /register-email` — generates username/temp-password/magic
  token, emails them, does **not** return the api_key (forces the user through email). Magic link
  consumed at `GET /magic/:token` (`src/api/server.ts:245`).
- Both share the `/api/auth` rate limiter (20 req / 5 min per-IP).

---

## 1. Per-tenant integration config

> **PRODUCT decision required:** does each tenant bring their **own** Anthropic/DaData key, or
> does the platform pay for OCR centrally? This changes whether `anthropic_api_key`/`claude_model`/
> `mode` become per-tenant or stay platform-global. Recommended split below.

### 1.1 Recommended column split (avoid "every key is per-tenant")
Not all of `analyzer_config` should fork per tenant. Split into:
- **Platform-global (keep `id=1`):** `mode`, `anthropic_api_key`, `claude_model`,
  `llm_mapper_enabled`, `projectsflow_token`, `projectsflow_project_id`. The OCR engine, model,
  and dispatcher infra are operated by the platform. Keeping these global means the OCR pipeline
  and watcher (no user context) need **no change** to recognise an image — eliminating the
  biggest blast-radius risk.
- **Per-tenant (new rows):** `auto_send_1c`, `auto_send_sber`, `dadata_api_key`, the **Sber
  connection** (`sber_tokens`), and the **webhook** (`webhook_config`). These are genuinely
  per-customer (each tenant's bank, each tenant's 1C endpoint, each tenant's auto-send policy).

This is the smallest correct cut. Forking `mode`/`anthropic_api_key` per tenant is possible but
should be a **separate, later** decision — call it out, do not bundle it.

### 1.2 Migrations (MySQL 9, idempotent, next versions 41 → 43)

All follow the existing `hasColumn`/`hasTable`/`hasIndex` guard style
(`src/database/migrations.ts:25-51`). The singleton tables carry **`CHECK (id = 1)`** — a
per-`user_id` table **cannot** be the same table; introduce sibling per-tenant tables and keep
the `id=1` row as the **platform default / fallback**. This is safer than mutating PKs on a live
table.

**Migration 41 — per-tenant Sber connections.**
```ts
{
  version: 41,
  name: 'per-tenant sber connections (sber_tokens_by_user)',
  detect: (exec) => hasTable(exec, 'sber_tokens_by_user'),
  run: async (exec) => {
    if (!(await hasTable(exec, 'sber_tokens_by_user'))) {
      await exec.query(`
        CREATE TABLE sber_tokens_by_user (
          user_id                  INT PRIMARY KEY,
          access_token             TEXT NOT NULL,
          refresh_token            TEXT NOT NULL,
          expires_at               DATETIME NOT NULL,
          account_number           VARCHAR(64) NULL,
          org_name                 VARCHAR(512) NULL,
          payer_inn                VARCHAR(32) NULL,
          payer_kpp                VARCHAR(32) NULL,
          payer_bank_bic           VARCHAR(32) NULL,
          payer_bank_corr_account  VARCHAR(64) NULL,
          created_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT fk_sbt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    }
    // Backfill: copy the existing singleton row to the admin (lowest-id) user so
    // the current owner's Sber stays connected after cutover.
    if (await hasTable(exec, 'sber_tokens')) {
      await exec.query(`
        INSERT IGNORE INTO sber_tokens_by_user
          (user_id, access_token, refresh_token, expires_at, account_number, org_name,
           payer_inn, payer_kpp, payer_bank_bic, payer_bank_corr_account)
        SELECT (SELECT id FROM users ORDER BY id LIMIT 1),
               access_token, refresh_token, expires_at, account_number, org_name,
               payer_inn, payer_kpp, payer_bank_bic, payer_bank_corr_account
        FROM sber_tokens WHERE id = 1
      `);
    }
  },
}
```
> Keep `sber_tokens` (id=1) in place — do **not** drop it in the same migration. It is the
> rollback path. Drop it in a much later cleanup migration only after the per-tenant path is
> proven in prod.

**Migration 42 — per-tenant webhook config.**
```ts
{
  version: 42,
  name: 'per-tenant webhook config (webhook_config_by_user)',
  detect: (exec) => hasTable(exec, 'webhook_config_by_user'),
  run: async (exec) => {
    if (!(await hasTable(exec, 'webhook_config_by_user'))) {
      await exec.query(`
        CREATE TABLE webhook_config_by_user (
          user_id      INT PRIMARY KEY,
          url          VARCHAR(1024) NOT NULL DEFAULT '',
          enabled      TINYINT(1) NOT NULL DEFAULT 0,
          auth_token   VARCHAR(512) NULL,
          auto_send_1c TINYINT(1) NOT NULL DEFAULT 0,
          CONSTRAINT fk_whc_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    }
    if (await hasTable(exec, 'webhook_config')) {
      await exec.query(`
        INSERT IGNORE INTO webhook_config_by_user (user_id, url, enabled, auth_token, auto_send_1c)
        SELECT (SELECT id FROM users ORDER BY id LIMIT 1), url, enabled, auth_token, auto_send_1c
        FROM webhook_config WHERE id = 1
      `);
    }
  },
}
```

**Migration 43 — per-tenant auto-send + DaData on a per-user analyzer overlay.**
Rather than fork all of `analyzer_config`, add a thin overlay table holding only the per-tenant
columns; `mode`/keys stay global (§1.1).
```ts
{
  version: 43,
  name: 'per-tenant analyzer overlay (analyzer_config_by_user: auto-send + dadata)',
  detect: (exec) => hasTable(exec, 'analyzer_config_by_user'),
  run: async (exec) => {
    if (!(await hasTable(exec, 'analyzer_config_by_user'))) {
      await exec.query(`
        CREATE TABLE analyzer_config_by_user (
          user_id        INT PRIMARY KEY,
          auto_send_1c   TINYINT(1) NOT NULL DEFAULT 0,
          auto_send_sber TINYINT(1) NOT NULL DEFAULT 0,
          dadata_api_key TEXT NULL,
          CONSTRAINT fk_acu_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    }
    if (await hasTable(exec, 'analyzer_config')) {
      await exec.query(`
        INSERT IGNORE INTO analyzer_config_by_user (user_id, auto_send_1c, auto_send_sber, dadata_api_key)
        SELECT (SELECT id FROM users ORDER BY id LIMIT 1), auto_send_1c, auto_send_sber, dadata_api_key
        FROM analyzer_config WHERE id = 1
      `);
    }
  },
}
```

### 1.3 Repo changes (add `userId`, keep id=1 fallback)

The pattern everywhere: **new `userId`-aware method**; old method delegates to it with the admin
fallback id so existing background callers compile unchanged during rollout.

- `src/database/repositories/sberTokenRepo.ts`
  - Add `getForUser(userId)`, `upsertForUser(userId, input)`, `updateTokensForUser(userId, …)`,
    `updatePayerDetailsForUser(userId, …)`, `clearForUser(userId)` against `sber_tokens_by_user`.
  - Keep `get()/upsert()/…` as deprecated shims that resolve `userId = firstUserId()` then
    delegate — guarded by `config.perTenantIntegrationsEnabled` (new flag, §1.5). When the flag
    is OFF they keep hitting `sber_tokens` (id=1) unchanged.
- `src/database/repositories/invoiceRepo.ts:1011/1028`
  - Add `getAnalyzerOverlayForUser(userId)` (reads `analyzer_config_by_user`, falls back to the
    `id=1` row when no per-user row) and `updateAnalyzerOverlayForUser(userId, {auto1c, autoSber,
    dadata})`. Leave `getAnalyzerConfig()` returning the **global** mode/keys merged with the
    overlay for a given user (overload: `getAnalyzerConfig(userId?)`). When `userId` omitted →
    id=1 (current behaviour).
- New `src/database/repositories/webhookConfigRepo.ts` (none exists today — `webhook.ts` inlines
  SQL): `getForUser(userId)`, `upsertForUser(userId, …)`. The route + `integration/webhook.ts`
  move off raw `WHERE id = 1` SQL onto it.

### 1.4 Route + background call-site threading

| Call site | Change |
|-----------|--------|
| `src/api/routes/settings.ts:12,60,74,77,82,84` | GET/PUT operate on `req.user.id`'s overlay (auto-send + dadata); keep admin-only PUT for the **global** mode/keys. Split UI: tenant edits auto-send; admin edits mode/keys. |
| `src/api/routes/sber.ts:*` | Thread `req.user.id` into every `sberTokenRepo.*`. OAuth `callback` (:29, public redirect) has no `req.user` — carry the tenant in the **signed OAuth `state` JWT** (`createOAuthState({purpose:'connect', userId})` in `src/sber/oauth.ts:24`; read it back at :41). |
| `src/api/routes/invoices.ts:1513` (`/:id/send-sber`) | Read the **invoice's `owner_user_id`**, not a global row → `sberTokenRepo.getForUser(invoice.owner_user_id)`. Same for `getValidAccessToken` (§1.6). Replace `userRepo.firstUserId()` at :1578 with `invoice.owner_user_id`. |
| `src/api/routes/invoices.ts:465` (`/:id/send`) | `sendToWebhook(invoiceId)` → resolve owner inside `sendToWebhook` (§1.6). |
| `src/api/routes/webhook.ts:*` | All `WHERE id=1` → `webhookConfigRepo.*ForUser(req.user.id)`. |
| `src/api/routes/suppliers.ts:133,242` | DaData key from the caller's overlay: `getAnalyzerConfig(req.user.id)`. |
| `src/api/routes/dispatcher.ts:52` & `src/dispatcher/createTask.ts:94` | PF token/project stay **global** (§1.1) → no change. |
| `src/ocr/ocrManager.ts:*`, `src/watcher/fileWatcher.ts:*` (OCR reads) | Mode/Claude key stay **global** → **no change** (the deliberate win of §1.1). |

### 1.5 How background code (no `req.user`) selects a tenant's config
Resolution rule, in priority order:
1. **From the invoice row.** Any per-invoice integration action (auto-send 1C/Sber, webhook
   send, dispatcher result) already has an `invoiceId` → load `owner_user_id` (migration 40,
   always populated) → use that tenant's overlay/Sber/webhook row.
2. **Fallback to `firstUserId()`** when `owner_user_id IS NULL` (legacy rows) or the per-tenant
   row is missing — i.e. the existing single-owner behaviour. This keeps prod working during
   backfill.
3. **OCR recognition itself** (image → JSON) uses the **global** config (§1.1) and needs no
   tenant — by design.

Concretely:
- `src/watcher/fileWatcher.ts:192` `autoSendSber(invoiceId)` — replace `firstUserId()` (:194)
  with `SELECT owner_user_id FROM invoices WHERE id=?`, then use that user's api_key + Sber row.
- Watcher auto-send-1C path — gate on **that owner's** `analyzer_config_by_user.auto_send_1c`,
  not the global flag.
- `src/integration/webhook.ts:13` `getWebhookConfig()` — change signature to
  `getWebhookConfig(ownerUserId)`; `sendToWebhook(invoiceId)` loads `owner_user_id` first.

### 1.6 `getValidAccessToken()` must become tenant-aware
`src/sber/oauth.ts:104` reads `sberTokenRepo.get()` (id=1) and shares **one** process-wide
`inflightRefresh` promise (:102). Under per-tenant:
- Signature → `getValidAccessToken(userId)`; read/write `…ForUser(userId)`.
- The single `inflightRefresh` must become a **per-user map** (`Map<number, Promise<string>>`)
  or two tenants refreshing concurrently will serialize incorrectly. **Do NOT** keep one shared
  promise — that is a correctness bug under multi-tenant (one tenant's refresh would return
  another's token).
- Keep the rotation-safety comment intact; the clustered-deploy caveat (DB row lock) still
  applies per-user.

### 1.7 Phased + flag-gated rollout (risk-ordered, lowest first)
New flag `config.perTenantIntegrationsEnabled = envBool('PER_TENANT_INTEGRATIONS_ENABLED', false)`
in `src/config.ts` (mirror `dataScopingEnabled`, :68). All cutover branches read it; default OFF.

- **Phase 1.A — migrations only (41–43 + backfill).** Additive sibling tables; nothing reads
  them yet. Safe to deploy alone. Verify backfill copied the admin's Sber/webhook/auto-send.
- **Phase 1.B — repos gain `…ForUser` methods + `webhookConfigRepo`.** No callers switched yet.
  Pure addition. Unit-test the new methods.
- **Phase 1.C — flip reads behind the flag.** When `PER_TENANT_INTEGRATIONS_ENABLED=false`,
  every new path falls back to id=1 / `firstUserId()` (identical to today). When `true`, routes
  use `req.user.id` and background code resolves owner from the invoice. Ship dark; enable in a
  separate change after verifying the owner's flows.
- **Phase 1.D (later) — drop singleton tables** in a cleanup migration, only after weeks of
  stable per-tenant operation.

### 1.8 Risks to the OCR pipeline (call out loudly)
- **The whole point of §1.1 is that OCR recognition stays global.** If a future change forks
  `mode`/`anthropic_api_key`/`claude_model` per tenant, the watcher and `ocrManager` (no user
  context) would need to resolve a tenant **before** they have an invoice owner — there is none
  yet at recognition time. That is a much harder problem (per-inbox-folder ownership, or
  recognise-then-assign). **Do not undertake it as part of this spec.**
- Watcher auto-send is the riskiest mutation: a wrong owner resolution could send **tenant A's
  invoice to tenant B's bank**. Auto-send paths MUST hard-fail closed (skip + log) when
  `owner_user_id IS NULL` rather than fall back to a default bank.
- `getValidAccessToken` shared-promise bug (§1.6) is the single most dangerous correctness item.

---

## 2. Per-tenant 1C polling

The tenant identity is already resolved by `apiKeyAuth` (`req.user.id`). The fix is purely
**scoping the two handlers + the repo method by the calling key's user**, with admin bypass for
backward compat.

### 2.1 Mapping: one api_key per tenant's 1C
- Each tenant configures their 1C external processing with **their own** ScanFlow api_key
  (`users.api_key`). That key already maps 1:1 to a user via `userRepo.findByApiKey`
  (`src/api/middleware/auth.ts:23`). No new table needed.
- `GET /api/invoices/pending` returns only invoices where `owner_user_id = req.user.id`.
- `POST /:id/confirm` only confirms an invoice the caller owns.

### 2.2 Backward compatibility (the current single-owner 1C keeps working unchanged)
The existing 1C uses the **admin** key. Two compatible behaviours, gated by `DATA_SCOPING_ENABLED`
(reuse the existing flag — this is the same tenancy switch, no new flag):
- **Admin caller → sees ALL pending** (today's behaviour). `req.user.role === 'admin'` bypasses
  the owner filter, exactly like the invoice list does via `ownerScopeFor`
  (`src/api/routes/invoices.ts:153`). So the current admin-key 1C is **unaffected**.
- **Non-admin tenant caller → sees only their own.**
- When `DATA_SCOPING_ENABLED=false`, behaviour is identical to today for everyone (no filter).

### 2.3 Touch-list
- `src/api/routes/invoices.ts:216` (`GET /pending`) — pass `ownerScopeFor(req)` (existing helper,
  :153) into `getPendingWithItems`.
- `src/database/repositories/invoiceRepo.ts:207` `getPendingWithItems(opts)` — add
  `opts.ownerUserId?: number`. When set, append `AND owner_user_id = ?` to **both** the COUNT
  (:235) and SELECT (:242) `pendingWhere`, and to the reservation `UPDATE … onec_pulled_at`
  (:256) so one tenant's poll does not reserve another tenant's rows.
  - ⚠️ **Reservation isolation is load-bearing.** Without scoping the `UPDATE onec_pulled_at`,
    tenant A's poll would hide tenant B's invoices from B's poll for 3 minutes (CLAUDE.md context
    on duplicate ПриходнаяНакладная). Scope it.
- `src/api/routes/invoices.ts:516` (`POST /:id/confirm`) — after `getById`, if
  `config.dataScopingEnabled && req.user.role !== 'admin' && invoice.owner_user_id !== req.user.id`
  → return 404 (not 403 — don't leak existence). Mirror the existing detail-route guard at
  `src/api/routes/invoices.ts:139`.

### 2.4 Phasing
- **Phase 2.A** — repo `ownerUserId` param (defaulted off) + handler threading, all behind
  `DATA_SCOPING_ENABLED`. Deployable with the flag off = no behaviour change.
- **Phase 2.B** — give each real tenant their own api_key in their 1C; then enable the flag.
- Depends on migration 40 (`owner_user_id`) already shipped — ✅ done per parent spec.

### 2.5 Do NOT break prod
- The admin-bypass branch **must** remain so the production single-owner 1C polling is byte-for-
  byte unchanged. Verify with an integration test asserting an admin key still receives a
  non-owned approved invoice in `/pending`.
- Express route order: `GET /pending` and `GET /stats` already register before `GET /:id`
  (CLAUDE.md rule 8) — do not move them when editing.

---

## 3. Registration policy

> **PRODUCT decision required:** open+verify vs invite-only vs admin-approval. Options and the
> **smallest safe change** below.

### 3.1 The hole, today
`POST /api/auth/register` (`src/api/routes/auth.ts:78`) returns a **live api_key in the 201 body**
to anyone, no email proof, no admin gate. Combined with shared data (pre-`DATA_SCOPING_ENABLED`)
and shared integration config, a stranger currently can read every invoice and, depending on
admin gating, probe settings. **This is the single highest-severity item in this spec.**

### 3.2 Options

| Option | Mechanism | Pros | Cons |
|--------|-----------|------|------|
| **(O1) Open + email verification** | Disable instant `/register`; route all signup through the existing `/register-email` → magic-link flow (`auth.ts:133`, `server.ts:245`). User only gets a key after clicking the emailed link. | Reuses code that **already exists & works**. Self-service preserved. Proves a real mailbox → kills drive-by bots. Smallest diff. | Anyone with an email still gets in (no human gate). Depends on mailer being healthy (`src/utils/mailer.ts`). |
| **(O2) Invite-only** | New `invites` table (token, created_by, email, used_at). `/register` requires a valid unused token. Admin generates invites in UI. | Strong control; only intended tenants get accounts. | New table + migration + admin UI + token email. Largest build. Breaks frictionless signup. |
| **(O3) Admin-approval** | `/register` creates the user with `status='pending'` (or `role='pending'`); `apiKeyAuth` rejects until an admin approves. | Self-service form stays; humans vet each account. | New user state + middleware check + admin approval UI + the api_key must NOT work until approved (extra `apiKeyAuth` guard). |

### 3.3 Recommended: smallest safe change that stops anonymous strangers TODAY
**Adopt O1 now; layer O2/O3 later if needed.** Two-line-class change, no migration:

1. In `src/api/routes/auth.ts`, **stop returning the api_key from `POST /register`**. Either:
   - **(a) Hard-disable** the instant route — make `/register` 410/404 or internally delegate to
     the same `register-email` logic (generate creds, email magic link, respond `{ok:true}`
     WITHOUT the key), **or**
   - **(b) Feature-flag it:** `config.openRegistrationEnabled = envBool('OPEN_REGISTRATION', false)`.
     When false (default), `/register` returns 403 and the UI shows only the email-verify path.
2. Keep `/register-email` (`auth.ts:133`) and `GET /magic/:token` (`server.ts:245`) as the sole
   signup funnel. They already: generate username/temp-password/magic-token, email them, and
   withhold the api_key until the link is clicked. **No new schema.**
3. **Frontend:** point the signup form at `/register-email`. (Out of scope to detail here, but
   note `public/js/app.js` / auth UI must switch the call.)

This removes anonymous instant access with the **least code and zero migration**, and it reuses a
verified path. If the product later wants human gating, add O2 (invite table, next free migration
44) or O3 (pending-status guard in `apiKeyAuth`).

### 3.4 Hardening regardless of option
- The `/api/auth` limiter (20/5min) is shared; consider a **tighter** per-IP limit on
  `register`/`register-email` specifically (e.g. 5/hour) to blunt mailbox-flooding. (Product call.)
- `/register-email` already resists email-enumeration (`auth.ts:141-148` re-issues rather than
  saying "taken") — preserve that.

### 3.5 Do NOT break prod
- The admin account and existing tenant logins use `POST /login` (`auth.ts:45`) — untouched by
  any registration change. Do not alter `/login`.
- The admin api_key seeded from `.env` `API_KEY` powers 1C/mobile-camera integrations — never
  regenerate or invalidate it as part of registration hardening.

---

## 4. Order of all phases by risk (lowest → highest)

| Order | Phase | Section | PRODUCT decision? | Flag | Reversible? |
|-------|-------|---------|-------------------|------|-------------|
| 1 | **Registration → O1** (disable instant `/register`) | §3.3 | ✅ which option | `OPEN_REGISTRATION` | yes (flag) |
| 2 | 1C polling repo+handler scoping (flag off) | §2.4 A | — | `DATA_SCOPING_ENABLED` (reuse) | yes |
| 3 | Per-tenant migrations 41–43 + backfill | §1.7 A | — | n/a (additive) | yes (tables unused) |
| 4 | `…ForUser` repos + `webhookConfigRepo` | §1.7 B | — | n/a (additive) | yes |
| 5 | Flip integration reads behind flag | §1.7 C | ✅ which cols per-tenant (§1.1) | `PER_TENANT_INTEGRATIONS_ENABLED` | yes (flag) |
| 6 | `getValidAccessToken` per-user refresh map | §1.6 | — | (within flag) | yes |
| 7 | Enable flags in prod (separate change, post-verify) | §1.7 C / §2.4 B | ✅ go/no-go | flags ON | yes (flags) |
| 8 | (Later) drop singleton tables; optional O2/O3 registration | §1.7 D / §3.2 | ✅ | n/a | migration |

**PRODUCT decisions blocking start:** tenancy model A vs B (gate for §1/§2 at all); which
`analyzer_config` columns fork per-tenant (§1.1); registration option O1/O2/O3 (§3.2). Everything
else is mechanical.

---

## 5. Test plan

> 🔥 CLAUDE.md rule 17: tests connect ONLY to `localhost`/`*test*` DB; `tests/helpers/db.ts`
> guard must stay. Never run these against the shared `192.168.33.3` instance. TDD per CLAUDE.md
> (tests first). Mock Sber/webhook/mailer (`vi.mock`) — never hit real endpoints.

### 5.1 Migrations (41–43)
- Idempotency: run twice on a fresh test DB → no error, tables exist once (mirror existing
  migration tests).
- Backfill: seed one `sber_tokens`/`webhook_config`/`analyzer_config` id=1 row + ≥2 users →
  assert the lowest-id user got the copied row; others got none.

### 5.2 Per-tenant integration repos
- `sberTokenRepo.getForUser` returns the right row; isolation: user A's token ≠ user B's.
- `getValidAccessToken(userId)` — two users with separate refresh tokens both refresh correctly;
  assert the per-user inflight map does NOT cross tokens (regression guard for §1.6).
- `webhookConfigRepo` / analyzer overlay: per-user read/write isolation.

### 5.3 1C polling (§2) — the headline tests
- Tenant A approves invoice; tenant B's key calls `/pending` → A's invoice **absent**.
- A's key calls `/pending` → present, and `onec_pulled_at` stamped **only** on A's rows.
- **Backward-compat:** admin key calls `/pending` → sees a non-owned approved invoice (today's
  behaviour preserved).
- `POST /:id/confirm` by a non-owner non-admin → 404; by owner → 200; by admin on any → 200.
- Flag OFF (`DATA_SCOPING_ENABLED=false`) → all of the above behave exactly as pre-change (no
  filtering).

### 5.4 Registration (§3)
- `POST /register` with `OPEN_REGISTRATION=false` → 403/410, **no api_key in body**.
- `/register-email` → 201 `{ok:true}` with NO api_key; a `magic_token` row created; `GET /magic/:token`
  bootstraps the key. (Mock `sendAuthEmail`.)
- Enumeration: `/register-email` for an existing email → same neutral response as new (no "taken").

### 5.5 Send paths (§1.5/1.6)
- Auto-send Sber resolves the **invoice owner's** bank, not `firstUserId()`; with
  `owner_user_id IS NULL` it **skips + logs** (fail-closed), never falls back to a default bank.
- `sendToWebhook` posts to the owner's webhook URL; a tenant with webhook disabled → no send.

---

## 6. Explicit "do NOT break prod" warnings

1. **Never run migrations/tests against `192.168.33.3` (dev=prod).** Copy the DB first; the
   `resetDb()` guard (CLAUDE.md rule 17) must remain — it once truncated prod.
2. **Keep singleton `id=1` tables as the live fallback** until the per-tenant path is proven.
   Backfill copies; do not move/drop in the same migration.
3. **Admin bypass is sacred.** The production single-owner 1C uses the admin key; `/pending`,
   `/confirm`, and integration config MUST behave identically for an admin caller. Test it.
4. **`getValidAccessToken` shared-promise → per-user map** is a correctness fix, not an optional
   cleanup. Skipping it can hand one tenant another tenant's bank token.
5. **Auto-send must fail closed** on unknown owner — never send to a default bank/webhook.
6. **Do not regenerate the admin `.env` `API_KEY`** during registration hardening — it powers
   1C + mobile camera.
7. **Everything ships behind a flag** (`OPEN_REGISTRATION`, `DATA_SCOPING_ENABLED`,
   `PER_TENANT_INTEGRATIONS_ENABLED`), defaulting to current behaviour, enabled only in a
   separate post-verification change.
8. **Migrations idempotent** (CLAUDE.md rule 16): `hasTable`/`hasColumn`/`INSERT IGNORE` guards;
   MySQL DDL is non-transactional, a partial failure must replay cleanly.
