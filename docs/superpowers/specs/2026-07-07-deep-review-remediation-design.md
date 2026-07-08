# Спека по исправлению: результаты глубокого ревью проекта

> Дата: 2026-07-07
> Автор ревью: Claude (7 параллельных ревью-агентов по подсистемам: API/auth, БД, OCR/parser/mapping, watcher/utils, Sber, фронтенд, обвязка/деплой).
> Статус: черновик к согласованию. Заголовочные находки перепроверены по коду вручную.

## Как читать этот документ

Находки сгруппированы по приоритету исправления, а не по подсистеме. Каждая находка:
- **[файл:строка]** — где;
- **Симптом** — что ломается и при каких входных данных;
- **Фикс** — что сделать.

Пометка **✓verified** означает, что находку я лично перепроверил по коду (не только со слов агента). Пометка **⚠needs-prod-check** — вывод зависит от состояния прод-конфига/данных, которое из локальной среды не видно; перед работой подтвердить.

Инварианты CLAUDE.md (№1–20) в основном **соблюдены** — все семь агентов это отдельно подтвердили (route order, allow-list колонок №18, `emit()` не бросает №9, bare-token Сбера №12, purpose ≤210 №13, UNIQUE invoice_id №14, async-репозитории №15, markProcessing №6, renameSync-guard №7). Прямых SQL-инъекций через значения не найдено. Проблемы — в **модели авторизации**, **конкурентности**, **идемпотентности** и нескольких **тихих искажениях данных**.

---

## P0 — Критично. Деньги, доступ, секреты, потеря данных

### 0.1 Открытая саморегистрация + выключенный data-scoping = полный доступ постороннего ✓verified ⚠needs-prod-check
**[src/api/routes/auth.ts:78] + [src/config.ts:~68 `DATA_SCOPING_ENABLED` default false] + [src/api/routes/invoices.ts:131-149]**

`POST /api/auth/register` — публичный (за общим лимитером 20/5мин/IP), выдаёт `api_key` роли `user`. `invoiceOwnershipGuard` при `!config.dataScopingEnabled` немедленно `next()` — то есть по умолчанию инертен. Значит любой, кто дёрнул `/register`, получает чтение/редактирование/удаление **всех** накладных платформы, фото, реквизитов, отправку в 1С и Сбер.

> Перепроверено: `/register` действительно создаёт `user`-ключ без инвайта; guard действительно no-op при выключенном флаге. **Осталось подтвердить состояние `DATA_SCOPING_ENABLED` на scanflow.ru** — от него зависит, эксплуатируется ли дыра прямо сейчас. Деплой-скрипт (`deploy.yml`) сед-ит `DATA_SCOPING_ENABLED=true`, так что на проде, вероятно, включён — но это надо проверить фактически, а не по скрипту.

**Фикс (в порядке предпочтения):**
1. Убедиться, что `DATA_SCOPING_ENABLED=true` на проде (снимает бóльшую часть риска), **и**
2. Закрыть `/register` за инвайт/флаг `REGISTRATION_ENABLED` (по умолчанию off), либо
3. Свежему `user`-ключу не давать доступ к чужим данным независимо от флага (scoping всегда включён для роли `user`, флаг оставить только для админ-обзора).

### 0.2 `send-sber` доступен роли `user` — платёжный черновик на произвольный счёт ✓verified
**[src/api/routes/invoices.ts:1489 `router.post('/:id/send-sber')` — нет requireAdmin] + [:1525 `supplier_overrides`]**

Нарушение духа инварианта №20 (Сбер-write — admin). Роут не под `requireAdmin`. Любой `user` со своей накладной вызывает `send-sber` с `supplier_overrides: {inn, name, bank_bic, account: <свой счёт>}` → `supplierRepo.upsert(..., verified:1)` перезаписывает справочник → создаётся **реальный платёжный черновик в СберБизнес** от организации-владельца платформы на счёт злоумышленника. Даже без overrides — user не должен инициировать платежи.

**Фикс:** навесить `requireAdmin` на `send-sber`, `sber-payment` (DELETE), и запретить `user`-роли upsert verified-поставщиков через overrides. Сверить весь список денежных/maintenance-роутов (см. 0.3).

### 0.3 Suppliers CRUD и глобальные maintenance-роуты открыты роли `user` ✓verified
**[src/api/routes/suppliers.ts:73-121 POST/PATCH/DELETE] + [src/api/routes/invoices.ts:1073 canonicalize-suppliers, :1736 merge-suppliers, :1035 delete-batch, :1109 reprocess]**

