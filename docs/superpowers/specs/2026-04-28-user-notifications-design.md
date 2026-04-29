# Уведомления пользователю на email

**Дата:** 2026-04-28
**Автор:** Claude (брэйнсторм с Oleg)
**Статус:** Design — ждёт ревью пользователем

---

## Проблема

Сейчас сервис шлёт письма только на критические системные события (`uncaughtException`, диск, фатальный старт) — на единственный адрес `MAIL_TO` из `.env`, через `src/utils/mailer.ts`. Доменных событий (загрузилось фото, распозналась накладная, упало распознавание, накладную утвердили в 1С) в почте нет вообще, и без этого пользователю трудно «контролировать» работу системы — приходится регулярно открывать дашборд.

Цель: сделать так, чтобы аккаунт-владелец получал на свою почту уведомления о ключевых доменных событиях, с возможностью выбрать режим (реалтайм / почасовой дайджест / ежедневный дайджест) и набор включённых событий.

## Не-цели (явно вне scope)

- **Multi-tenancy / роли.** В системе сейчас один пользователь (`admin`). Разделения «администратор vs сотрудник» в этой фиче нет, BCC-копий нет, ролей нет.
- **UI управления пользователями.** Создание/удаление юзеров остаётся через ts-node-скрипт, как сейчас.
- **Per-user аутентификация загрузки.** Мобильная камера и `/api/upload` продолжают работать с единственным admin-ключом. Идею «Загрузил: Ваня» отложили.
- **Email-шаблонизация (handlebars и пр.).** Достаточно inline-HTML по образцу `sendErrorEmail`.
- **Системные письма (`uncaughtException`, диск-монитор).** Не трогаем — продолжают слаться напрямую на `MAIL_TO` из `.env`, не зависят от состояния БД.
- **Уведомления через что-либо кроме email.** Никаких Telegram/SMS/push.

---

## События

7 типов. Каждое в письме показывает: тип события, ID накладной, поставщик, сумма, ссылка на дашборд.

| ID события | Когда триггерится | Срочность |
|---|---|---|
| `photo_uploaded` | Файл попал в `data/inbox/` (через watcher или upload-route), invoice-row создан | дайджест |
| `invoice_recognized` | OCR/Claude отработали, у накладной `status='processed'`, есть `items` | дайджест |
| `recognition_error` | Watcher словил исключение / накладная ушла в `status='error'` | **срочно** |
| `suspicious_total` | После парсинга `items_total_mismatch=1` (сумма строк ≠ total_sum) | **срочно** |
| `invoice_edited` | `PATCH /api/invoices/:id` или `PATCH /api/invoices/:id/items/:item_id` | дайджест |
| `approved_for_1c` | `POST /api/invoices/:id/approve` (ставит `approved_for_1c=1`) | дайджест |
| `sent_to_1c` | `invoiceRepo.markSent()` (либо webhook OK, либо 1C-обработка позвала `/confirm`) | дайджест |

«Срочно» — игнорирует режим, шлётся всегда мгновенно. Остальные подчиняются режиму юзера.

## Режимы (`notify_mode`)

- `realtime` — каждое событие → отдельное письмо мгновенно
- `digest_hourly` (**default**) — срочные сразу; остальные собираются и в начале каждого часа с 09:00 до 19:00 (Europe/Moscow) шлются одним письмом-таблицей. Если за час событий не было — письмо не идёт.
- `digest_daily` — срочные сразу; остальные раз в день в 19:00, одним письмом

## Конфигурация на стороне юзера

В таблице `users` появляются три колонки:

| Колонка | Тип | Дефолт | Назначение |
|---|---|---|---|
| `email` | TEXT | NULL | Куда слать. Пока NULL — никакие пользовательские уведомления не идут. |
| `notify_mode` | TEXT | `'digest_hourly'` | Один из `realtime` / `digest_hourly` / `digest_daily`. |
| `notify_events` | TEXT | (см. ниже) | JSON-массив включённых event-ID, например `["photo_uploaded","recognition_error",...]`. |

