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
- **DB:** прод — **MariaDB 10.11** (`10.11.14-MariaDB`, проверено 2026-09-29 по заголовку дампа), локально — MySQL 9.6 (`caching_sha2_password`, MariaDB CLI к нему не подключится — дамп/восстановление через `mysql2`). SQL миграций обязан работать на обеих: без `ADD COLUMN IF NOT EXISTS`, JSON — в `TEXT/MEDIUMTEXT`, без `DEFAULT` у `TEXT`, без именованных `CHECK`, индекс ≤ 3072 байт. mysql2/promise driver, async pool. Schema lives in `src/database/migrations.ts` as a numbered array. Currently at migration **73**.
  **Прод и локалка — РАЗНЫЕ базы** (проверено 2026-08-03). Локально `.env` даёт `DB_HOST=127.0.0.1` → MySQL-служба на самой машине разработчика (`@@hostname=BSQL`, `@@datadir=C:\ProgramData\MySQL\data\`), схема `scanflow`, отдельный набор данных. Прод держит свою базу на сервере, её `.env` в rsync исключён. Более ранняя редакция этого файла утверждала «одна общая инстанция на `192.168.33.3`, используется и продом и локальной разработкой» — это неверно, из-за чего легко переоценить риск локальных прогонов.
  ⚠️ Дефолт в `src/config.ts` — `DB_HOST=192.168.33.3` (не localhost). Без `.env` приложение полезет на сетевой хост. Не полагайтесь на дефолт.
- **OCR mode (`analyzer_config.mode`):** `claude_api` in production — Claude SDK reads the image directly, one call. The legacy `hybrid` mode (Google Vision OCR → Claude text structuring) is still in code.
- **Auth:** every API call needs `X-API-Key` header that maps to `users.api_key`. UI logs in via `POST /api/auth/login` (username + scrypt-hashed password) and stores the returned key in `localStorage`. There is no JWT and no session cookie.
- **Notifications:** `events.emit()` fans every event out to **Telegram AND email** — both are live (a user with `users.email` set + SMTP configured really does get mail). Only the *digest* path (`digestWorker.ts`, `notification_events` table) is dead code. Every send passes a DB-backed hourly rate limit first (`src/notifications/rateLimit.ts`).
  Сводка «Подорожания за неделю» (`src/notifications/priceDigest.ts`, крон по понедельникам) — только по отдельному переключателю `weekly_price_digest`: он в `OPT_IN_EVENT_TYPES` и не входит в набор нового пользователя (`DEFAULT_EVENT_TYPES`). Одна на компанию за ISO-неделю (`owner_digest_sends`, миграция 78), неделя — по часам БД.
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
  utils/            logger, mailer, backup + dbDump (ежедневный дамп), diskMonitor, photoRetention, invoiceNumber
  services/         v2: lineConversion (единая точка пересчёта единиц), itemReconvert, supplierMatch, remapUnsent,
                    catalogSyncWatcher, mappingRestore, newItems, engineFlags (флаги движков)
  learning/         v2: ruleMiner + llmAdvisor + learningService (ночной разбор → rule_proposals), supplierMemory (памятка в промпт)
  golden/           v2: эталоны — перераспознать фото эталонных накладных и сравнить

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
- Пакет v2 (миграции 62–73, 29.09.2026): `analyzer_config.engine_flags` (JSON флагов движков), `invoice_snapshots` (снимки шапки: `baseline`/`recognized`), `edit_log` (кто/когда/было → стало), `invoice_items.raw_*` (как напечатано) + `conv_*`/`qty_flag` (результат пересчёта), `item_unit_rules` (пересчёт «товар + поставщик»), `mapping_rejections` («не это»), `rule_proposals` (предложения ночного разбора), `golden_runs` + `invoices.golden`, `new_item_requests` («Создать в 1С»). У сопоставлений — `source`, `confirmed_at`, `name_key`, `orphaned_at`.
- `invoices.supplier_match` (`inn`|`name`|`manual`) + `supplier_inn_ocr`/`supplier_name_ocr` — откуда взят `supplier_inn`. В конце распознавания `linkApprovedSupplier()` (`src/services/supplierMatch.ts`) привязывает накладную к подтверждённой карточке справочника: по ИНН, а если ИНН с фото там нет — по названию без ОПФ (`name`, с предупреждением в UI/Telegram, автопилот такие держит, Сбер требует подтверждения). Выбор поставщика в окне отправки в Сбер ставит `manual`. Любая запись нового `supplier_inn` через `updateInvoiceData` сбрасывает привязку.

## 1C integration

- 1C external processing source: `1c/КНД_ЗагрузкаНакладныхСканер/` (EDT format → compile to `.epf` in Конфигуратор).
- Flow: 1C polls `GET /api/invoices/pending` for `approved_for_1c=1` rows, creates `Документы.ПриходнаяНакладная`, calls `POST /api/invoices/:id/confirm` to mark sent.
- VAT: prices in payload are **VAT-included** (Claude's parsing convention). The 1C module sets `СуммаВключаетНДС = Истина` and uses `Справочники.СтавкиНДС.СтавкаНДС(ВидСтавки, Period)` to resolve the VAT rate by date (handles 18%/20%/22% history).
- Строка без позиции 1С, по товару которой на странице «Новые товары» попросили «Создать в 1С», уходит в `/pending` с `new_item {name, unit, parent_guid}` и `mapped_name` = название заявки; модуль создаёт позицию с этой единицей (поиск по наименованию, затем по коду ОКЕИ) и в этой группе. После правки `ObjectModule.bsl` `.epf` надо пересобрать в Конфигураторе.
- Photo attachment: use `РаботаСФайлами.ДобавитьФайл(параметры, адресВовременном)` — writing directly to the deprecated `ФайлХранилище` field gives a "binary data was deleted" error when the user tries to view it.

Russian-language UNF source dump (when you need to look up metadata or canonical helper functions): `C:\www\1CУНФ1.6 от 02.04\`.

## Sber Business integration

- Кнопка «Отправить в Сбербанк» на странице деталей накладной создаёт **черновик** платёжного поручения через `POST https://fintech.sberbank.ru:9443/fintech/api/v1/payments` (scope `PAY_DOC_RU`). Без `digestSignatures` документ ложится в черновики СберБизнес — пользователь подписывает токеном вручную. ЭП на стороне ScanFlow не реализуем.
- mTLS: PFX + passphrase (`./certs/sber.p12`, env `SBER_TLS_PFX_PASSWORD`). CA — `./certs/sber-ca.pem`. Папка `certs/` в gitignore.
- Подключение: `/#/sber` — «Войти через Сбербанк» (`GET /api/sber/authorize-url` → браузер на Сбер → публичный `GET /api/sber/callback`, смонтирован ВЫШЕ `apiKeyAuth`, компания — в подписанном `state`) или пара токенов из личного кабинета Sber API (`POST /api/sber/seed-token`, access 30 дней / refresh 180).
- Авторизация (документация — `developers.sber.ru/docs/ru/sber-api/llms-full.txt`, открывается только с РФ-IP): адреса OAuth — с префиксом `/ic/sso/api/` (`sbi…/ic/sso/api/v2/oauth/authorize`, `fintech…/ic/sso/api/v2/oauth/token`); access через API — 60 минут, refresh — 180 дней с последнего использования. `client_secret` живёт 40 дней — хранится в `sber_app` (миграция 74) зашифрованным от `JWT_SECRET`; бессрочный — `POST /fintech/api/applications/secrets/v1/refresh-client-secret`, только по кнопке. Обновление токена: за 5 минут до конца, по 401 (`withSberToken`), ночью (`src/services/sberMaintenance.ts`). Статусы платёжек (`bank_status`) опрашиваются каждые 30 минут днём.
- Поставщики хранятся в локальной таблице `suppliers` (PK = ИНН). Auto-create при первой отправке (через модалку подтверждения, prefill из OCR-данных накладной + опциональный DaData lookup по `DADATA_API_KEY`). Отдельная страница `/#/suppliers` для CRUD.
- Лог отправок — `sber_payments` (UNIQUE по `invoice_id` = один платёж на накладную). Дебаг: `SELECT * FROM sber_payments WHERE invoice_id = ?`.

Файлы:
- `src/sber/` — sberClient (mTLS), oauth, payments, purposeTemplate, dadata, clientInfo, redact
- `src/api/routes/sber.ts` — `/api/sber/*` (authorize-url, callback, seed-token, client-secret, refresh-now, payments/sync, payer, status, disconnect)
- `src/sber/appCredentials.ts` (client_secret, UTC-даты), `src/sber/secretBox.ts` (AES-256-GCM), `src/services/sberMaintenance.ts` (ночное обновление, опрос статусов)
- `src/api/routes/suppliers.ts` — `/api/suppliers/*` CRUD + lookup-dadata
- `src/api/routes/invoices.ts` — `POST /:id/send-sber` (`amount_override`, `purpose_override`), `GET /:id/sber-preview`, `GET /:id/sber-status`
- `public/js/sber.js`, `public/js/suppliers.js`, `public/js/sber-modal.js`

## Deploy

```bash
ssh magday@magday.ru                     # port 22 locally; GitHub Actions uses 50222
pm2 logs scanflow --lines 50             # live logs
pm2 restart scanflow                     # after config change
gh run list --repo djdes/scanflow        # GHA status
```

App lives at `~/www/scanflow.ru/app/`. `.env` and `google-credentials.json` are server-only (excluded from rsync). DB — своя, на сервере (`scanflow` schema); с локальной она НЕ общая. Backups: приложение само раз в сутки (и на старте) пишет логический дамп `data/backups/scanflow-ГГГГ-ММ-ДД.sql.gz` (`src/utils/dbDump.ts`, хранит 14, каталог — env `BACKUP_DIR`). Дамп и правила до v2 — `data/backups/*-pre-v2*`, тег `backup/pre-v2-2026-09-29`. Откат v2 по шагам — `docs/runbooks/rollback-v2.md`.

GitHub secrets needed: `SSH_PRIVATE_KEY`, `SSH_HOST=magday.ru`, `SSH_USER=magday`, `SSH_PORT=50222`.

⚠️ SSH-доступа «из коробки» на машине разработчика может не быть: 2026-08-03 ни один из ключей в `~/.ssh` (`id_ed25519`, `id_ed25519_laptop`, `ml_deploy`) не принят (`Permission denied (publickey,password)`), а порт 50222 снаружи закрыт (`Connection refused` — он, судя по всему, открыт только для GHA-раннеров). То есть строка `ssh magday@magday.ru` выше предполагает парольный вход. Быстрая проверка живости прода без SSH: `curl -s https://scanflow.ru/health`.

Миграции на проде применяются **на старте процесса** (`pm2 restart` в конце деплоя), отдельного шага миграций в пайплайне нет.
Шаг деплоя дописывает в серверный `.env` `DATA_SCOPING_ENABLED=true` — мёртвая настройка, код её больше не читает (см. правило 19). Удалять из workflow безопасно.

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

⚠️ `npm run dev` — это не «read-only просмотр». На старте он: (а) **накатывает миграции текущей ветки** на базу из вашего `.env`; (б) поднимает file watcher над `data/inbox/`; (в) заводит кроны (в т.ч. бэкап сразу на старте); (г) сидит admin-пользователя. Локальная база от прода отделена (см. секцию Tech stack), так что это безопасно — но помните, что ветка с новой миграцией меняет схему локальной БД, и откатa нет.
Существующий `.env` `API_KEY` может **не совпадать** с `users.api_key` в вашей локальной базе (сид отрабатывает только на пустой таблице). Если нужен рабочий ключ для curl/скриптов — берите его из БД: `SELECT api_key FROM users WHERE role='admin'`.

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
    **Никогда не меняйте номер уже прогнанной миграции.** `runMigrations()` решает пропускать или нет ТОЛЬКО по номеру (`if (applied.has(mig.version)) continue`), и `detect()` смотрится лишь для версий, которых в `migration_history` ещё нет. Поэтому если прогнать миграцию локально под номером N, а закоммитить под N+2 (номер занял чужой хотфикс), локальная база навсегда считает N применённым и настоящую миграцию N уже не выполнит — схема тихо расходится с кодом. Реальный след: в локальной БД `42 = Sber-overdue` (прогнали 2026-07-09 из незакоммиченного кода), в коммитах `42 = invoices.recovery_attempts` → колонки нет, и crash recovery падает на старте с `Unknown column 'i.recovery_attempts'`. Прода это не касается — он исполняет только закоммиченный код. Лечится точечно: `DELETE FROM migration_history WHERE version = <N>` на своей локалке + рестарт.
    Следствие: **миграции применяются при СТАРТЕ приложения**, а не отдельным шагом пайплайна (`initDb()` в `src/index.ts`). Любой `npm run dev` накатывает миграции текущей ветки на ту базу, на которую смотрит ваш `.env`.
17. **🔥 ТЕСТЫ НИКОГДА НЕ КОННЕКТЯТСЯ К ЧЕМУ-ТО, КРОМЕ `127.0.0.1`/`localhost`.** `tests/helpers/db.ts` имеет sanity-guard в начале `resetDb()`, который throw'нет при `DB_HOST != localhost` или при `DB_NAME` без подстроки `"test"`. **Не отключать.** Контекст: 2026-05-26 прогон тестов стёр прод-MariaDB через каскад «`src/config.ts` грузит `dotenv` как side-effect → `process.env.DB_NAME` становится `scanflow` (прод) → `resetDb()` делает `TRUNCATE` каждой таблицы». Если делаете новый test helper или integration-скрипт с DDL — обязан вызвать тот же guard или не работать совсем без явного `.env.test`.
    Актуальное состояние (проверено 2026-08-03): локальный `.env` указывает на **локальную** MySQL-службу (`127.0.0.1`), а не на прод — старая формулировка «`127.0.0.1`→прод» устарела. Но `npm test` тут всё равно НЕ запускается: `DB_NAME=scanflow` не содержит `"test"`, guard бросает исключение. Это правильное поведение — без `.env.test` прогон стёр бы вашу локальную рабочую базу. Проверяйте через `npx tsc --noEmit`, либо заведите `.env.test` со схемой `scanflow_test`.
18. **Динамические SQL-колонки в `SET`/идентификаторах — только из фиксированного allow-list, НЕ из сырого тела запроса.** `supplierRepo.update` / `sberTokenRepo.updatePayerDetails` интерполируют имена колонок — у них белый список ключей. Вернуть `Object.entries(req.body)` сюда = аутентифицированная SQL-инъекция (инцидент: `PATCH /api/suppliers/:inn`, починено 2026-06-24).
19. **Мультитенантная изоляция накладных — безусловная, флага БОЛЬШЕ НЕТ.** `invoices.owner_user_id`; проверки `invoice.owner_user_id !== req.user?.id` расставлены прямо по хендлерам `src/api/routes/invoices.ts`, плюс scoping списка и статистики. Справочники разведены по тенантам отдельными таблицами-«картами» (`supplier_cards`, `onec_nomenclature_cards`, `nomenclature_mapping_cards`, `ocr_correction_cards`, `webhook_config_cards`, миграции 48–54). Интеграционные роуты (1С `/pending`, диспетчер) держите в admin/owner-контексте.
    ⚠️ Устарело: `config.dataScopingEnabled` / env `DATA_SCOPING_ENABLED` **удалены из кода** (в `src/config.ts` от них остался только висячий комментарий). Шаг деплоя в `.github/workflows/deploy.yml` всё ещё дописывает `DATA_SCOPING_ENABLED=true` в серверный `.env` — это мёртвая строка, её никто не читает. См. `docs/superpowers/specs/2026-07-22-multitenant-isolation-design.md` (более ранний design от 2026-06-24 описывает уже неактуальную флаг-схему).
20. **Платформенно-глобальный конфиг — только admin.** `requireAdmin` (в `auth.ts`) закрывает `/api/webhook`, `/api/debug`, `PUT /api/settings/analyzer` и connect/write-роуты Сбера; `GET /api/settings/analyzer` прячет секреты от не-админов; `GET /api/sber/status` прячет банковские реквизиты плательщика. Не расширять на `role='user'`.
21. **🔥 Crash recovery НИКОГДА не удаляет застрявшую накладную и не возвращает фото в `inbox/`.** Инцидент 2026-07-14: `max_memory_restart: '256M'` при пиках OCR ~470 МБ → PM2 убивал процесс каждые 90 сек. Recovery на старте удаляла строку (`invoiceRepo.delete`) и клала фото обратно в `inbox/` — но удаление строки стирало и `file_hash`, поэтому **оба** дедупа в `processFile` (по SHA-256 и по имени файла) слепли, watcher создавал накладную заново и снова слал `photo_uploaded`. ~20 кругов по 3 накладные за 40 минут, в Telegram и на почту. Теперь: строка живёт, `recovery_attempts` инкрементится **до** ретрая, перепрогон идёт на месте через `reprocessInvoice()` (он не шлёт `photo_uploaded`), после 2 неудач — `error` + фото в `failed/`. См. `src/watcher/crashRecovery.ts`. Правила: (а) не удалять строку в recovery — это единственное, что держит дедуп по хешу честным; (б) счётчик инкрементить до работы, а не после, иначе падение в середине OCR не сожжёт попытку; (в) перепрогонять последовательно — именно параллельные Claude-вызовы и пробили лимит памяти.
22. **Пересчёт единиц — только через `convertInvoiceLine()` (`src/services/lineConversion.ts`) и `reconvertStoredItem()`, и только от `raw_*`.** Сумма строки при пересчёте не меняется никогда (меняются количество/единица/цена). Строки `conv_source='legacy_stored'` (до v2) и с пустым `conv_source` (записаны не конвейером v2, например старым кодом после отката) автоматически НЕ пересчитываются — их `raw_*` могут быть уже пересчитанными, повторное умножение и было главной бедой (60 шт батона → «1440 кг»). Ручную правку количества (`conv_source='manual'`) автоматика не трогает.
23. **Выгрузка каталога 1С не удаляет сопоставления.** `removeOrphaned` больше не вызывается: исчезнувшая позиция → `orphaned_at` (правило пропускается при подборе), очистка — только руками. Частичная выгрузка каталога стирала правила.
24. **Правило единицы из правки строки хранится как `field_name='item_unit_item'` с `item_key` (товар), не `'item_unit'`.** Код до v2 применял любую строку `'item_unit'` ко ВСЕМ строкам поставщика (инцидент: яйца «С1 360шт» → «1080 кг»). Смена единицы внутри класса (уп → упак) — исправление чтения и запоминается; смена класса (кг ↔ шт) — пересчёт, строка становится ручной и НЕ запоминается как исправление OCR.
25. **Каждая ручная правка — в `edit_log` через `logEdit()`** (никогда не бросает). Снимки шапки `invoice_snapshots` — рычаг отката номера/даты/суммы/НДС: `POST /api/invoices/:id/restore-snapshot`, массово `POST /api/debug/restore-headers` (по умолчанию `dry_run`).
26. **Флаги движков** (`analyzer_config.engine_flags`, `src/services/engineFlags.ts`: `units_v2`, `price_guard`, `mapping_v2`, `ocr_memory`, `batch_notify`, `learning`, `row_pairing`): выключенный флаг = прежний путь кода. Прежние пути не удалять — это откат без выкладки.
27. **Самообучение ничего не применяет само.** Ночной разбор (03:30) и ИИ только создают `rule_proposals`; правило появляется после «Принять». Памятка поставщиков в промпте — без коэффициентов пересчёта (модель возвращает напечатанное). В публичный `GET /api/dispatcher/prompt` данные компании не добавлять.
28. **`claude-sonnet-5` размышляет по умолчанию, и размышления тратят тот же `max_tokens`.** При малом лимите ответ приходит без текстового блока (так молча не работал советчик с лимитом 2500). Для новых вызовов — structured outputs + `thinking: {type: 'adaptive'}` с `effort` и запасом токенов, или явно `disabled`.
29. **Сбер: `client_secret` не менять автоматически и 30-дневный токен из кабинета не обновлять без бессрочного ключа.** Замена секрета (в т.ч. на бессрочный) делает старый недействительным — если тот же `client_id` использует другая программа, она сломается; поэтому только по кнопке. Обновление превращает 30-дневный токен из личного кабинета в часовой, и дальше доступ держится на секрете: пока ключ не бессрочный, ночное обновление — только за 3 дня до конца токена. Даты токенов — UTC (`sqlUtc`/`parseDbUtc`): база прода живёт по МСК (`NOW()` = МСК).
30. **Фото накладной, не отправленной в 1С, не удаляется** (`photoRepo.listNotYetExpiredFileNames`); после отправки хранится ещё 90 дней. Служебные оповещения владельцу (не про накладную) — `sendOwnerAlert` с интервалом в `owner_alerts` (миграция 75).
31. **Пары «название — числа» на фото под углом собираются по порядку строк, а не по высоте текста.** На изогнутом листе (счёт в файле-вкладыше) числа съезжают на соседнюю строку; модель сдвигает пары, а сумма строк всё равно сходится с итогом (инцидент 30.09: накладная 783, ранее 748 и 756 — последняя ушла в 1С). Промпт это НЕ лечит (проверено: 0 из 3 и 1 из 3 верных прогонов), лечит отдельное чтение одних чисел сверху вниз параллельно основному вызову (`readNumberRows` + `src/ocr/rowPairing.ts`, флаг `row_pairing`): i-е название ↔ i-я строка чисел. Чистый результат меняется только перестановкой его же чисел и только если после этого проверка чистая. Страховка на сохранённых данных — `storedAlignmentProblems` (пустая строка, повтор названия, цены соседних строк по истории — `priceShiftProblems`): держит автопилот (`rows_misaligned`) и показывает предупреждение в карточке.

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
| `GET /api/settings/analyzer` | `X-API-Key` | OCR mode; секреты видны только `admin` |
| `PUT /api/settings/analyzer` | `X-API-Key` + **admin** | OCR mode + Claude key + LLM mapper + auto-send flags |
| `GET/PUT /api/webhook/config` | `X-API-Key` + **admin** | legacy webhook config |
| `GET/POST /api/nomenclature/*` | `X-API-Key` | 1C catalog sync from UNF |
| `GET /api/debug/*` | `X-API-Key` + **admin** | error inspection, stuck-row recovery |
| `GET/POST /api/sber/*` | `X-API-Key` | authorize-url, seed-token, client-secret, refresh-now, payments/sync, payer, status, disconnect (connect/write — admin) |
| `GET /api/sber/callback` | none (подписанный `state`) | возврат от Сбера после входа — смонтирован ВЫШЕ `apiKeyAuth` |
| `GET/POST/PATCH /api/suppliers/*` | `X-API-Key` | справочник поставщиков + `lookup-dadata` |
| `GET/POST /api/operations/*` | `X-API-Key` | банковские выписки, согласования, автопилот |
| `GET /api/integrations/*` | `X-API-Key` | лог интеграционных событий |
| `GET/PATCH /api/users/*` | `X-API-Key` + **admin** | список пользователей, смена роли |
| `GET/POST /api/onec/*` | `X-API-Key` | self-service подключение 1С (генерация кода) |
| `POST /api/onec/pair` | none, rate-limited (20/min) | обмен одноразового кода на токен 1С |
| `/api/onec/exchange/*` | 1C-токен (внутри роутера) | обмен данными с 1С |
| `/api/dispatcher/*` | токен задачи (внутри роутера) | callback'и режима «диспетчер» + отдача промптов |
| `/api/inbound/public/*` | секрет канала (внутри роутера) | публичный приём документов (почта/вебхуки) |
| `GET/POST /api/inbound/*` | `X-API-Key` | настройка каналов приёма |
| `GET /health` | none | реальные пробы: БД, ключ Anthropic, глубина `inbox/` |
| `GET /magic/:token` + `POST /magic/:token/consume` | one-time token | вход по magic-ссылке из письма |
| `GET /blog`, `/blog/:slug`, `/sitemap.xml` | none | SEO-блог и карта сайта |
| `GET /camera` | none (LAN) | mobile camera page |
| `GET/PUT /api/settings/engine-flags` | `X-API-Key` (запись — admin) | флаги движков v2 |
| `GET /api/invoices/:id/edits`, `POST /:id/restore-snapshot` | `X-API-Key` | журнал правок, откат шапки из снимка |
| `POST /api/invoices/:id/items/:itemId/{reconvert,revert-raw,unit-rule}`, `GET …/candidates` | `X-API-Key` | пересчёт строки, «как в накладной», «запомнить», кандидаты 1С |
| `POST /api/debug/restore-headers` | `X-API-Key` + **admin** | массовый откат номера/даты/суммы/НДС (`dry_run` по умолчанию) |
| `POST /api/mappings/restore` | `X-API-Key` + **admin** | вернуть недостающие сопоставления из резервной копии (`dry_run` по умолчанию) |
| `GET/POST /api/learning/*` | `X-API-Key` | предложения правил (принять/отклонить/разобрать), правила пересчёта |
| `GET/POST/DELETE /api/new-items/*` | `X-API-Key` | «Новые товары»: сопоставить группу или «Создать в 1С» |
| `PATCH /api/golden/invoices/:id`, `/api/golden/runs*` | `X-API-Key` (прогон — admin) | эталоны |
| `POST /api/invoices/:id/items`, `DELETE …/items/:itemId`, `POST …/items/vat-rate` | `X-API-Key` | добавить/удалить строку, НДС всем строкам (НДС шапки не трогают) |
| `GET /api/users/companies` | `X-API-Key` + **admin** | обзор компаний: активность, очередь в 1С, сопоставления, Сбер |
| `GET /api/analytics/suppliers`, `/prices?q=`, `/prices/:guid` (`?days=30\|90\|180\|365`) | `X-API-Key` | качество поставщиков и закупочные цены — только компания вызывающего; правки учитываются с миграций 64/67 (`tracking_since`) |

Порядок монтирования в `server.ts` load-bearing: роутеры с собственной аутентификацией (`/api/dispatcher`, `/api/inbound/public`, `/api/onec/exchange`, `/api/onec/pair`) обязаны стоять ВЫШЕ `apiKeyAuth`-роутеров, иначе префиксный мидлвар вернёт им 401.

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
