# Оповещение о накладных без счёта в Сбер >14 дней

> Дата: 2026-07-08
> Статус: одобрено к реализации.

## Задача

Если у платёжеспособной накладной более 14 дней нет выставленного счёта в Сбербанк
(нет платёжного черновика), нужно:
- один раз отправить оповещение на email и в Telegram;
- выделять такую накладную в списке UI.

## Решения (согласовано)

- **Скоуп:** только платёжеспособные накладные (`supplier_inn` не пуст, `total_sum > 0`,
  `duplicate_of IS NULL`, `status <> 'error'`).
- **Якорь отсчёта:** `created_at` (момент загрузки фото).
- **Каденция:** один раз при пересечении порога (отметка `sber_overdue_notified_at`).
- **Failed-платёж:** строка `sber_payments` со `status = 'failed'` НЕ считается выставленным
  счётом — накладная остаётся просроченной.
- **Порог:** 14 дней, константа `SBER_OVERDUE_DAYS` (env-переопределяемая).

## Единый предикат «просрочена по Сберу»

Централизуется как SQL-фрагмент (одна строка-константа в `invoiceRepo`), чтобы cron и
список считали одинаково. Накладная просрочена, когда ВСЁ верно:

```
supplier_inn IS NOT NULL AND supplier_inn <> ''
AND total_sum > 0
AND duplicate_of IS NULL
AND status <> 'error'
AND created_at < (NOW() - INTERVAL <SBER_OVERDUE_DAYS> DAY)
AND NOT EXISTS (
  SELECT 1 FROM sber_payments sp
  WHERE sp.invoice_id = invoices.id AND sp.status <> 'failed'
)
```

`SBER_OVERDUE_DAYS` подставляется как clamped-целое (как остальные INTERVAL в репозитории).

## Компоненты

### 1. Миграция v44 (`src/database/migrations.ts`)
Идемпотентная, guard на каждый шаг:
1. `ALTER TABLE invoices ADD COLUMN sber_overdue_notified_at DATETIME NULL` (guard `hasColumn`).
2. Бэкфилл `users.notify_events`: добавить `sber_payment_overdue` каждому пользователю, у кого
   его ещё нет (иначе новое событие у существующих юзеров выключено). Делать через выборку строк
   и обновление JSON в TypeScript (или `JSON_ARRAY_APPEND` при JSON-типе; в проекте `notify_events`
   — TEXT со JSON-массивом, поэтому читаем/пишем в коде).

### 2. Репозиторий (`src/database/repositories/invoiceRepo.ts`)
- Экспортируемая константа/функция `sberOverdueWhere(days)` — возвращает SQL-фрагмент предиката.
- `listNewlyOverdueForSber(): Promise<Invoice[]>` — предикат И `sber_overdue_notified_at IS NULL`.
- `markSberOverdueNotified(id): Promise<void>` — `UPDATE ... SET sber_overdue_notified_at = NOW()`.
- `getAll(...)` и `getById`/`getWithItems` — добавить в SELECT производный булев `sber_overdue`
  (тот же предикат как выражение `(<predicate>) AS sber_overdue`). Тип `Invoice` получает
  `sber_overdue?: 0 | 1`.

### 3. Cron (`src/index.ts`)
Новый ежедневный крон `0 9 * * *` (09:00 сервер-tz):
```
for (const inv of await invoiceRepo.listNewlyOverdueForSber()) {
  await emit('sber_payment_overdue', { invoice_id, invoice_number, supplier, total_sum,
                                       created_at, days_overdue }, null);
  await invoiceRepo.markSberOverdueNotified(inv.id);
}
```
Обёрнуто в try/catch с логированием (emit сам не бросает; markSberOverdueNotified — защитить).

### 4. Проводка события
- `src/notifications/types.ts`: `sber_payment_overdue` в `EventType`, `ALL_EVENT_TYPES`,
  `URGENT_EVENT_TYPES` (шлём немедленно, не в дайджест).
- `src/notifications/templates.ts`: `EVENT_LABELS` (TS обяжет), кейс в `renderRealtime`
  и группировка в `renderDigest`. Текст realtime:
  «⏰ Счёт в Сбербанк не выставлен 14+ дней\nНакладная № {num} от {date}\nПоставщик: {supplier}\nСумма: {total} ₽» + ссылка на `/#/invoice/{id}`.

### 5. Список UI
- `public/js/invoices.js`: строки с `sber_overdue` получают янтарный акцент (класс на `<tr>`/карточку)
  и дополнительный бейдж «Сбер: счёт не выставлен 14д+». Это отдельный бейдж, существующий
  `statusBadge` не меняется. Значение `sber_overdue` приходит с сервера в объекте накладной.
- Бейдж/акцент — только флаг с бэкенда; никакого пересчёта дат на клиенте.

### 6. Тесты (реализовано)
DB-интеграционный тест `tests/database/sberOverdue.test.ts` (против `scanflow_test`) —
проверяет РЕАЛЬНЫЙ SQL-предикат, а не его копию на JS (без риска расхождения логики):
13 дней → нет, 14+ → да; отсутствие `supplier_inn`/нулевая сумма/duplicate/error → нет;
наличие non-failed платежа (created/pending) → нет; только failed платёж → да;
`markSberOverdueNotified` убирает из alert-выборки, но флаг подсветки остаётся.

## Крайние случаи
- Уведомлённая накладная получает платёж → предикат ложен → подсветка снимается; отметка
  остаётся, повторно не шлём.
- Платёж по ней потом падает/удаляется → снова подсвечивается, но повторного уведомления нет
  (каденция «один раз»). Сброс `sber_overdue_notified_at` при создании платежа — опционально, не делаем.
- Подсветка не зависит от `sber_overdue_notified_at` — появляется сразу по предикату.
- Событие можно отключить в профиле (существующий механизм `notify_events`).

## Что НЕ входит (YAGNI)
- Настраиваемый порог через UI (только env/константа).
- Агрегированный дайджест «N накладных просрочено» одним сообщением (шлём по одной; каденция
  «один раз» + постепенное пересечение порога держат объём разумным).
- Сброс отметки при создании платежа.
