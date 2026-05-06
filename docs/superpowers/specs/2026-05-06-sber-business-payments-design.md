# Платёжные поручения в Сбербанк Бизнес из накладной

**Дата:** 2026-05-06
**Автор:** Claude (брэйнсторм с Oleg)
**Статус:** Design — ждёт ревью пользователем
**Источник Sber API:** [Создание рублевого платежного поручения](https://developers.sber.ru/docs/ru/sber-api/specifications/payments/create-payment) + OpenAPI [`payments.yaml`](https://developers.sber.ru/docs/files/openapi/sbapi/payments.yaml)

---

## Проблема

После того как накладная отсканирована и реквизиты поставщика распознаны (ИНН, БИК, р/с, итоговая сумма, НДС), пользователь руками заходит в СберБизнес и заполняет ту же платёжку — это дубль работы и источник опечаток. Нужно: на странице деталей накладной — кнопка «Отправить в Сбербанк», по которой в банке появляется черновик платёжного поручения с уже заполненными реквизитами и назначением, готовый к подписи.

Подсмотрено как стартовая база: реализация в `C:\www\TotalBussines` (Next.js, Prisma, OAuth + mTLS клиент Сбера). Оттуда переиспользуем подход к mTLS и OAuth, но **код TotalBussines не работал в проде** — он бил в `/v1/payments` без половины обязательных полей и с заголовком `Bearer`, который Sber не принимает. Делаем по официальной OpenAPI v1.

## Не-цели (явно вне scope)

- **Электронная подпись (ЭП) платёжного документа на стороне ScanFlow.** Sber API позволяет создавать платёжки **без** `digestSignatures` — документ ложится в **черновики** в СберБизнес, юзер сам подписывает токеном через интерфейс банка. Это и есть нужное нам поведение: ScanFlow заполняет реквизиты, человек принимает финальное решение в банке. Подпись через `cryptopro/КриптоПро` или аналоги — отдельная большая фича, сейчас не нужна.
- **Multi-tenant.** Один инстанс ScanFlow = одна организация-плательщик. Один токен Сбера, один р/с. Если в будущем понадобятся несколько ООО — миграция (нынешняя `sber_tokens` rebuilds в 1-к-1 с `users`).
- **Получение / парсинг выписок (`GET_STATEMENT_*` scope).** Сейчас не делаем — в продукте пока нет надобности видеть, что платёжка прошла. Если пригодится — отдельный спек.
- **Платёжные требования (`PAYMENT_REQUEST_OUT` scope).** Это другой документ — мы его не используем.
- **Частичные оплаты, рассрочки, групповые платежи.** Один платёж на накладную. Если понадобится — миграция таблицы `sber_payments` (снять UNIQUE на `invoice_id`).
- **Удаление токенов TotalBussines / синхронизация с ним.** TotalBussines живёт отдельно в своей БД, мы его не трогаем.
- **Шифрование токенов at-rest в БД.** Хранятся plain text, как сейчас в `users.telegram_bot_token`. Доступ к sqlite-файлу ограничен правами ОС.

---

## Архитектура

```
[UI накладной] ──► POST /api/invoices/:id/send-sber ──► createPaymentOrder()
                            │                                  │
                            ├─ resolve payee (suppliers DB)    └─ mTLS HTTPS request
                            │   └─ если verified=0 → 409       (cert/key/ca из ./certs)
                            │
                            ├─ build purpose (template + invoice fields)
                            │
                            └─ INSERT INTO sber_payments
                                 (UNIQUE(invoice_id) защищает от двойного клика)
```

### Новые файлы

```
src/
  sber/
    sberClient.ts            mTLS-обёртка над node:https (читает PFX через fs+passphrase)
    oauth.ts                 createOAuthState/verifyOAuthState/exchangeCodeForToken/refreshAccessToken/getValidToken
    payments.ts              createPaymentOrder() — собирает payload, вызывает /v1/payments
    purposeTemplate.ts       рендер шаблона назначения платежа из invoice + supplier
    dadata.ts                lookup по ИНН (опционально, через DADATA_API_KEY)
    redact.ts                утилита для маскирования секретов в логах
  database/
    repositories/
      sberTokenRepo.ts       одна строка (single-tenant)
      supplierRepo.ts        CRUD по поставщикам
      sberPaymentRepo.ts     лог отправок
  api/
    routes/
      sber.ts                /authorize, /callback, /seed-token, /status, /disconnect
      suppliers.ts           CRUD + /lookup-dadata
    middleware/              без изменений
public/
  js/
    sber.js                  кнопка + модалка подтверждения реквизитов
    suppliers.js             страница списка/CRUD
  app.html                   +пункт «Поставщики» в навигации, +секция «Сбербанк» в детали накладной
certs/                       (gitignored) sber.p12 + sber-ca.pem
```

### Изменения в существующих файлах

- `src/api/routes/invoices.ts` — добавить `POST /:id/send-sber`, `GET /:id/sber-status`.
- `src/database/migrations.ts` — миграция 20 (одним блоком, см. ниже).
- `src/ocr/claudeApiAnalyzer.ts` — научить промпт извлекать `supplier_kpp`. В JSON ответа добавить поле; парсить «ИНН/КПП X/Y» — после слэша.
- `src/api/server.ts` — mount новые роуты `sberRoutes`, `suppliersRoutes`.
- `.env.example` — добавить блок Sber и DaData переменных.
- `.gitignore` — добавить `certs/` и `DocsApiSber/` (скачанные HTML докI).

---

## БД (миграция 20)

Одна миграция со всеми изменениями:

### 20a. `sber_tokens` — токены OAuth + реквизиты плательщика

```sql
CREATE TABLE sber_tokens (
  id INTEGER PRIMARY KEY CHECK (id = 1),    -- single-tenant: ровно одна строка
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,                  -- ISO datetime
  account_number TEXT,                       -- 20 digits — наш payerAccount
  org_name TEXT,                             -- наш payerName (из client-info или вручную)
  payer_inn TEXT,
  payer_kpp TEXT,
  payer_bank_bic TEXT,                       -- 9 digits, БИК Сбера региона плательщика
  payer_bank_corr_account TEXT,              -- 20 digits, корсчёт банка плательщика
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

`detect()` миграции: `hasTable(db, 'sber_tokens')`.

### 20b. `suppliers` — справочник поставщиков (payee)

```sql
CREATE TABLE suppliers (
  inn TEXT PRIMARY KEY,                      -- 10 (юрлицо) или 12 (ИП) цифр
  name TEXT NOT NULL,                        -- payeeName
  kpp TEXT,                                  -- payeeKpp (нет у ИП)
  account TEXT,                              -- 20 digits, payeeAccount
  bank_bic TEXT NOT NULL,                    -- 9 digits, payeeBankBic (обязательно для Сбера)
  bank_corr_account TEXT,                    -- 20 digits, payeeBankCorrAccount
  bank_name TEXT,
  address TEXT,
  verified INTEGER NOT NULL DEFAULT 0,       -- 1 = подтверждено пользователем
  source TEXT,                               -- 'manual' | 'invoice' | 'dadata'
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);
CREATE INDEX idx_suppliers_name ON suppliers(name COLLATE NOCASE);
```

### 20c. `sber_payments` — лог отправок (1:1 с накладной)

```sql
CREATE TABLE sber_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL UNIQUE,        -- UNIQUE = "один платёж на накладную"
  external_id TEXT NOT NULL UNIQUE,          -- UUID, отдан в Sber как externalId
  status TEXT NOT NULL,                      -- 'pending' | 'created' | 'failed'
  payment_purpose TEXT NOT NULL,
  amount REAL NOT NULL,
  payer_account TEXT NOT NULL,
  payee_inn TEXT NOT NULL,
  request_payload TEXT,                      -- JSON request body (без секретов)
  response_body TEXT,                        -- JSON response body
  sber_payment_number TEXT,                  -- если Sber присвоил number
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
);
```

### 20d. `invoices.supplier_kpp`

```sql
ALTER TABLE invoices ADD COLUMN supplier_kpp TEXT;
```

(Backfill не нужен — старые накладные пойдут без КПП, юзер дозаполнит при подтверждении модалки.)

### 20e. `users.sber_purpose_template`

```sql
ALTER TABLE users ADD COLUMN sber_purpose_template TEXT
  DEFAULT 'Оплата по накладной № {invoice_number} от {invoice_date_dot}, {vat_clause}';