Справочник `suppliers` — общий на платформу (PK=ИНН, не per-tenant). Любой `user`: листает всех поставщиков с банковскими реквизитами, правит `account`/`bank_bic`/`verified` (PATCH), удаляет карточки (DELETE без проверки существования → всегда `{success:true}`). Плюс `merge-suppliers`/`delete-batch`/`canonicalize` трогают **все** записи платформы и не имеют `:id` → owner-guard не срабатывает даже при включённом флаге.

**Фикс:** write-роуты suppliers (`POST/PATCH/DELETE`, `/merge`) и глобальные maintenance-роуты invoices (`merge-suppliers`, `delete-batch`, `canonicalize-suppliers`, `reprocess`) — под `requireAdmin`. Смену `account`/`bank_bic`/`verified` — только admin (либо сбрасывать `verified=0` при изменении реквизитов). `DELETE /suppliers/:inn` → 404 если строки нет + аудит-лог.

### 0.4 `rejectUnauthorized: false` на всём трафике со Сбербанком ✓verified
**[src/sber/sberClient.ts:75]**

Верификация серверного сертификата отключена для **всего** `sberFetch` — включая OAuth token endpoint (`oauth.ts`), где передаются `client_secret` и refresh-токены, и создание платежа, где в теле идёт `payeeAccount`. Комментарий в коде оправдывает это тем, что «mTLS всё равно аутентифицирует нас» — но mTLS не защищает от активного MITM (подмена реквизитов получателя в черновике, перехват токенов). Для финансового API недопустимо.

**Фикс:** заменить полное отключение на пиннинг сертификата/публичного ключа через `checkServerIdentity` (сравнение SPKI-fingerprint известного серверного серта Сбера), либо получить корректную CA-цепочку у Сбера и включить обычную проверку. Минимум — SPKI-пиннинг.

### 0.5 Бэкапы БД по факту отключены, но логи рапортуют об успехе ✓verified
**[src/utils/backup.ts:27-30 (заглушка → null)] + [src/index.ts:107-111,159 (cron «Running scheduled database backup»)]**

`backupDatabase()` — стаб, всегда `null` + warn в лог. При этом index.ts ежедневно логирует «Daily database backup scheduled at 03:00» / «Running scheduled backup...». Прод-БД уже один раз стёрли (инвариант №17). Если внешний `mysqldump`-cron на сервере не заведён — **резервных копий не существует**, а логи создают ложное чувство защищённости.

**Фикс:** либо реализовать shell-out в `mysqldump` → `data/backups/` (как советует комментарий в самом файле, ротация по дате), либо убрать cron-джобу и громко логировать `BACKUPS DISABLED — configure external mysqldump cron`. **Прежде всего — проверить, есть ли реально работающий mysqldump-cron на scanflow.ru.**

### 0.6 DOM-XSS в mappings.js через незаэкранированный апостроф ✓verified
**[public/js/mappings.js:73,278,305,352,421 — локальный `esc()` без замены `'`]**

Локальный `esc()` экранирует `& < > "`, но **не** `'`, а значения (`mapped_name`, `r.name` — наименования из справочника 1С, полу-доверенный ввод через OCR/синк) подставляются внутрь одинарно-кавыченных JS-строк в инлайн-хендлерах (`onclick="Mappings.addVariant('${esc(...)}', ...)"`). Значение `x'),alert(document.cookie);//` вырывается из строки. Апостроф в имени (`O'Брайен`) вдобавок молча ломает кнопки. `App.esc` в [public/js/app.js:26] **правильно** экранирует `'` → `&#39;`.

**Фикс:** заменить все локальные `esc()` в mappings.js на `App.esc`; лучше — уйти от инлайн-строк к `data-*` + делегированный листенер (как уже сделано в invoices.js `onNomInput`).

### 0.7 Секреты и PII могут уйти в git ✓verified
**[.gitignore] + `git add -n data/` показывает stage: `data/backup_*.json`, `data/*.png/JPG`; каталог `Certs/` (большая C) с боевым `.p12`**

`.gitignore` покрывает `data/inbox|processed|failed/*` и `data/backups/`, но не `data/backup_*.json` (дампы накладных с ИНН/счетами/реквизитами) и не `data/*.png` (фрагменты реальных накладных). Каталог `Certs/` (с большой буквы) с боевым Сбер-сертификатом матчится `.gitignore`-паттерном `certs/*` **только на Windows** (case-insensitive FS) — на Linux/WSL/CI `git add -A` его добавит.

