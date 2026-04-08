# Day 1 Plan - Security Hardening

> This plan should be completed before any performance work ships.

## Scope

Close the main security gaps discovered in the audit without changing business behavior more than necessary.

## Main Findings To Address

- Hardcoded secrets in source.
- Unauthenticated `/api/errors` and `/api/reprocess-errors`.
- API key accepted via query string.
- API key leaked into image URLs on the frontend.
- Overly open CORS defaults.
- Mailer TLS validation disabled.

## Files Likely In Scope

- `src/config.ts`
- `src/utils/mailer.ts`
- `src/api/server.ts`
- `src/api/middleware/auth.ts`
- `src/api/routes/invoices.ts`
- `public/js/invoices.js`
- `.env.example`
- any docs referencing old auth behavior

## Task Checklist

### 1. Remove Secrets From Source

- [ ] Remove hardcoded fallback secrets from `src/config.ts`.
- [ ] Remove hardcoded SMTP defaults from `src/utils/mailer.ts`.
- [ ] Ensure secrets come only from environment or explicitly disabled config.
- [ ] Update `.env.example` so it documents required variables without real values.
- [ ] Rotate the previously exposed secrets after the code change.

Done when:

- `rg -n "sk-ant|your-secret-api-key|wesetup|0M2r8H4t|bugdenes@gmail.com" src .env.example` returns no active hardcoded secrets in source files meant for commit.

### 2. Protect Sensitive Endpoints

- [ ] Move `/api/errors` behind the same auth middleware as the rest of the API, or explicitly gate it.
- [ ] Move `/api/reprocess-errors` behind auth.
- [ ] Re-check route registration order in `src/api/server.ts`.

Done when:

- the endpoints return `401` or `403` without a valid API key
- the endpoints still work with valid auth

### 3. Remove Query-String Auth

- [ ] Stop reading `req.query.key` in `src/api/middleware/auth.ts`.
- [ ] Use only header-based auth or a more explicit token flow.
- [ ] Update any affected client calls.

Done when:

- no endpoint depends on `?key=...`
- image loading still works via a safe alternative

### 4. Stop Leaking Keys Into Image URLs

- [ ] Replace `<img src="...?...key=...">` in `public/js/invoices.js`.
- [ ] Preferred options:
  - fetch the image with auth header and convert to `blob:` URL on the client
  - or issue short-lived signed URLs from the backend
- [ ] Keep the solution simple for Day 1; header-based fetch plus blob URL is enough.

Done when:

- browser-visible image URLs do not contain API keys
- photos still render in the invoice detail UI

### 5. Tighten CORS And Mailer Safety

- [ ] Replace broad `cors()` with an allowlist or a disabled-by-default config.
- [ ] Remove `rejectUnauthorized: false` from mailer TLS settings unless there is a documented, unavoidable local-only reason.
- [ ] Decide whether mail sending should fail closed or be disabled when SMTP config is missing.

Done when:

- cross-origin access is explicit
- mailer does not silently allow insecure TLS

## Verification

- [ ] `npm run build`
- [ ] App boots locally
- [ ] `GET /api/errors` without auth fails
- [ ] `POST /api/reprocess-errors` without auth fails
- [ ] invoice photos still load in the UI
- [ ] no API key appears in image URLs, browser history, or obvious logs

## Suggested Commit Shape

Prefer 2 or 3 commits instead of one giant change:

1. `security: remove hardcoded secrets and unsafe mailer defaults`
2. `security: protect sensitive API routes and remove query auth`
3. `security: stop leaking API keys in invoice photo requests`

## Important Rollout Note

Because credentials were present in source, the work is not complete after code changes. Secret rotation is part of the fix.