```

---

## Sber API — точная спека (источник: payments.yaml v1)

### Endpoint
`POST https://fintech.sberbank.ru:9443/fintech/api/v1/payments`

Тестовая среда — `https://iftfintech.testsbi.sberbank.ru:9443/fintech/api`. Сейчас не используем (по решению юзера тестируем сразу на проде).

### Заголовки
- `Authorization: {access_token}` — **без слова `Bearer`** (это критично; в TotalBussines была ошибка)
- `Content-Type: application/json`
- `Accept: application/json`

### TLS
- Клиентский mTLS обязателен. PKCS12 (`.p12`) + passphrase, либо разделённые `.crt`/`.key`. Используем `.p12` напрямую через `https.request({ pfx, passphrase })` — в Node это работает.
- `ca` — цепочка доверенных серверных сертификатов Sber (отдельный файл, скачивается с портала). Для разработки можно `rejectUnauthorized: false`, в проде — `ca: fs.readFileSync(SBER_CA_CERT)`.

### Body — `FintechPaymentIncomingRequest`

| Поле | Тип | Обяз | Формат / лимит | Источник в ScanFlow |
|------|-----|------|----------------|----------------------|
| `date` | string | да | `^\d{4}-\d{2}-\d{2}$` (YYYY-MM-DD) | дата отправки = `today()` |
| `externalId` | string | да | UUID, ≤36 символов | `crypto.randomUUID()` |
| `amount` | number | да | минимум 0.01 | `invoices.total_sum` |
| `operationCode` | string | да | константа `"01"` | константа |
| `priority` | string | да | `"1"`-`"5"` | `"5"` (обычная очерёдность) |
| `purpose` | string | да | maxLength 210 | рендер шаблона |
| `payerName` | string | да | | `sber_tokens.org_name` |
| `payerInn` | string | да | | `sber_tokens.payer_inn` |
| `payerAccount` | string | да | `^[0-9]{20}$` | `sber_tokens.account_number` |
| `payerBankBic` | string | да | `^[0-9]{9}$` | `sber_tokens.payer_bank_bic` |
| `payerBankCorrAccount` | string | да | `^[0-9]{20}$` | `sber_tokens.payer_bank_corr_account` |
| `payeeName` | string | да | | `suppliers.name` |
| `payeeBankBic` | string | да | `^[0-9]{9}$` | `suppliers.bank_bic` |
| `number` | string | нет | `^\d{0,8}$` | пусто (Sber присвоит) |
| `payerKpp` | string | нет | | `sber_tokens.payer_kpp` |
| `payeeAccount` | string | нет | `^[0-9]{20}$` | `suppliers.account` |
| `payeeInn` | string | нет | | `suppliers.inn` |
| `payeeKpp` | string | нет | | `suppliers.kpp` |
| `payeeBankCorrAccount` | string | нет | `^[0-9]{20}$` | `suppliers.bank_corr_account` |
| `digestSignatures` | array | нет | — | **не передаём** → черновик |