**Фикс:** в `.gitignore` добавить `data/backup_*.json`, `data/*.png`, `data/*.JPG`, `*.epf`; заменить `certs/*` → `[Cc]erts/` (и аналогично `--exclude` в deploy.yml rsync). Переименовать `Certs/` → `certs/`. Удостовериться, что уже закоммиченного нет: `git log --all --full-history -- 'data/backup_*.json' 'Certs/*'`.

### 0.8 Обрезанный ответ Claude молча «чинится» jsonrepair — позиции теряются ✓verified
**[src/ocr/claudeApiAnalyzer.ts:398/606 `max_tokens: 8192/4096`; `stop_reason` нигде не проверяется] + [:285-332 safeParseClaudeJson]**

`response.stop_reason` не проверяется ни в одном из вызовов (grep: 0 совпадений). Sonnet 5 поддерживает до 128K output, а лимит стоит 4096/8192. Плотная УПД на 50+ строк (или включённый LLM-mapper, добавляющий `catalog_idx` в каждый item) → ответ обрезается посреди массива `items` → regex берёт до последней целой `}` → `JSON.parse` падает → **jsonrepair закрывает скобки, парсинг «успешен» с потерянным хвостом позиций**. `total_sum` идёт до `items`, поэтому сохраняется, и единственный сигнал — мягкий `items_total_mismatch`. Это ровно наблюдавшаяся в проде проблема «плотных страниц».

**Фикс:** проверять `response.stop_reason === 'max_tokens'` → бросать явную ошибку (накладная в `error`, а не тихо-неполная); поднять `max_tokens` (модель позволяет). Опционально — стриминг для очень плотных страниц.

---

## P1 — Высокий. Тихие искажения учётных данных, дубли документов, гонки

### 1.1 Startup-recovery уничтожает dispatcher-накладные, ждущие callback ✓verified
**[src/database/repositories/invoiceRepo.ts:821-828 listStaleForRecovery] + [src/index.ts:56-88]**

`listStaleForRecovery()` выбирает **все** строки в `ocr_processing`/`parsing` **без** `AND dispatcher_token IS NULL`. Для dispatcher-режима обработка внешняя и живёт до 180 мин. pm2 restart/деплой при задаче в очереди → строка удалена, файл processed→inbox, watcher создаёт новую накладную и новую PF-задачу, старый callback бьётся о несуществующий id. Это и есть известный баг «id churn +3 при рестарте». В `claude_api`-режиме — повторный **платный** OCR при каждом деплое с in-flight обработкой.

> `markStaleDispatchersAsFailed` (:786-806) сам корректно охраняет dispatcher-строки, но startup-recovery про него не знает.

