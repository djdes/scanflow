# Мультивыбор накладных + массовая отправка в 1С / Сбер — design

- **Дата:** 2026-07-31
- **Статус:** согласован, к реализации
- **Повод:** отправлять пачку накладных в 1С и/или Сбер по одной — долго. Нужны чекбоксы мультивыбора и массовые действия.

## 1. Решения из брейншторма

| Вопрос | Решение |
|---|---|
| Структура кнопок | Панель выбора с **тремя** кнопками: «→ 1С», «→ Сбер», «→ 1С и Сбер». |
| Частичные отказы | **Пропустить + отчёт**: отправить все «чистые», остальные пропустить со сводкой «N отправлено / M пропущено — почему». |
| Approval по лимиту в bulk | Массово approval-запросы НЕ создаём — про такие пишем «выше лимита, отправьте по одной». |

## 2. UI — выбор (public/js/invoices.js, app.html, style.css)

- Новая **первая колонка** таблицы — чекбокс в каждой строке; чекбокс «выбрать все» в шапке (выбирает все ЗАГРУЖЕННЫЕ строки текущей выборки).
- Клик по чекбоксу — `stopPropagation`, чтобы не открывалась деталь.
- Состояние выбора — на фронте: `Invoices._selected = new Set()`. Сбрасывается при `loadTable()` (смена фильтра/страницы/поиска), т.к. набор строк меняется.
- Когда выбрано ≥1 — над таблицей появляется панель **«Выбрано N»** с кнопками «→ 1С», «→ Сбер», «→ 1С и Сбер», «Снять выделение». При 0 — панель скрыта.
- Колонка чекбоксов не ломает существующий `colspan` заголовков дат — он увеличивается на 1 (сейчас 9 → 10).

## 3. Backend — стратегия: loopback вместо рефактора (пересмотр)

Изначально план был извлечь ядро роутов в сервис-функции. **Отклонено:** роут `/:id/send-sber` — критический денежный путь на ~210 строк, а его E2E-тест (`tests/api/invoices.send-sber.test.ts`) — пустой placeholder. Рефактор без страховки тестами слишком рискован.

Вместо этого — **loopback-паттерн, уже узаконенный в кодбазе** (`src/services/autoSendSber.ts`): batch-эндпоинт делает внутренний HTTP-POST на одиночный роут в контексте владельца, переиспользуя ВСЮ его валидацию, ничего в нём не меняя. Одиночные роуты `/:id/send` и `/:id/send-sber` не трогаем вообще → нулевой риск для отправки.

Общий хелпер `src/services/bulkSend.ts`:
```
loopbackPost(path, apiKey, body): Promise<{ status: number; json: any }>   // http://127.0.0.1:<apiPort>...
```
Ответ одиночного роута мапится в исход batch: `sent` | `skipped(reason)`.

## 4. Backend — batch-эндпоинты (шаблон `delete-batch`)

`POST /api/invoices/send-1c-batch` и `POST /api/invoices/send-sber-batch`, тело `{ ids: number[] }`:
1. Валидация: `ids` непустой массив ≤500, все — положительные целые; дедуп.
2. **Preflight owner-проверка** всей пачки (как `delete-batch:1200`): каждый id существует и `owner_user_id === req.user.id`, иначе `404` без частичного эффекта (не течём чужими id). Заодно получаем объекты накладных.
3. Порог согласования читаем **один раз** (`automationRepo.get()`).
4. Поштучно (по уже загруженным накладным):
   - **Pre-check** — чтобы не плодить approval-запросы и дёшево отсечь заведомо-скип:
     - 1С: `status != 'processed'` → skip(`not_processed`); `approved_for_1c` → skip(`already_approved`); `total_sum > threshold && !hasApproved(id,'1c')` → skip(`over_threshold`) БЕЗ loopback.
     - Сбер: `total_sum > threshold && !hasApproved(id,'sber')` → skip(`over_threshold`) БЕЗ loopback.
   - Иначе — **loopback** POST на `/:id/send` или `/:id/send-sber` (тело `{}`) с тем же `X-API-Key`, что пришёл в batch (владелец подтверждён на preflight).
   - **Маппинг ответа:**
     - 1С: 200 → `sent`; 400 → skip(`not_processed`); прочее → skip(`error`).
     - Сбер: `success:true` → `sent`; 409 `needs_supplier_confirmation` → skip(`supplier_unverified`); 409 conflict/`already created` → skip(`already_paid`); 400 → skip(причина из тела: `no_inn`/`no_total`/`not_connected`/`payer_incomplete`/`no_owner`); 502 → skip(`api_error`).
5. Ответ: `{ data: { sent: number, skipped: Array<{ id, reason }>, total: number } }`.

Порог/`hasApproved` в pre-check — единственное, что дублируется из роутов; это read-only и стабильно. Approval-запросы в bulk не создаются (pre-check отсекает over_threshold до loopback).

Кнопка «→ 1С и Сбер» на фронте зовёт **оба** эндпоинта (последовательно) и объединяет отчёт.

## 5. Отчёт на фронте

После bulk-действия — сводка (нотификация + при наличии пропусков небольшая модалка со списком):
- «1С: N одобрено, M пропущено» / «Сбер: K отправлено, L пропущено».
- Пропуски сгруппированы по причине с человекочитаемыми подписями (например `supplier_unverified` → «поставщик не подтверждён — отправьте по одной», `over_threshold` → «выше лимита согласования», `already_paid` → «платёж уже создан»).
- После успеха — `loadTable()` (обновить статусы) и сброс выбора.

## 6. Тестирование

Правило 17 CLAUDE.md: тесты только на `127.0.0.1`, `DB_NAME` c `test`.

Loopback (`fetch`) в тестах мокается — как в `tests/services/autoSendSber.test.ts`. Preflight/pre-check идут по реальной тестовой БД, `fetch` возвращает канонические ответы одиночного роута по URL.

- **Валидация:** пустой/огромный `ids` → 400; нечисловой id → 400.
- **Owner-изоляция:** чужой id в пачке → 404, ничего не отправлено (`fetch` не вызван).
- **Pre-check (без `fetch`):** `send-1c-batch` — `error`-накладная → skipped(`not_processed`); `approved_for_1c` → skipped(`already_approved`); выше лимита → skipped(`over_threshold`), approval-запрос НЕ создан (проверить `approvalRepo`). `send-sber-batch` — выше лимита → skipped(`over_threshold`).
- **Маппинг loopback:** mock `fetch` по id → success → `sent`; 409 `needs_supplier_confirmation` → skipped(`supplier_unverified`); 409 conflict → skipped(`already_paid`); 400 `no supplier_inn` → skipped(`no_inn`). Проверить агрегат `{sent, skipped, total}`.
- Одиночные роуты `/:id/send` и `/:id/send-sber` НЕ меняются → существующие тесты остаются валидны.

## 7. Вне области

- Массовое согласование сумм выше лимита (остаётся по одной через approval-flow).
- Bulk-подтверждение реквизитов неверифицированных поставщиков через модалку (по одной).
- «Выбрать все на всех страницах» (выбор ограничен загруженными строками).