### Ответы
- **201 Created** — успех. В body — созданная сущность с `externalId` и присвоенным `number`. Документ в статусе `ACCEPTED` (черновик, ждёт подписи).
- **400** — валидация (часто: неправильный БИК, длина счёта). Текст ошибки в JSON.
- **401** — токен истёк/невалидный → triggers refresh + retry один раз.
- **403** — scope не выдан. Юзер должен переподключить OAuth.
- **429** — rate limit (Sber говорит «Превышен лимит запросов»). Backoff не реализуем (один платёж — один клик), просто показываем «Подождите минуту, попробуйте снова».
- **500/503** — серверная ошибка / временно недоступно. Разрешаем retry.

---

## Шаблон назначения платежа (`purpose`)

### Дефолтный шаблон

```
Оплата по накладной № {invoice_number} от {invoice_date_dot}, {vat_clause}
```

### Плейсхолдеры

| Плейсхолдер | Источник | Пример |
|-------------|----------|--------|
| `{invoice_number}` | `invoices.invoice_number` | `НФНФ-000085` |
| `{invoice_date_dot}` | `invoices.invoice_date` отформатировано как `DD.MM.YYYY` | `06.05.2026` |
| `{invoice_date_iso}` | `invoices.invoice_date` как есть | `2026-05-06` |
| `{total}` | `invoices.total_sum` форматировано `1234.56` | `66714.11` |
| `{vat_amount}` | `invoices.vat_sum` форматировано | `11119.02` |
| `{vat_rate}` | `invoice_items[0].vat_rate` или дефолт `20` | `20` |
| `{supplier}` | `suppliers.name` | `ООО "Свит лайф фудсервис"` |
| `{vat_clause}` | если `vat_sum != null && vat_sum > 0` → `в т.ч. НДС {vat_rate}% — {vat_amount} руб.`; иначе → `Без НДС` | `в т.ч. НДС 20% — 11119.02 руб.` |