**Фикс:** в `listStaleForRecovery()` добавить `AND dispatcher_token IS NULL` (dispatcher-строки оставить sweep'у).

### 1.2 Ghost `ocr_processing`-строки в рантайме не выметаются никогда ✓verified
**[markStaleAsFailed вызывается только на старте, index.ts:82] + [fileWatcher.ts:~1394 updateStatus('error') не в try/catch]**

Если строка застряла в нетерминальном статусе в рантайме (например, сам `updateStatus('error')` в catch-ветке `processFile` бросил из-за обрыва БД) — исключение вылетает из catch, файл не переносится в failed/, строка висит в `ocr_processing`, а chokidar повторно `add` не даст до рестарта. Периодический sweep есть только для dispatcher-строк.

**Фикс:** добавить `markStaleAsFailed(N)` в 5-минутный cron рядом с dispatcher-sweep (N ≥ макс. времени Claude-вызова, напр. 30 мин); обернуть `updateStatus('error')` в try/catch, чтобы перенос в failed/ выполнялся всегда.

### 1.3 Дедуп по file_hash необратимо блокирует перезалив фото после ошибки OCR ✓verified
**[invoiceRepo.ts:170-173 findByFileHash `AND status != 'error'`] + [:578-586] + [fileWatcher.ts:579-597]**

Строка в статусе `error` **сохраняет** свой `file_hash`, а UNIQUE-индекс `idx_invoices_file_hash_unique` продолжает её держать. Сценарий (усугубляет инцидент «credit balance too low», когда все накладные в error): чинят биллинг → перезаливают то же фото → up-front `findByFileHash` промахивается (error исключён) → INSERT ловит ER_DUP_ENTRY → catch в `create()` снова зовёт `findByFileHash` → `undefined` → **сырой ER_DUP_ENTRY наверх**, файл в failed/. Фото невозможно перезалить без ручного удаления error-строки.

**Фикс:** в catch-ветке `create()` искать без фильтра статуса (`findByFileHashAny`) и реюзать error-строку (reset + rescan), либо чистить `file_hash` при переводе в `error`.

### 1.4 `POST /reprocess` — молчаливый no-op из-за hash-дедупа ✓verified
**[src/api/routes/invoices.ts:1109-1171] + [fileWatcher.ts:579-597]**

Роут перемещает файл в inbox, **не** удаляя/не помечая старую строку. Watcher считает SHA-256, `findByFileHash` находит старую накладную (статус ≠ error) → файл возвращается в processed, OCR **не** выполняется, отчёт `status:'processed'`. Заявленная цель («retrigger OCR after parser improvements») не работает для processed-накладных. `/api/debug/reprocess-errors` делает правильно — сначала DELETE строки.

**Фикс:** перед rename удалять строку/обнулять `file_hash` (как в debug-роуте).

### 1.5 Санитайзер арифметики «чинит» правильное qty, когда Claude ошибся в цене ✓verified
**[src/parser/itemSanitizer.ts:271-304 sanitizeItemArithmetic]**

Правило «доверяем total+price, правим qty» ломается на самом частом сбое (о котором предупреждает сам промпт): price взят из колонки «без НДС», qty и total верные. Пример: qty=10 кг, price=100 (без НДС), total=1200 (с НДС 20%). `10×100=1000`, отклонение 16.7% > 5% → qty перезаписывается в `1200/100=12` кг. После этого `q×p=t` сходится, все проверки зелёные, а на склад в 1С уходит **завышенный на ставку НДС вес**.

**Фикс:** перед правкой qty проверять гипотезу «price — это цена без НДС»: если `qty×price×(1+vat_rate/100) ≈ total`, чинить **price** (умножить на `1+vat/100`), а не qty.

### 1.6 Fuzzy-маппинг наследует pack_size чужого scanned_name — неверный пересчёт количества ✓verified
**[src/mapping/nomenclatureMapper.ts:387-407 `pack_size: best.row.pack_size`] + [normalizeName :193-208 вырезает вес] + [fileWatcher.ts:1275-1276]**

`normalizeName` срезает вес перед токенизацией, поэтому `«Капуста морская (3кг)»` и `«...(5кг)»` дают идентичные токены (Jaccard=1.0). Маппинг вернёт `pack_size=3` от чужой learned-строки; Claude весовые скобки в pack_size не пишет → `hintedPackSize` возьмёт 3 → `2 шт × 3 = 6 кг вместо 10 кг`. Молчаливое искажение остатков.

**Фикс:** при token-fuzzy совпадении не наследовать pack-поля чужой строки; вместо этого прогонять `detectPackFromName` на текущем сканируемом имени.

### 1.7 Гонка catalog_idx между построением промпта и резолвом отравляет маппинги ✓verified
**[src/ocr/ocrManager.ts:19-24 getCatalogForPrompt (до OCR)] vs [fileWatcher.ts:1216-1219 + resolveCatalogIdx :151-159 (после OCR)]**

Между двумя `listItems()` проходит 30–120 с (длительность Claude-вызова). Если в окне выполняется синк каталога из 1С (`POST /api/nomenclature`), сортировка сдвигается → все `catalog_idx` резолвятся в соседние GUID, и неверная пара сохраняется в `nomenclature_mappings` с confidence=1.0, отравляя будущий fuzzy.

**Фикс:** прокидывать снапшот каталога (или карту `{idx → guid}`), использованный при построении промпта, через `OcrResult` до места резолва; либо валидировать по хешу каталога.

### 1.8 Неатомарная резервация `/pending` — риск дубля документа в 1С ✓verified
**[src/database/repositories/invoiceRepo.ts:257-273 getPendingWithItems]**

Резервация (`onec_pulled_at`) — отдельный SELECT, затем отдельный UPDATE, без транзакции/`FOR UPDATE`. Два перекрывающихся опроса `/pending` (ручной клик + регламентное задание) могут оба выполнить SELECT до штампа → оба получают одни накладные → дубль `ПриходнаяНакладная` в 1С. Защита строилась именно от конкурентных пуллов, но гонку не закрывает.

**Фикс:** claim-паттерн — сначала `UPDATE ... SET onec_pulled_at=NOW() WHERE <pendingWhere> AND onec_pulled_at IS NULL LIMIT n` с токеном пулла, потом SELECT по токену; или транзакция + `SELECT ... FOR UPDATE SKIP LOCKED`.

### 1.9 Retry Sber после сетевой ошибки создаёт дубликат черновика ✓verified
**[src/api/routes/invoices.ts:1497-1500 (retry удаляет failed-строку), :1598 (новый randomUUID externalId)]**

При timeout/обрыве (30с) платёж мог быть **уже** создан в Сбере, но локально строка `failed`. Повторное нажатие удаляет failed-строку и генерирует **новый** `externalId` → Сбер не дедуплицирует → второй черновик. UNIQUE(invoice_id) защищает только от параллельного даблклика, не от последовательного retry.

**Фикс:** при retry переиспользовать `external_id` из failed-строки (Сбер дедуплицирует по externalId), и/или перед пересозданием опрашивать статус по старому externalId.

### 1.10 OAuth-подключение Сбера через UI недостижимо ✓verified
**[server.ts:238 весь `/api/sber` за apiKeyAuth] + [auth.ts QUERY_KEY_WHITELIST только /photos] + [public/js/sber.js:19]**

Кнопка UI делает `window.location.href='/api/sber/authorize?key=...'`, но query-ключ не в whitelist → 401. Callback от Сбера прилетает на `/api/sber/callback?code=...` вообще без ключа → 401 вместо обмена кода. OAuth-флоу сломан end-to-end; работает только seed-token (что и используется на практике).

**Фикс:** вынести `GET /callback` из-под `apiKeyAuth` (он защищён state-JWT — но добавить проверку `purpose==='connect'`, см. ниже), `/authorize` перевести на POST из SPA, возвращающий redirect-URL (ключ в заголовке). Либо честно выпилить OAuth-путь в пользу seed-token.

### 1.11 send-sber игнорирует items_total_mismatch и duplicate_of ✓verified
**[src/api/routes/invoices.ts:1489-1515] + [автоотправка dispatcher.ts:53, fileWatcher.ts:1372]**

Единственные проверки — `total_sum>0` и наличие `supplier_inn`. Флаг `items_total_mismatch` (ловит ~30% OCR-ошибок сумм) игнорируется; накладную-дубликат (`duplicate_of != null`) можно оплатить. При `auto_send_sber` черновик с неверной OCR-суммой создаётся **без участия человека** (автоотправка проверяет дубликат, но не mismatch).

**Фикс:** 400/409 при `items_total_mismatch=1` и `duplicate_of != null` (с явным override-флагом для ручного пути). Автоотправку — точно блокировать на mismatch.

### 1.12 Merge может писать в «живую» накладную-цель конкурентно ✓verified
**[invoiceRepo.ts:830-844 findRecentBySupplier включает 'parsing','ocr_processing'] + [fileWatcher.ts:774-845 strategies B2/C]**

Кандидаты включают строки в статусах `parsing`/`ocr_processing` — merge может влиться в накладную, чей `processFile` ещё бежит: `appendRawText`/`deleteItems`/`addItem` двух корутин перемешиваются → задвоенные/потерянные позиции. `awaitInFlightPredecessors` ждёт только меньшие id.

**Фикс:** фильтровать кандидатов до `'processed'` (как Strategy D), либо ждать settle кандидата перед merge.

---

## P2 — Средний. Устойчивость, идемпотентность миграций, качество

### 2.1 Миграции не переживают восстановление после частичного фейла ✓verified (инвариант №16, частично нарушен)
**[src/database/migrations.ts: v2 :121-128, v7 :218-231, v13 :308-313, v18 :387-412, v40 :874-885, seed v2 :129-141]**

Guard навешан на **первую** колонку блока, а не на каждый ALTER. MySQL DDL не транзакционна: обрыв между ALTER'ами → повторный прогон молча пропускает недоделанное (например, v40 создаёт `idx_invoices_owner_user_id` без hasIndex-проверки внутри hasColumn-guard'а → индекса не будет, DATA_SCOPING даст full scan). v2 seed `analyzer_config` внутри hasTable-guard'а: CREATE прошёл, INSERT упал → `id=1` нет → `updateAnalyzerConfig` (`WHERE id=1`) молча обновляет 0 строк.

