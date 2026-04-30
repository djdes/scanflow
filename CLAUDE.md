# ScanFlow — project guide for Claude

> Russian invoice OCR service that turns photos of paper invoices into 1C:UNF documents.
> Domain is Russian (1C, suppliers, накладные); identifier names in 1C metadata are Cyrillic.
> The full pre-trim version of this file lives at [`docs/_archive/CLAUDE-v1.6-2026-04-30.md`](docs/_archive/CLAUDE-v1.6-2026-04-30.md) — read it when you need exhaustive history; this file is the cheat sheet.

## Pipeline

```
JPG photo → OCR (Google Vision → Claude API → Tesseract) → parser → nomenclature mapper → SQLite → 1C webhook/REST
```

**Production:** https://scanflow.ru (Ubuntu 24.04, FastPanel, PM2 process `scanflow`, port 8899). GitHub Actions auto-deploys on push to `main`.

## Tech stack

- **Runtime:** Node.js 25 + TypeScript (strict). Server is plain Express 5; frontend is vanilla HTML/CSS/JS with hash routing — no build step for client.
- **DB:** SQLite (better-sqlite3, WAL mode), single file `data/database.sqlite`. Schema lives in `src/database/migrations.ts` as a numbered array. Currently at migration 19.
- **OCR mode (`analyzer_config.mode`):** `claude_api` in production — Claude SDK reads the image directly, one call. The legacy `hybrid` mode (Google Vision OCR → Claude text structuring) is still in code.
- **Auth:** every API call needs `X-API-Key` header that maps to `users.api_key`. UI logs in via `POST /api/auth/login` (username + scrypt-hashed password) and stores the returned key in `localStorage`. There is no JWT and no session cookie.
- **Notifications:** Telegram bot per user (`users.telegram_chat_id` + `bot_token`). Email infra (`src/utils/mailer.ts`, `src/notifications/templates.ts`, `digestWorker.ts`, `notification_events` table) is **dead code kept for back-compat** — no events flow through it.
- **Logging:** Winston to `logs/`. `sendErrorEmail` to `MAIL_TO` is wired only for `uncaughtException` and disk space alerts.

## Key directories

```
src/
  api/              Express routes (auth, invoices, mappings, profile, settings, upload, webhook, debug)
  database/         migrations.ts + repositories/ (one repo per table)
  ocr/              ocrManager + claudeApiAnalyzer (image → JSON), googleVision, tesseract
  parser/           invoiceParser (regex fallback when Claude isn't used), itemSanitizer
  mapping/          nomenclatureMapper (fuzzy + Claude LLM), packTransform (pack-size hints)
  notifications/    events.emit() entry point, telegram/{client,formatter,notifier}
  watcher/          fileWatcher.ts (chokidar over data/inbox/), recovery for stuck rows
  integration/      webhook.ts (legacy webhook, 1C now uses /pending pull)
  utils/            logger, mailer, backup, diskMonitor, photoRetention, invoiceNumber

public/             vanilla SPA — app.html is the shell, sections toggled by JS in app.js
1c/КНД_ЗагрузкаНакладныхСканер/  EDT export of the 1C external processing (.epf source)
docs/               extended docs and archives; not loaded into Claude context automatically
tests/              vitest, mirrors src/ structure
data/inbox|processed|failed/     watcher pipeline directories (gitignored except .gitkeep)
```

## Database (high level)

Main tables: `invoices`, `invoice_items`, `nomenclature_mappings`, `onec_nomenclature` (1C catalog cache), `webhook_config`, `analyzer_config`, `users`, `notification_events`. See `src/database/migrations.ts` for exact columns. Notable per-feature columns:

- `invoices.approved_for_1c`, `approved_at`, `sent_at` — 1C upload workflow.
- `invoices.items_total_mismatch` — 1 when sum(items.total) diverges from `total_sum` by >1%.
- `invoices.telegram_message_id` — message_id of the Telegram thread bubble for this invoice.
- `users.{email, notify_mode, notify_events}` — notifications config; `email`+`notify_mode` are deprecated, `notify_events` still active.
- `users.{telegram_chat_id, telegram_bot_token}` — current notification channel.

## 1C integration

