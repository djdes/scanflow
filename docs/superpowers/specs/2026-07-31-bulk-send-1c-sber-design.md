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

## 3. Backend — извлечение ядра отправки (DRY)

Логика одиночной отправки сейчас целиком внутри роутов (`/:id/send` ~75 строк, `/:id/send-sber` ~210 строк). Выношу ядро в сервис-функции с **типизированным результатом**, чтобы batch и одиночный роут шли одним путём и не разъезжались.

`src/services/sendActions.ts`:

```
type Send1cOutcome =
  | { kind: 'sent' }
  | { kind: 'needs_approval'; approvalId: number }        // сумма выше лимита (interactive)
  | { kind: 'skipped'; reason: 'not_processed' | 'already_approved' | 'over_threshold' };

type SberOutcome =
  | { kind: 'sent'; paymentNumber: string | null; externalId: string }
  | { kind: 'needs_confirmation'; prefilled: {...} }       // поставщик не верифицирован (interactive)
  | { kind: 'needs_approval'; approvalId: number }         // выше лимита (interactive)
  | { kind: 'conflict'; existingStatus: string; existingPaymentNumber: string | null }
  | { kind: 'invalid'; reason: 'no_total'|'no_inn'|'no_owner'|'not_connected'|'payer_incomplete' }
  | { kind: 'api_error'; message: string }
  | { kind: 'skipped'; reason: 'supplier_unverified' | 'over_threshold' };  // batch-режим

trySend1c(invoiceId, userId, mode): Promise<Send1cOutcome>
trySendSber(invoiceId, mode, overrides?): Promise<SberOutcome>
```

`mode: 'interactive' | 'batch'` управляет побочными эффектами:
- **interactive** (одиночный роут): выше лимита → создать approval-запрос, вернуть `needs_approval`; неверифицированный поставщик → вернуть `needs_confirmation` с prefill.
- **batch**: выше лимита → `skipped: over_threshold` (approval НЕ создаём); неверифицированный → `skipped: supplier_unverified` (без prefill, модалки в bulk нет).

Одиночные роуты `/:id/send` и `/:id/send-sber` переписываются как тонкие мапперы результата в текущие HTTP-ответы (200 / 409 needs_approval / 409 needs_supplier_confirmation / 409 conflict / 400 / 502). **Поведение одиночной отправки не меняется** — закреплено существующими тестами `tests/sber/*` + новыми.

## 4. Backend — batch-эндпоинты (шаблон `delete-batch`)

`POST /api/invoices/send-1c-batch` и `POST /api/invoices/send-sber-batch`, тело `{ ids: number[] }`:
1. Валидация: `ids` непустой массив ≤500, все — положительные целые; дедуп.
2. **Preflight owner-проверка** всей пачки (как `delete-batch:1200`): каждый id существует и `owner_user_id === req.user.id`, иначе `404` без частичного эффекта (не течём чужими id).
3. Поштучно `trySend1c(id, userId, 'batch')` / `trySendSber(id, 'batch')`, собираем результат.
4. Ответ: `{ data: { sent: number, skipped: Array<{ id, reason }>, total: number } }`.

Причины (`reason`) для отчёта:
- **1С:** `not_processed`, `already_approved`, `over_threshold`.
- **Сбер:** `no_inn`, `no_total`, `supplier_unverified`, `already_paid` (conflict), `over_threshold`, `sber_not_connected`, `payer_incomplete`, `api_error`.

Кнопка «→ 1С и Сбер» на фронте зовёт **оба** эндпоинта (последовательно) и объединяет отчёт.

## 5. Отчёт на фронте

После bulk-действия — сводка (нотификация + при наличии пропусков небольшая модалка со списком):
- «1С: N одобрено, M пропущено» / «Сбер: K отправлено, L пропущено».
- Пропуски сгруппированы по причине с человекочитаемыми подписями (например `supplier_unverified` → «поставщик не подтверждён — отправьте по одной», `over_threshold` → «выше лимита согласования», `already_paid` → «платёж уже создан»).
- После успеха — `loadTable()` (обновить статусы) и сброс выбора.

## 6. Тестирование

Правило 17 CLAUDE.md: тесты только на `127.0.0.1`, `DB_NAME` c `test`.

- `send-1c-batch`: микс — одна `processed` → sent; одна уже `approved_for_1c` → skipped(already_approved); одна `error` → skipped(not_processed); выше лимита → skipped(over_threshold), approval-запрос НЕ создан. Owner-изоляция: чужой id → 404.
- `send-sber-batch`: верифицированный поставщик под лимитом → sent (мок `createPaymentOrder`); неверифицированный → skipped(supplier_unverified); уже есть платёж → skipped(already_paid); нет ИНН → skipped(no_inn); Сбер не подключён → все skipped(sber_not_connected).
- Характеризация: одиночные `/:id/send` и `/:id/send-sber` после рефактора отдают те же ответы (существующие `tests/sber/*` зелёные + точечная проверка needs_confirmation / needs_approval / conflict).

## 7. Вне области

- Массовое согласование сумм выше лимита (остаётся по одной через approval-flow).
- Bulk-подтверждение реквизитов неверифицированных поставщиков через модалку (по одной).
- «Выбрать все на всех страницах» (выбор ограничен загруженными строками).