**Фикс:** guard на **каждый** ALTER/CREATE INDEX/seed отдельно (как в v23/v33). Seed — `INSERT IGNORE` вне guard'а.

### 2.2 Скрипты `src/scripts/test-*` и `generate-mappings` пишут в БД из `.env` без guard'ов ✓verified
**[test-delete-invoice.ts, test-nomenclature-mapper.ts, test-onec-nomenclature.ts, generate-mappings.ts] + [.env.example:46 DB_HOST=192.168.33.3]**

Каждый через `initDb()` ещё и **прогоняет миграции** на той БД, куда смотрит `.env`. Guard из `tests/helpers/db.ts` они не вызывают. `npm run test:delete` при `.env`→прод = DDL и DELETE в прод.

**Фикс:** вынести guard из `tests/helpers/db.ts` в общий модуль (`assertLocalDb()`), вызывать в начале каждого пишущего скрипта; либо требовать `--yes-i-know-db=<host/name>`. Defense-in-depth в `buildPool()` (`src/database/db.ts`): если `VITEST`/`NODE_ENV==='test'` и `dbName` без `test` — бросать.

### 2.3 «Run tests» в деплое — иллюзия: DB-тесты молча скипаются на CI ✓verified
**[.github/workflows/deploy.yml:33-34 `npm test` без MySQL] + [27 файлов за `describe.runIf(DB_NAME.includes('test'))`] + [~15 `describe.skip('TODO: rewrite for MariaDB')`]**