### Ограничения
- После рендера: если длина > 210 — отрезаем до 207 + многоточие, в `winston.warn` пишем `purpose truncated for invoice {id}`.
- Допустимые символы: согласно YAML — практически любые UTF-8 (паттерн `^(.|\n|\r){0,210}$`). Но по факту Sber на проде ругается на нестандартные кавычки — заменяем `"`/`«»` на `"`. Утилита `sanitizePurpose()`.
- Шаблон редактируется юзером в настройках. В модалке отправки — превью отрендеренного `purpose` с возможностью править руками для конкретного платежа.

---

## API — новые роуты

Все требуют `X-API-Key` (как остальные — middleware уже есть).

### `GET /api/sber/authorize` → 302 на Sber OAuth URL
- Создаёт state-JWT (HMAC-SHA256, секрет из `JWT_SECRET`, TTL 10 минут), заказывает редирект на:
  `https://sbi.sberbank.ru:9443/v2/oauth/authorize?scope=openid GET_CLIENT_ACCOUNTS PAY_DOC_RU&response_type=code&client_id=...&state=...&nonce=<uuid>&redirect_uri=...`

### `GET /api/sber/callback`
- Принимает `?code=&state=&error=`.
- Верифицирует state-JWT (TTL, HMAC).
- Обменивает code на access/refresh через `POST https://fintech.sberbank.ru:9443/v2/oauth/token` (mTLS, `grant_type=authorization_code`).
- Сохраняет в `sber_tokens` (upsert id=1).
- Подтягивает `client-info` (`GET /fintech/api/v2/client-info`) — если в ответе есть `accounts` и `orgName`, заполняет `account_number` и `org_name`.
- Редирект обратно в `/#/sber-connect` со статусом `?sber=connected` или `?sber=error&sber_error=...`.

### `POST /api/sber/seed-token` (manual flow)
- Body: `{ access_token, refresh_token, expires_at?, account_number, org_name, payer_inn, payer_kpp, payer_bank_bic, payer_bank_corr_account }`.
- Валидирует длины (`account_number` — 20 цифр, `payer_bank_bic` — 9 цифр, `payer_bank_corr_account` — 20 цифр).
- Upsert в `sber_tokens` id=1.

### `GET /api/sber/status`
- Возвращает `{ connected, account_number, org_name, token_expired, payer_complete }` где `payer_complete` = все обязательные payer-поля заполнены.

### `POST /api/sber/disconnect`
- `DELETE FROM sber_tokens WHERE id = 1`.

### `GET /api/suppliers?q=&verified=`
- Поиск по имени или ИНН (LIKE), фильтр по `verified`.

### `GET /api/suppliers/:inn`
- Одна запись.

### `POST /api/suppliers`
- Body: всё содержимое таблицы `suppliers` минус timestamps + `verified` (всегда 1, если ручное создание).
- Валидирует ИНН (10 или 12 цифр), БИК (9), счета (20 каждый).

### `PATCH /api/suppliers/:inn`
- То же, что POST, но обновление.

### `DELETE /api/suppliers/:inn`
- Простое удаление без дополнительных проверок. Один пользователь, сам себе не навредит — соответствие YAGNI. Если в будущем появится 2+ операторов — добавим guard «не удалять, если за 90 дней были платежи».

