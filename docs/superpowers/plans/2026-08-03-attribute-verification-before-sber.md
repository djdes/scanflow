# План: чек-лист проверенных реквизитов перед отправкой в Сбер

Design: [`../specs/2026-08-03-attribute-verification-before-sber-design.md`](../specs/2026-08-03-attribute-verification-before-sber-design.md)

## Шаг 1 — миграция 57

`src/database/migrations.ts`: пять `TINYINT(1) NOT NULL DEFAULT 0` в `invoices`
(`attr_checked_number|date|supplier|total|vat`), каждая под `hasColumn`-guard,
`detect()` проверяет наличие последней из пяти. Без бэкфилла.

## Шаг 2 — репозиторий

`invoiceRepo`:
- поля в интерфейсе `Invoice`;
- `setAttrChecked(id, attr, value)` — одна колонка из **фиксированного маппинга**
  ключ→колонка (не интерполяция из запроса);
- `setAllAttrsChecked(id, value)` — все пять разом;
- `resetAttrChecks(id, attrs?)` — сброс указанных или всех; используется из
  PATCH и из путей перераспознавания;
- `ATTR_COLUMNS` — экспортируемый маппинг, единственный источник правды.

## Шаг 3 — сброс при изменении

- `PATCH /api/invoices/:id`: после успешного update — сброс галочек тех полей
  пятёрки, что реально пришли в теле;
- `fileWatcher.reprocessInvoice()` и путь добавления/склейки страниц — сброс
  всех пяти (шапка переписывается целиком).

## Шаг 4 — API

`POST /api/invoices/:id/attr-check` в `src/api/routes/invoices.ts`:
owner-scope → валидация `attr` по белому списку и `value` как boolean →
`setAttrChecked` / `setAllAttrsChecked` → ответ `{ data: { ...пять флагов, all_checked } }`.

## Шаг 5 — гейт на отправке

- `assertAttributesChecked(invoice)` → `string[]` непроверенных ключей;
- `POST /:id/send-sber`: непусто → 409 `{ error, attrs_unchecked }`, до создания
  платежа и до вызова Сбера;
- `src/services/bulkSend.ts` → `bulkSendSber()`: непроверенные не отправляем,
  кладём в отчёт как ошибку с текстом про чек-лист.

## Шаг 6 — UI карточки

`public/js/invoices.js` (`showDetail`): у пяти полей шапки — чекбокс с
`onchange="Invoices.toggleAttrCheck(...)"`; метод шлёт запрос и перерисовывает
состояние по ответу сервера.

`public/js/sber.js` (`renderInvoiceSection`): чекбокс «Все реквизиты сверены»
рядом с кнопкой; кнопка `disabled` с подсказкой о недостающих полях, пока
чек-лист неполон.

`public/css/style.css`: стили чекбокса поля и строки «все сверены».

## Шаг 7 — проверка

Автотесты (`tests/api/`) на серверную часть: 409 при неполном чек-листе +
`sber_payments` пуст; 200 при полном; PATCH сбрасывает нужную галочку; чужая
накладная → 404. Ручной прогон в браузере на локалке: галочки, общая галочка,
блокировка кнопки, массовая отправка.

`npx tsc --noEmit` после каждого шага с изменением TS.