На раннере условие ложно → suite скипается зелёным. «Зелёные тесты» гарантируют только чистые unit'ы (parser, sber-моки). Регресс в репозиториях/роутах проходит CI.

**Фикс:** поднять `services: mysql` в workflow, `DB_HOST=127.0.0.1 DB_NAME=scanflow_ci_test`, шаг, фейлящийся при `skipped > N`. Реанимировать/удалить `describe.skip`-заглушки. Добавить `tsconfig.test.json` (`include: src+tests`) + CI-шаг `tsc -p tsconfig.test.json --noEmit` (иначе «забыл await» из инварианта №15 не ловится — tests не в `tsc`-include).

### 2.4 Remote-деплой без `set -e`: падение сборки не останавливает рестарт ✓verified
**[deploy.yml:81-117 heredoc по ssh без set -e]**

`npm run build` при ошибке tsc не прерывает скрипт → `pm2 startOrRestart` перезапускает **старый** `dist/`, health-check на старом коде проходит → workflow зелёный. Коммит с ошибкой компиляции «успешно деплоится», на проде крутится прошлая версия.

**Фикс:** первой строкой heredoc `set -euo pipefail`; лучше — собирать `dist/` на раннере, добавить `tsc --noEmit` отдельным шагом до rsync.

### 2.5 Auto-send Sber: loopback-fetch без таймаута блокирует пайплайн ✓verified
**[fileWatcher.ts:207-212 fetch на /send-sber без AbortSignal] + await в шаге 8 (:1373) до переноса файла]**

Зависший mTLS-хендшейк к fintech.sberbank.ru → `processFile` висит неограниченно, накладная в нетерминальном пути, файл в inbox.

**Фикс:** `AbortSignal.timeout(60_000)`.

### 2.6 config.ts: опасные дефолты ✓verified
**[src/config.ts: dbHost default '192.168.33.3' (прод), apiKey default 'your-secret-api-key', envInt→NaN, dotenv side-effect]**

Скрипт без `.env` молча смотрит в прод-хост; без `.env` аутентификация принимает общеизвестную строку `your-secret-api-key`. `dotenv.config()` как side-effect импорта — корень инцидента №17.

**Фикс:** fail-fast при отсутствии `DB_PASSWORD`/`API_KEY`; дефолт dbHost → `127.0.0.1`; валидация NaN в `envInt`.

### 2.7 SELECT+INSERT-upsert'ы без обработки гонки ✓verified
**[mappingRepo.ts:96-103 upsert, supplierRepo.ts:79-87 upsert]**

Read-then-write по UNIQUE-ключу; конкурентные потоки (watcher + dispatcher-callback + API) с одним именем → проигравший ловит ER_DUP_ENTRY → обработка накладной падает в error.

**Фикс:** `INSERT ... ON DUPLICATE KEY UPDATE`, либо catch ER_DUP_ENTRY → retry-as-update.

