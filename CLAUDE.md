# ScanFlow — project guide for Claude

> Russian invoice OCR service that turns photos of paper invoices into 1C:UNF documents.
> Domain is Russian (1C, suppliers, накладные); identifier names in 1C metadata are Cyrillic.
> The full pre-trim version of this file lives at [`docs/_archive/CLAUDE-v1.6-2026-04-30.md`](docs/_archive/CLAUDE-v1.6-2026-04-30.md) — read it when you need exhaustive history; this file is the cheat sheet.

## Pipeline

```
JPG photo → OCR (Google Vision → Claude API → Tesseract) → parser → nomenclature mapper → MariaDB → 1C webhook/REST
```

**Production:** https://scanflow.ru (Ubuntu 24.04, FastPanel, PM2 process `scanflow`, port 8899). GitHub Actions auto-deploys on push to `main`.

## Tech stack

- **Runtime:** Node.js 25 + TypeScript (strict). Server is plain Express 5; frontend is vanilla HTML/CSS/JS with hash routing — no build step for client.
- **DB:** MySQL 9.6 (`SELECT VERSION()` → `9.6.0`; uses `caching_sha2_password`, so the MariaDB CLI client can't auth — dump/restore via a MySQL 9 client or `mysql2`). mysql2/promise driver, async pool. Single instance on `192.168.33.3:3306` (reached as `127.0.0.1` locally), schema `scanflow`, used by both production and local dev. Schema lives in `src/database/migrations.ts` as a numbered array. Currently at migration 43.
- **OCR mode (`analyzer_config.mode`):** `claude_api` in production — Claude SDK reads the image directly, one call. The legacy `hybrid` mode (Google Vision OCR → Claude text structuring) is still in code.
- **Auth:** every API call needs `X-API-Key` header that maps to `users.api_key`. UI logs in via `POST /api/auth/login` (username + scrypt-hashed password) and stores the returned key in `localStorage`. There is no JWT and no session cookie.
- **Notifications:** `events.emit()` fans every event out to **Telegram AND email** — both are live (a user with `users.email` set + SMTP configured really does get mail). Only the *digest* path (`digestWorker.ts`, `notification_events` table) is dead code. Every send passes a DB-backed hourly rate limit first (`src/notifications/rateLimit.ts`).
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

Main tables: `invoices`, `invoice_items`, `nomenclature_mappings`, `onec_nomenclature` (1C catalog cache), `webhook_config`, `analyzer_config`, `users`, `notification_events`, `sber_tokens` (single-tenant OAuth + payer details), `suppliers` (payee directory, PK=ИНН), `sber_payments` (1:1 invoice → payment log). See `src/database/migrations.ts` for exact columns. Notable per-feature columns:

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

## Sber Business integration

- Кнопка «Отправить в Сбербанк» на странице деталей накладной создаёт **черновик** платёжного поручения через `POST https://fintech.sberbank.ru:9443/fintech/api/v1/payments` (scope `PAY_DOC_RU`). Без `digestSignatures` документ ложится в черновики СберБизнес — пользователь подписывает токеном вручную. ЭП на стороне ScanFlow не реализуем.
- mTLS: PFX + passphrase (`./certs/sber.p12`, env `SBER_TLS_PFX_PASSWORD`). CA — `./certs/sber-ca.pem`. Папка `certs/` в gitignore.
- Подключение: `/#/sber` страница — OAuth (`GET /api/sber/authorize` → callback) или manual seed-token (вставить access/refresh из dev-портала + реквизиты плательщика).
- Поставщики хранятся в локальной таблице `suppliers` (PK = ИНН). Auto-create при первой отправке (через модалку подтверждения, prefill из OCR-данных накладной + опциональный DaData lookup по `DADATA_API_KEY`). Отдельная страница `/#/suppliers` для CRUD.
- Лог отправок — `sber_payments` (UNIQUE по `invoice_id` = один платёж на накладную). Дебаг: `SELECT * FROM sber_payments WHERE invoice_id = ?`.

Файлы:
- `src/sber/` — sberClient (mTLS), oauth, payments, purposeTemplate, dadata, clientInfo, redact
- `src/api/routes/sber.ts` — `/api/sber/*` (authorize, callback, seed-token, payer, status, disconnect)
- `src/api/routes/suppliers.ts` — `/api/suppliers/*` CRUD + lookup-dadata
- `src/api/routes/invoices.ts` — `POST /:id/send-sber`, `GET /:id/sber-status`
- `public/js/sber.js`, `public/js/suppliers.js`, `public/js/sber-modal.js`

## Deploy

```bash
ssh magday@magday.ru                     # port 22 locally; GitHub Actions uses 50222
pm2 logs scanflow --lines 50             # live logs
pm2 restart scanflow                     # after config change
gh run list --repo djdes/scanflow        # GHA status
```

App lives at `~/www/scanflow.ru/app/`. `.env` and `google-credentials.json` are server-only (excluded from rsync). DB lives in MariaDB (`scanflow` schema on the same host). Backups: schedule a `mysqldump scanflow > data/backups/scanflow-$(date +%F).sql` via cron — the in-app SQLite file backup is gone.

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
12. **Sber `/v1/payments` Authorization header is bare token, NOT `Bearer`.** Sber Business API expects `Authorization: <access_token>` directly. Adding `Bearer ` prefix returns 401. See `src/sber/payments.ts` and `src/sber/clientInfo.ts`.
13. **Sber `purpose` field max 210 chars + ASCII-friendly punctuation.** Server returns 400 on ёлочки/em-dash/non-breaking space. `renderPurpose()` truncates and `sanitizePurpose()` normalises — don't bypass either.
14. **`sber_payments.invoice_id` UNIQUE = one payment per invoice.** This is intentional double-click protection. If частичные оплаты понадобятся — это отдельная фича с миграцией, не «ослабить constraint».
15. **Все DB-обращения теперь async.** Каждый метод репозиториев (`invoiceRepo.*`, `mappingRepo.*`, `userRepo.*`, …) возвращает Promise; забыл `await` — TypeScript ругнётся, но в runtime это будет «невидимый» баг. Транзакции: `await getDb().transaction(async (txn) => { … })`. Никаких `db.transaction(() => {…})()` синхронных — сразу TypeError.
16. **Schema changes — только через миграции** в `src/database/migrations.ts`. Каждая миграция должна быть idempotent (`CREATE TABLE IF NOT EXISTS`, `hasColumn` guards) — MySQL DDL не транзакционна, поэтому частичный фейл должен переигрываться без ошибок.
17. **🔥 ТЕСТЫ НИКОГДА НЕ КОННЕКТЯТСЯ К ЧЕМУ-ТО, КРОМЕ `127.0.0.1`/`localhost`.** `tests/helpers/db.ts` имеет sanity-guard в начале `resetDb()`, который throw'нет при `DB_HOST != localhost` или при `DB_NAME` без подстроки `"test"`. **Не отключать.** Контекст: 2026-05-26 прогон тестов стёр прод-MariaDB через каскад «`src/config.ts` грузит `dotenv` как side-effect → `process.env.DB_NAME` становится `scanflow` (прод) → `resetDb()` делает `TRUNCATE` каждой таблицы». Если делаете новый test helper или integration-скрипт с DDL — обязан вызвать тот же guard или не работать совсем без явного `.env.test`. (Локально `.env` указывает `127.0.0.1`→прод и нет `.env.test`, поэтому `npm test` тут запускать НЕЛЬЗЯ — проверяйте через `tsc --noEmit`.)
18. **Динамические SQL-колонки в `SET`/идентификаторах — только из фиксированного allow-list, НЕ из сырого тела запроса.** `supplierRepo.update` / `sberTokenRepo.updatePayerDetails` интерполируют имена колонок — у них белый список ключей. Вернуть `Object.entries(req.body)` сюда = аутентифицированная SQL-инъекция (инцидент: `PATCH /api/suppliers/:inn`, починено 2026-06-24).
19. **Мультитенантная изоляция накладных под флагом.** `invoices.owner_user_id` + `config.dataScopingEnabled` (`DATA_SCOPING_ENABLED`, по умолчанию OFF). `router.param`-guard + scoping списка/статистики в `invoices.ts` срабатывают только при флаге; роль `admin` обходит фильтр. Не читайте `owner_user_id` вне флаг-пути, интеграционные роуты (1С `/pending`, диспетчер) держите в admin/owner-контексте. См. `docs/superpowers/specs/2026-06-24-multitenant-data-isolation-design.md`.
20. **Платформенно-глобальный конфиг — только admin.** `requireAdmin` (в `auth.ts`) закрывает `/api/webhook`, `/api/debug`, `PUT /api/settings/analyzer` и connect/write-роуты Сбера; `GET /api/settings/analyzer` прячет секреты от не-админов; `GET /api/sber/status` прячет банковские реквизиты плательщика. Не расширять на `role='user'`.
21. **🔥 Crash recovery НИКОГДА не удаляет застрявшую накладную и не возвращает фото в `inbox/`.** Инцидент 2026-07-14: `max_memory_restart: '256M'` при пиках OCR ~470 МБ → PM2 убивал процесс каждые 90 сек. Recovery на старте удаляла строку (`invoiceRepo.delete`) и клала фото обратно в `inbox/` — но удаление строки стирало и `file_hash`, поэтому **оба** дедупа в `processFile` (по SHA-256 и по имени файла) слепли, watcher создавал накладную заново и снова слал `photo_uploaded`. ~20 кругов по 3 накладные за 40 минут, в Telegram и на почту. Теперь: строка живёт, `recovery_attempts` инкрементится **до** ретрая, перепрогон идёт на месте через `reprocessInvoice()` (он не шлёт `photo_uploaded`), после 2 неудач — `error` + фото в `failed/`. См. `src/watcher/crashRecovery.ts`. Правила: (а) не удалять строку в recovery — это единственное, что держит дедуп по хешу честным; (б) счётчик инкрементить до работы, а не после, иначе падение в середине OCR не сожжёт попытку; (в) перепрогонять последовательно — именно параллельные Claude-вызовы и пробили лимит памяти.

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
| `POST /api/profile/lookup-telegram-chat-id` | `X-API-Key` | finds chat_id via Bot API (after user wrote /start), DMs it back |
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