### `POST /api/suppliers/lookup-dadata`
- Body: `{ inn }`.
- Если `DADATA_API_KEY` пуст → 503 `{ error: "DaData not configured" }`.
- Проксирует в DaData findById/party, возвращает нормализованный объект:
  ```json
  {
    "name": "ООО \"СВИТ ЛАЙФ ФУДСЕРВИС\"",
    "inn": "5012089824",
    "kpp": "501201001",
    "address": "...",
    "bank": null  // DaData не отдаёт банковские реквизиты — заполняет юзер
  }
  ```

### `POST /api/invoices/:id/send-sber`
- Body: `{ purpose_override?: string, supplier_overrides?: { ...поля suppliers... } }`.
- Алгоритм:
  1. `SELECT * FROM invoices WHERE id = ?`.
  2. Проверяем `total_sum > 0`, `supplier_inn IS NOT NULL`.
  3. Проверяем что в `sber_payments` ещё нет записи для этой `invoice_id` (UNIQUE отсечёт, но сразу 409 без обращения к Sber).
  4. Резолвим payee:
     - `SELECT * FROM suppliers WHERE inn = ?`. Если нет или `verified=0` → возвращаем 409 с body `{ needs_supplier_confirmation: true, prefilled: { name, inn, kpp, account, bank_bic, bank_corr_account, address } }` (всё, что есть из накладной).
     - Если есть `supplier_overrides` в запросе — это значит фронт уже показал модалку и юзер подтвердил → upsert в `suppliers` с `verified=1`, продолжаем.
  5. Берём токен через `getValidToken()` (auto-refresh при istечении).
  6. Рендерим purpose (override или шаблон из `users.sber_purpose_template`).
  7. INSERT `sber_payments` со status='pending', external_id=UUID. UNIQUE на `invoice_id` защищает от двойного клика.
  8. POST в Sber. На 201:
     - UPDATE row → status='created', sber_payment_number, response_body.
     - Возврат `{ success: true, payment_number, external_id }`.
  9. На non-2xx:
     - UPDATE row → status='failed', error_message, response_body.
     - Возврат 502 `{ error, sber_status, sber_response }`.

### `GET /api/invoices/:id/sber-status`
- Возвращает запись из `sber_payments` (или `null`).

---

## Фронтенд

### Страница `/#/invoices/:id` (детали накладной)

В блоке actions, под кнопкой «Отправить в 1С», новая секция:

```
Сбербанк
─────────
[ Отправить в Сбербанк → ]    (если sber_payments нет)

или

✓ Платёж создан в Сбере (черновик № 12345). Подпишите в Сбер.Бизнес.
[Распечатать платёжку]    (всегда виден, fallback)
```

Состояния кнопки:
- `idle` — `Отправить в Сбербанк →` (primary).
- `sending` — `Создание платежа...` (disabled, спиннер). На время запроса `disabled` — защита от двойного клика.
- `success` — кнопка пропадает, бейдж + ссылка на печатную форму.
- `error` — toast c error message, кнопка снова `idle`.

При нажатии:
1. `POST /api/invoices/:id/send-sber` без body → если 409 с `needs_supplier_confirmation`, открывается модалка.
2. Модалка «Подтвердите реквизиты поставщика» — все поля с прешитым значением (из `prefilled`), плюс кнопка «Заполнить по ИНН (DaData)» (если фича включена). После «Сохранить» — `POST /api/invoices/:id/send-sber` уже с `supplier_overrides`.
3. Под формой — превью `purpose` с textarea. Юзер может править — тогда отправляется как `purpose_override`.

### Страница `/#/suppliers`

Новая вкладка в навигации (между «Номенклатура» и «Webhook»).

Таблица:
| ИНН | Наименование | КПП | БИК | Счёт | Verified | Last used | Actions |

Под таблицей — кнопка `+ Добавить поставщика` → модалка с полями + DaData-кнопка.

Клик по строке — открывает ту же модалку в режиме edit.

### Страница `/#/sber`

Отдельная страница, на неё ведёт новый пункт навигации «Сбербанк» в `app.html` (после пункта «Webhook»). В существующей навигации ScanFlow нет общей вкладки «Settings» — поэтому отдельная страница, а не вложенная вкладка.