- 1C external processing source: `1c/КНД_ЗагрузкаНакладныхСканер/` (EDT format → compile to `.epf` in Конфигуратор).
- Flow: 1C polls `GET /api/invoices/pending` for `approved_for_1c=1` rows, creates `Документы.ПриходнаяНакладная`, calls `POST /api/invoices/:id/confirm` to mark sent.
- VAT: prices in payload are **VAT-included** (Claude's parsing convention). The 1C module sets `СуммаВключаетНДС = Истина` and uses `Справочники.СтавкиНДС.СтавкаНДС(ВидСтавки, Period)` to resolve the VAT rate by date (handles 18%/20%/22% history).
- Photo attachment: use `РаботаСФайлами.ДобавитьФайл(параметры, адресВовременном)` — writing directly to the deprecated `ФайлХранилище` field gives a "binary data was deleted" error when the user tries to view it.

Russian-language UNF source dump (when you need to look up metadata or canonical helper functions): `C:\www\1CУНФ1.6 от 02.04\`.

## Deploy

```bash
ssh magday@magday.ru                     # port 22 locally; GitHub Actions uses 50222
pm2 logs scanflow --lines 50             # live logs
pm2 restart scanflow                     # after config change
gh run list --repo djdes/scanflow        # GHA status
```

App lives at `~/www/scanflow.ru/app/`. `.env` and `google-credentials.json` are server-only (excluded from rsync). `data/database.sqlite` is server-only too — backups run daily at 03:00 to `data/backups/`.

GitHub secrets needed: `SSH_PRIVATE_KEY`, `SSH_HOST=magday.ru`, `SSH_USER=magday`, `SSH_PORT=50222`.

Anthropic API on prod uses an HTTP proxy. The Anthropic SDK ignores `fetchOptions.dispatcher` on Node 20 — pass a custom `fetch` function backed by undici `ProxyAgent` (see `src/ocr/claudeApiAnalyzer.ts`).

## Local dev

```bash
npm install
npm run dev                # starts on :8899
npm run test:pipeline -- ./photo.jpg   # full OCR → parse → JSON
npm run test:hybrid -- ./photo.jpg     # only Google Vision + Claude analyzer
npm run reset-admin-password [новыйПароль]
```

First start with empty `users` table prints a one-time random admin password to logs (look for `FIRST-RUN ADMIN ACCOUNT CREATED`). The admin's `api_key` is seeded from `.env` `API_KEY` so existing 1C/mobile-camera integrations keep working.

## Things future-Claude must not break

1. **Don't delete the `skipKeywords` regex in `invoiceParser.ts`.** Each word there blocks a real OCR false-positive caught in production.
2. **Table boundary detection in the parser is load-bearing** — without it the parser confuses "Образец заполнения платёжного поручения" sections with goods.
3. **Cross-validate `qty × price ≈ total` per item.** Catches ~30% of OCR errors where VAT got swapped with total.
4. **ТОРГ-12 quantity must be ≤ 4 digits.** SKU codes like `113393` should never be parsed as a quantity.
5. **Supplier extraction is line-by-line, not regex.** Older `SUPPLIER_PATTERNS` regex confused buyer with supplier — never restore it.
6. **`fileWatcher.markProcessing(filePath)` before any inbox file is touched** — prevents race between watcher and `/api/upload` route both grabbing the same file.
7. **Wrap `fs.renameSync` on inbox/processed in try/catch** — the watcher may have moved the file already, ENOENT is normal.
8. **Express route order:** `GET /api/invoices/stats` must register before `GET /api/invoices/:id`, otherwise `stats` is parsed as an id.
9. **`emit()` in `src/notifications/events.ts` must never throw.** All errors are logged and swallowed — notifications must not break the OCR pipeline.
10. **Don't write Telegram bot tokens or 1C details into a plan file.** Bot tokens live in `users.telegram_bot_token`, not env.
11. **Windows shell escaping for the legacy Claude CLI:** prompts with Russian text must be written to a temp file and piped (`type file | claude -p -`). Direct argv passing breaks. (Only relevant when working on the `hybrid` legacy OCR path.)

## API surface (mounted in `src/api/server.ts`)

| Path | Auth | Purpose |
|------|------|---------|
| `POST /api/auth/login` | rate-limited (20/5min) | login → returns `api_key` |
| `GET/POST /api/invoices/*` | `X-API-Key` | list, detail, send-to-1C, confirm, reset, items PATCH, etc. |
| `GET /api/invoices/pending` | `X-API-Key` | called by 1C external processing |
| `POST /api/invoices/:id/confirm` | `X-API-Key` | called by 1C after creating document |
| `GET/POST /api/mappings/*` | `X-API-Key` | nomenclature mapping CRUD |
| `POST /api/upload` | `X-API-Key` | dashboard photo upload (rate-limited) |
| `GET/PATCH /api/profile` | `X-API-Key` | user notification config |
| `POST /api/profile/test-telegram` | `X-API-Key` | sends a test message |
| `GET/PATCH /api/settings/analyzer` | `X-API-Key` | OCR mode + Claude key + LLM mapper toggle |
| `GET/PUT /api/webhook/config` | `X-API-Key` | legacy webhook config |
| `GET/POST /api/nomenclature/*` | `X-API-Key` | 1C catalog sync from UNF |
| `GET /api/debug/*` | `X-API-Key` | error inspection, stuck-row recovery |
| `GET /camera` | none (LAN) | mobile camera page |

## Workflow conventions

- New SQL changes go as a new migration object in `src/database/migrations.ts` — never edit a previous one. Always include a `detect()` for backfill.
- New tests live next to source under `tests/<dir>/<file>.test.ts`. Mock external services (`vi.mock('../../src/utils/mailer')` etc.) — never hit real SMTP/Telegram from tests.
- Spec-driven feature work is recorded in `docs/superpowers/specs/YYYY-MM-DD-*-design.md` (design) and `docs/superpowers/plans/YYYY-MM-DD-*.md` (implementation plan). Both get committed before code.
- Never commit `.env`, `google-credentials.json`, or anything in `data/` (except `.gitkeep` files). `.gitignore` already covers this.

## When you need more context

The pre-trim CLAUDE.md (under `docs/_archive/`) has full sections for:
- Parser strategy (1/2/3) and ТОРГ-12 column-by-column OCR handling
- Detailed OCR engine fallback chain and the hybrid Claude CLI quirks
- Email + digest mode design (now dead code)
- Multi-page invoice merge logic (`findRecentByNumber`)
- Worked examples of recognized invoices
- Full deploy file layout on the production server
- Changelog from v1.0 to v1.6

Read it when working on those subsystems. For day-to-day work this short file should be enough.