`notify_events` дефолт — все 7 событий включены: `["photo_uploaded","invoice_recognized","recognition_error","suspicious_total","invoice_edited","approved_for_1c","sent_to_1c"]`.

При миграции для существующих юзеров: `email` = значение `MAIL_TO` из `.env` (если задано и валидный email), `notify_mode` = `digest_hourly`, `notify_events` = все 7. Если `MAIL_TO` пуст — `email` остаётся NULL и юзер до первого захода в «Профиль» писем не получает.

## Архитектура

### Новый модуль `src/notifications/`

Три файла:

#### `events.ts` — точка входа для эмиссии
```ts
export type EventType =
  | 'photo_uploaded' | 'invoice_recognized' | 'recognition_error'
  | 'suspicious_total' | 'invoice_edited' | 'approved_for_1c' | 'sent_to_1c';

export interface EventPayload {
  invoice_id: number;
  invoice_number?: string | null;
  supplier?: string | null;
  total_sum?: number | null;
  // тип-специфичные поля (например error_message для recognition_error)
  [k: string]: unknown;
}

export async function emit(
  eventType: EventType,
  payload: EventPayload,
  triggeredByUserId: number | null,
): Promise<void>;
```

Алгоритм:
1. Если `triggeredByUserId` null (фоновое событие без HTTP-контекста, например watcher) → берём `users.id` единственного владельца. Для текущего single-user сетапа это `SELECT id FROM users ORDER BY id LIMIT 1`. (При появлении multi-user в будущем эту резолюцию надо будет переделать, но это отдельная задача — см. Не-цели.)
2. Читаем `users` row: если `email` пустой — return.
3. Парсим `notify_events`: если `eventType` не в списке — return.
4. Решаем срочность: `recognition_error` и `suspicious_total` — всегда срочно.
5. Если срочно ИЛИ `notify_mode === 'realtime'` — рендерим HTML и шлём через `mailer.sendNotification(email, subject, html)`. Иначе — `INSERT INTO notification_events`.

#### `digestWorker.ts` — фоновая отправка дайджестов
Запускается из `src/index.ts` через `setInterval`. Раз в минуту проверяет: подошло ли время отправить хоть кому-то дайджест.

Логика «время отправить»:
- `digest_hourly` — текущая минута == 0, текущий час между 9 и 18 включительно (т.е. 9:00, 10:00, …, 18:00, всего 10 раз в день), Europe/Moscow.
- `digest_daily` — текущее время == 19:00 Europe/Moscow.

Для каждого юзера в нужном режиме:
1. `SELECT * FROM notification_events WHERE user_id = ? AND sent_at IS NULL ORDER BY created_at`.
2. Если пусто — пропускаем юзера.
3. Группируем по `event_type`, рендерим HTML-таблицу «За период X событий: 3 загружено, 2 распознано, …».
4. Шлём через `mailer.sendNotification(email, 'Дайджест ScanFlow', html)`.
5. `UPDATE notification_events SET sent_at = datetime('now') WHERE id IN (...)`.

#### `templates.ts` — рендер HTML писем
Чистые функции: `renderRealtime(eventType, payload)` → `{subject, html}`, `renderDigest(events)` → `{subject, html}`. Inline-CSS, без внешних зависимостей. Образец стиля — текущая `sendErrorEmail`.

### Расширение `src/utils/mailer.ts`

Добавляется новая функция:
```ts
export async function sendNotification(
  to: string, subject: string, html: string,
): Promise<void>;
```

Отличия от `sendErrorEmail`:
- Принимает явный `to` (а не глобальный `MAIL_TO`).
- Без rate-limit (regулирование на уровне `notify_mode`).
- Тот же transporter, теми же SMTP-настройками из `.env`.

`sendErrorEmail` остаётся как есть и продолжает шлёт на `MAIL_TO` для системных событий.

### Точки эмиссии в существующем коде