Содержимое:

- Если не подключено: две кнопки `[OAuth]` `[Ввести вручную]`.
- Если подключено: бейдж статуса (`organization`, `account_number`, `token_expired ? "просрочен" : "активен"`), внизу — поля `payer_inn` / `payer_kpp` / `payer_bank_bic` / `payer_bank_corr_account` для ручного редактирования (на случай если `client-info` их не вернул). Кнопка «Сохранить реквизиты». И отдельно `[Отключить]`.

При отображении кнопки «Отправить в Сбербанк» в детали накладной: проверяем `GET /api/sber/status` → если `connected=false` или `payer_complete=false` → кнопка disabled с tooltip «Подключите Сбербанк на странице Сбербанк».

---

## DaData интеграция (опциональная)

- Endpoint: `POST https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party`.
- Headers: `Content-Type: application/json`, `Authorization: Token {DADATA_API_KEY}`, `Accept: application/json`.
- Body: `{ "query": "<INN>" }`.
- Response: `{ "suggestions": [{ "value": "...", "data": { "inn": "...", "kpp": "...", "name": { "full": "..." }, "address": { "value": "..." } } }] }`.
- Маппинг → `{ name: data.name.full, inn: data.inn, kpp: data.kpp, address: data.address.value }`.
- Если `DADATA_API_KEY` не установлен → endpoint возвращает 503, фронт скрывает кнопку.

---

## Безопасность

### Токены
- `sber_tokens` хранится plain text (как `users.telegram_bot_token` — прецедент уже есть в проекте).
- Логи **никогда не пишут** access/refresh tokens. Утилита `redact()` пробегает по объекту и заменяет значения ключей `access_token|refresh_token|payerAccount|payeeAccount|client_secret|api_key|password` на `***`.
- `sber_payments.request_payload` сохраняет body, но прогоняет его через `redact()` перед записью.

### Сертификаты
- `certs/` в `.gitignore` (добавляется в этой миграции, если ещё нет).
- На проде — копируются вне git (как `google-credentials.json`). На сервере путь — `~/www/scanflow.ru/app/certs/`.
- `SBER_TLS_PFX_PASSWORD` в `.env` (не в БД, не в логах).
- `process.env.SBER_TLS_PFX_PASSWORD` читается один раз при старте и ассайнится в локальную переменную, чтобы не светиться в `process.env` дампах.

### CSRF на OAuth state
- `state` — JWT с TTL 10 минут, подписан `JWT_SECRET` через `jose` (уже зависимость? — если нет, добавляем; альтернатива — `jsonwebtoken`).

### Rate limiting
- На `POST /api/invoices/:id/send-sber` — middleware с лимитом 30 запросов / 5 минут на IP (как уже сделано на `/api/upload`).

---

## Логирование

- Все Sber-запросы пишутся через `winston`:
  - `info`: `[sber] POST /v1/payments status=201 invoice_id=42 external_id=...`
  - `error`: `[sber] POST /v1/payments status=400 invoice_id=42 sber_error="..."`
- Body request/response **не пишется в Winston** — только в `sber_payments` (отдельная таблица для дебага, доступна через `/api/debug/sber-payments?invoice_id=X`).

### Debug endpoint
- `GET /api/debug/sber-payments?invoice_id=<id>&limit=20` — список последних попыток, любые статусы.

---

## Тесты

Все тесты — `vitest`, mocking внешних HTTP через `vi.mock`.

```
tests/
  sber/
    sberClient.test.ts         mock https.request — проверяет TLS opts (pfx/passphrase/ca), сериализацию, парсинг, error states (timeout, ECONNREFUSED, 5xx, 401)
    oauth.test.ts              state JWT roundtrip, exchangeCodeForToken happy/error, refreshAccessToken
    payments.test.ts           createPaymentOrder — построение body, валидация полей перед отправкой, ответ 201/400/401/429
    purposeTemplate.test.ts    рендер всех плейсхолдеров, vat_clause c НДС / без НДС, обрезка >210
    dadata.test.ts             happy path (есть suggestions[0]), пустой ответ, 401
    redact.test.ts             все секретные ключи замаскированы, не-секретные не тронуты
  database/
    supplierRepo.test.ts       CRUD, find by inn, find by name, search
    sberTokenRepo.test.ts      get/save/delete, single-row constraint
    sberPaymentRepo.test.ts    insert with UNIQUE constraint, конкурентный INSERT падает
  integration/
    send-sber.happy.test.ts    invoice + verified supplier → 201 from mock → row persisted
    send-sber-409.test.ts      supplier не verified → 409 с prefilled
    send-sber-double-click.test.ts  два параллельных запроса → один success, второй 409
    send-sber-token-refresh.test.ts  401 от Sber → refresh → retry → 201
    suppliers-crud.test.ts     полный CRUD цикл через HTTP
```