### 2.8 mappingRepo.importBulk использует REPLACE INTO — теряет данные ✓verified
**[mappingRepo.ts:131-154]**

REPLACE = DELETE+INSERT: сбрасывает `times_seen`/`last_seen_*`/`created_at` в дефолты, меняет `id`, каскадит FK `mapping_supplier_usage ON DELETE CASCADE`.

**Фикс:** `INSERT ... ON DUPLICATE KEY UPDATE` с явным списком колонок.

### 2.9 Telegram: нет обработки 429 — уведомления теряются ✓verified
**[telegramClient.ts:87-104 любой не-ok → generic Error]**

Батч-загрузка 20 фото → burst sendMessage → 429 → часть уведомлений пропала без ретрая.

**Фикс:** на 429 читать `parameters.retry_after`, одна повторная попытка после паузы; простая очередь на chat_id.

### 2.10 Graceful shutdown не дренирует in-flight OCR ✓verified
**[index.ts:168-192 fileWatcher.stop() не await'ит watcher.close(); фоновые processFile не отслеживаются]**

`process.exit(0)` убивает обработку посреди Claude-вызова → строка в `ocr_processing` → на старте срабатывает 1.1 (delete + повторный платный OCR).

**Фикс:** счётчик in-flight обработок + ожидание с таймаутом перед `closeDb()`; `await watcher.close()`.

### 2.11 Прочее среднее (списком, детали — в приложении)
- **multipleStatements: true на боевом пуле** [db.ts:22] — нужен только миграциям; расширяет blast radius инъекций. Вынести в отдельное соединение.
- **Накладная+позиции без транзакции** [fileWatcher delete+addItem-loop] — `/pending` может отдать частичный список позиций одобренной накладной при rescan. Обернуть в `db.transaction`, исключить нетерминальные статусы из pending.
- **Утечка Tesseract-worker'ов** [ocrManager.ts:135-162] — `factory()` создаёт новый engine на каждый forced-scan, worker не терминируется.
- **Merge-фолбэк appendParsedPage пропускает VAT-санитайзеры** [fileWatcher.ts:510-559] — несанированная страница с «без НДС»-ценами вливается в total.
- **camera.html устарел** [public/camera.html:117 плейсхолдер API_KEY, читает несуществующий invoice_id] — либо удалить (роут `#/camera` уже редиректит на upload), либо переписать под async-контракт.
- **res.json() без res.ok** [sber.js:7-8,121,131; suppliers.js:216-217,254-255] — зависший спиннер/unhandled rejection на 500. Использовать `App.apiJson`.
- **Нет реакции на 401 от Сбера + seed-token выдумывает expires_at +30 дней** [sber.ts:89-91, oauth.ts:104-109] — мёртвый токен шлётся до бесконечности. При 401 — форс-refresh + один retry.
- **pending-строка Sber навсегда блокирует retry при падении между INSERT и вызовом** [invoices.ts:1636-1654] — стартовый sweep «pending старше N → failed».
- **markStaleAsFailed/recovery/dispatcher-sweep не знают друг о друге** — унифицировать три механизма оживления застрявших строк.

---

## P3 — Низкий. Гигиена, косметика, латентные футганы

- **Двойная отправка форм** — sber.js saveSeed/savePayer, sber-modal.js submit, profile.js save, settings.js save — нет `disabled` на время запроса. Дизейблить кнопку.
- **Утечка payer_account не-админам** [invoices.ts:1469-1474 GET /:id/sber-status отдаёт сырую строку sber_payments] — фильтровать для не-админов (как делает /api/sber/status).
- **Нет проверки контрольных сумм ИНН** [suppliers.ts:53, sber.ts:16 — только 10/12 цифр] — OCR-опечатка в ИНН уходит в платёжку. Добавить алгоритм ФНС.
- **OAuth state не одноразовый, purpose не проверяется** [oauth.ts:32-39, sber.ts:41-42] — добавить nonce-store и проверку `purpose==='connect'`.
- **redact() не покрывает camelCase-ключи и циклы** [sber/redact.ts] — `accessToken`/`refreshToken` не в SECRET_KEYS; рекурсия без cycle-guard.
- **Logger SENSITIVE_KEY_PATTERN не покрывает bot_token/access_token/refresh_token/token** [logger.ts:10] — расширить паттерн (защита «последней линии»).
- **НДС в purpose: ставка из items[0], сумма не сверяется** [invoices.ts:1588] — смешанные ставки дадут неверный purpose; при усечении до 210 может отрезаться обязательная НДС-оговорка.
- **detectOrientationWithClaude захардкожен на sonnet** [ocrManager.ts:55-66, комментарии говорят «Haiku»] — 4 изображения × Sonnet, `analyzer_config.claude_model` игнорируется, +30с латентности/страница.
- **withRetry игнорирует retry-after при 429** [claudeApiAnalyzer.ts:50-78].
- **Коллизия temp-имён при параллельном препроцессинге** [ocrManager.ts:109 `ocr_${Date.now()}`] — две страницы в одну мс → перезапись. Добавить `randomUUID()`.
- **container-фильтр: стем 'нож' блокирует «Ножки куриные»** [packTransform.ts:54-66] — уточнить границу слова.
- **mapper.invalidateCache() в цикле по позициям** [fileWatcher.ts:1263] — десятки перечиток каталога на накладной в 40 строк. Инвалидировать один раз после цикла.
- **LIKE без экранирования %/_ ** [invoiceRepo getAll/findRecentByFileName, supplierRepo.list, onecNomenclatureRepo.listItems] — ложные совпадения (не инъекция). Хелпер `escapeLike()`.
- **parseNumber заменяет только первую запятую** [invoiceParser.ts:50-55] — «1 234 567,89» ломается на форматах с несколькими разделителями.
- **mailer: rejectUnauthorized:false для SMTP, HTML-инъекция в письмо, lastSentAt до отправки** [mailer.ts:80,124-128,113] — мёртвый код (email off), чинить при реанимации.
- **VALUES() в ON DUPLICATE KEY UPDATE — deprecated** [onecNomenclatureRepo.ts:41-49] — заменить на alias-синтаксис.
- **runMigrations без межпроцессной блокировки** [migrations.ts:908-958] — `SELECT GET_LOCK('scanflow_migrations', 30)`.
- **digestWorker — мёртвая фича, но 3 cron молотят БД каждый час** — удалить.
- **@types/* в dependencies** [package.json:44-47] — перенести в devDependencies.
- **Нет engines/.nvmrc** — CI на Node 20, CLAUDE.md заявляет Node 25.
- **max_memory_restart: 256M** [ecosystem.config.js:25] — sharp+tesseract на большом фото превышают → PM2 убивает посреди OCR. Поднять до 512M.
- **apiKeyAuthQueryAllowed — мёртвый код** [auth.ts:71-87] — удалить.

---

## Порядок работ (рекомендуемый)

**Спринт 1 (безопасность/деньги, до всего остального):**
0.7 (git-секреты — сделать первым, до любого `git add`), 0.1, 0.2, 0.3, 0.4, 0.5 (проверить mysqldump-cron), 0.6.

**Спринт 2 (тихая порча учётных данных):**
0.8, 1.5, 1.6, 1.7, 1.11, 1.3, 1.4.

**Спринт 3 (устойчивость пайплайна):**
1.1, 1.2, 1.8, 1.9, 1.10, 1.12, 2.5, 2.10.

**Спринт 4 (инфраструктура/тесты/миграции):**
2.1, 2.2, 2.3, 2.4, 2.6 + остаток P2.

**Спринт 5 (гигиена):** P3 по мере касания соответствующих файлов.

## Что проверить на проде до начала (⚠needs-prod-check)
1. Состояние `DATA_SCOPING_ENABLED` на scanflow.ru (влияет на severity 0.1).
2. Доступен ли `/api/auth/register` публично на проде.
3. Настроен ли реальный `mysqldump`-cron (0.5) — есть ли вообще бэкапы.
4. Нет ли уже закоммиченных секретов в истории (`git log --all --full-history -- 'data/backup_*.json' 'Certs/*'`).

## Заметка о хорошем
Проект заметно закалён продовыми инцидентами: allow-list колонок (№18), atomic-dedup через UNIQUE-индекс, честные комментарии «почему», дисциплина экранирования в основном дашборде (invoices.js через textContent/App.esc), корректная изоляция `emit()` от пайплайна, продуманные rsync-exclude'ы. Все проверенные инварианты CLAUDE.md, кроме №16 (частично) и духа №20 (send-sber/suppliers), соблюдены. Основные риски — не в «плохом коде», а на **стыках подсистем** и в **дефолтах, которые безопасны только при правильном прод-конфиге**.