| Файл | Где | Эмиссия |
|---|---|---|
| `src/watcher/fileWatcher.ts` | после `invoiceRepo.create()` | `emit('photo_uploaded', ...)` |
| `src/watcher/fileWatcher.ts` | после успешного `markProcessed` с `items.length > 0` | `emit('invoice_recognized', ...)` |
| `src/watcher/fileWatcher.ts` | catch-блок (status переходит в `error`) | `emit('recognition_error', ...)` |
| `src/watcher/fileWatcher.ts` | если после расчёта `items_total_mismatch === 1` | `emit('suspicious_total', ...)` |
| `src/api/routes/invoices.ts` | в PATCH-роутах правки полей и строк | `emit('invoice_edited', ...)` |
| `src/api/routes/invoices.ts` | в POST `/approve` | `emit('approved_for_1c', ...)` |
| `src/integration/webhook.ts` | после успешного `markSent` | `emit('sent_to_1c', ...)` |
| `src/api/routes/invoices.ts` | в POST `/confirm` (от 1С-обработки) | `emit('sent_to_1c', ...)` |

`triggeredByUserId` берётся из `req.user?.id` где есть HTTP-контекст; для watcher — null (берётся owner из БД).

### Новая таблица БД (миграция 18)

```sql
CREATE TABLE notification_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  event_type  TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at     TEXT
);
CREATE INDEX idx_notif_pending ON notification_events(user_id, sent_at);
```

`payload_json` — сериализованный `EventPayload`. Хранится для рендера дайджеста; чистится отдельным регламентом раз в неделю (записи с `sent_at < now - 7 days`).

### Миграция 18 — изменения в `users`

```sql
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN notify_mode TEXT NOT NULL DEFAULT 'digest_hourly';
ALTER TABLE users ADD COLUMN notify_events TEXT NOT NULL DEFAULT '["photo_uploaded","invoice_recognized","recognition_error","suspicious_total","invoice_edited","approved_for_1c","sent_to_1c"]';
```

Затем одноразовый UPDATE в той же миграции: для всех юзеров с `email IS NULL` подставить `MAIL_TO` из env, если он задан и проходит регекс `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`. Поля `notify_mode` и `notify_events` уже получают свои дефолты автоматически через DEFAULT-clause — UPDATE для них не нужен.

### UI: страница «Профиль»

Новый файл `public/profile.html` + js. В навигации дашборда — пункт «Профиль» (рядом с «Настройки»).

Поля:
- **Email для уведомлений** — text input, валидация на клиенте + сервере
- **Режим уведомлений** — radio из 3 вариантов с пояснениями:
  - `Реалтайм — каждое событие отдельным письмом`
  - `Дайджест каждый час (рекомендуется)` ← дефолт
  - `Дайджест раз в день в 19:00`
- **Включённые события** — 7 чекбоксов, рядом краткое пояснение каждого

Кнопка «Сохранить» — `PATCH /api/profile`. Кнопка «Отправить тестовое письмо» — `POST /api/profile/test-email` (важно для проверки SMTP без реальных накладных).

### API

| Метод | Путь | Что делает |
|---|---|---|
| `GET` | `/api/profile` | Возвращает текущие email/notify_mode/notify_events для `req.user`. |
| `PATCH` | `/api/profile` | Обновляет одно или несколько полей. Валидирует email (regex), notify_mode (enum из 3), notify_events (массив из набора 7 строк). |
| `POST` | `/api/profile/test-email` | Шлёт на текущий `users.email` фейковое письмо «Это тест ScanFlow». Возвращает {ok, error?}. |

Все защищены тем же `X-API-Key` middleware.

## Текущие данные → новый формат

Накладные, существующие до выкатки фичи, — без изменений. Они не получат «обратных» уведомлений. Поток уведомлений начинается с момента деплоя: новые загрузки → `photo_uploaded`, дальше пайплайн как обычно.

## Тесты

Новый каталог `tests/notifications/`. Покрытие:

- `events.test.ts` — `emit()` с разными комбинациями режимов и событий: срочное всегда сразу, обычное в realtime сразу, обычное в digest идёт в таблицу. Юзер с пустым email — return без сайд-эффектов. Событие выключено в `notify_events` — то же.
- `digestWorker.test.ts` — собирает группу событий за час, рендерит, шлёт, помечает sent_at. Если событий нет — не шлёт. Двух юзеров с разными режимами обрабатывает раздельно. Часовое окно 9–19 уважает.
- `templates.test.ts` — снэпшот HTML для каждого `EventType` и для дайджеста с 3+ событиями.
- `routes.profile.test.ts` — GET/PATCH/test-email, валидация плохого email и плохого режима.
- Расширить существующие тесты `fileWatcher` и `invoices` route — мокать `notifications.emit` и проверять, что вызывается с правильным типом и payload.

Mailer мокается через `vi.mock('../../src/utils/mailer')` (vitest-моки модулей — паттерн уже используется в `tests/`). Реальный SMTP в тестах не дёргается. DI через параметры функции **не используется** — оставляем простые статические импорты, чтобы не плодить boilerplate.

## Риски

1. **Если SMTP в `.env` не задан** — `sendNotification` молча не отправляет (как сейчас `sendErrorEmail`), но юзер увидит в UI «Сохранено». Нужно: «Тест-письмо» button даёт явный результат, а в UI рядом с email — индикатор «SMTP не настроен на сервере» (берётся из `GET /api/profile`, отдельный флаг `smtp_configured`).

2. **Часовой пояс.** «9:00–19:00» — Europe/Moscow. Сервер в проде на UTC; нужно явно `dayjs.tz` или подобное. В `package.json` уже есть `date-fns` (если нет — `Intl.DateTimeFormat` нативно). Уточнить при реализации.

3. **Гонка дайджест-воркера и эмиссии.** Если воркер начал отправку, а в этот момент пришло новое событие — оно может попасть в окно дайджеста и не отправиться. Решение: воркер делает SELECT с фиксированным верхним `created_at` (==now на момент старта), затем UPDATE по тем же id. События после now попадут в следующий дайджест.

4. **Объём.** При 50 накладных/день и 5 событиях на накладную в `notification_events` накапливается ~250 строк/день. Это не проблема для SQLite, но без чистки за год накопится 90k. Решение: chистка `sent_at < now - 7 days` раз в сутки в том же воркере.

5. **Ошибки SMTP во время массовой отправки.** Если SMTP упал, дайджест не отправится — события в таблице останутся `sent_at IS NULL`. На следующем тике воркер попробует снова. Это нормальное поведение, но письма могут опоздать. В случае > 3 неудач подряд для одного юзера — прекращаем попытки и пишем warning в Winston (чтобы не зацикливаться).

## Что появится в коде после реализации

Новые файлы:
- `src/notifications/events.ts`
- `src/notifications/digestWorker.ts`
- `src/notifications/templates.ts`
- `src/api/routes/profile.ts`
- `public/profile.html` + js
- `tests/notifications/*.test.ts`
- `tests/api/profile.test.ts`

Изменённые файлы:
- `src/database/migrations.ts` — миграция 18
- `src/database/repositories/userRepo.ts` — методы `getEmail/getNotifyConfig/setNotifyConfig`
- `src/utils/mailer.ts` — `sendNotification`
- `src/index.ts` — старт `digestWorker`
- `src/watcher/fileWatcher.ts` — точки эмиссии
- `src/api/routes/invoices.ts` — точки эмиссии в PATCH/approve/confirm
- `src/integration/webhook.ts` — точка эмиссии в markSent
- `public/index.html` — пункт меню «Профиль»
- `.env.example` — комментарий про SMTP_*, что они теперь нужны не только для системных писем
- `CLAUDE.md` — раздел «Уведомления»

---

## Открытые вопросы (на момент записи)

1. **Точное место «Профиля» в UI:** новая страница в навбаре или вкладка внутри `settings.html`? — решать на этапе плана (мелочь).
2. **Локализация писем:** русский. (Согласовано — текст в спеке уже на русском.)
3. **Subject писем:** короткий шаблон `[ScanFlow] <тип>` — как у `sendErrorEmail`. Достаточно для inbox-фильтрации.