Реальных запросов в Sber из CI **не делаем**. Подсунуть real fail/success — ручной smoke на сервере после деплоя.

---

## Поток подключения для Олега (manual seed на старте)

Из скриншота portal'а уже выпущены:
- Access token до 06.06.2026
- Refresh token до 02.11.2026
- TLS-сертификат шифрования действителен до 06.05.2027

**Шаги юзера после деплоя фичи:**

1. Скачать `.p12` и `sber-ca.pem` из портала разработчика, положить на сервер в `~/www/scanflow.ru/app/certs/`.
2. В `.env` дописать:
   ```
   SBER_CLIENT_ID=40285
   SBER_CLIENT_SECRET=9\oAuS<v
   SBER_REDIRECT_URI=https://scanflow.ru/api/sber/callback
   SBER_TLS_PFX=./certs/SBBAPI_40285_<uuid>.p12
   SBER_TLS_PFX_PASSWORD=Desdes123
   SBER_CA_CERT=./certs/sber-ca.pem
   DADATA_API_KEY=<опционально, из dadata.ru>
   ```
   Сертификат `SBBAPI_40285_<uuid>.p12` — точное имя файла подставляешь после загрузки из портала. CA-цепочка — отдельная скачка из портала, кладётся как `sber-ca.pem`.
3. Перезапустить PM2 (`pm2 restart scanflow`).
4. В UI открыть `/#/sber-connect` → «Ввести вручную» → вставить access/refresh + ввести `40702810940000099835` + ИНН/КПП/БИК банка/корсчёт.
5. Сохранить. Кнопка «Отправить в Сбербанк» становится активной на накладных.

---

## Известные риски

1. **`/v1/payments` может вернуть 400 на полях, которые YAML описывает как формально валидные.** Sber исторически строг к нестандартным символам в `payeeName`/`purpose` (длинные тире, неразрывные пробелы). Mitigation: `sanitizePurpose()` + при первом 400 в проде смотрим в `sber_payments.response_body` и расширяем санитайзер.
2. **Региональные БИКи Сбера** — у плательщика BIC = БИК отделения, в котором открыт р/с. Запросом `client-info` мы достаём только номер счёта; БИК банка и корсчёт юзер заполняет вручную в seed-форме. Это ОК, потому что они **константны** для аккаунта.
3. **Перевыпуск TLS-сертификата раз в год.** Срок 06.05.2027. Документация: ставить календарное напоминание + возможность загрузить новый `.p12` через UI (не делаем сейчас — просто кладём файл руками + рестарт). YAGNI.
4. **`refresh_token` истекает раз в полгода.** Когда `getValidToken()` поймает 401 на refresh — возвращаем понятный текст «Переподключите Сбер по OAuth» и блокируем кнопку отправки.

---

## Открытые вопросы (на момент подачи на ревью)

Никаких — все ключевые решения подтверждены пользователем в брэйнсторме:
- Hybrid-справочник поставщиков (C) + DaData (C1)
- OAuth + manual seed (C), стартуем с manual
- Redirect URI: `https://scanflow.ru/api/sber/callback` (тестируем сразу на проде)
- Custom-шаблон purpose в настройках, дефолт = вариант A, для накладных без НДС → «Без НДС»
- Идемпотентность: один платёж на накладную (B1), блокировка кнопки на время запроса
- Извлечение `supplier_kpp` через миграцию + дополнение Claude-промпта
- Сертификаты в `./certs/` (gitignored), пароль в `.env` как `SBER_TLS_PFX_PASSWORD`
