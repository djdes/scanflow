# Telegram-уведомления (вместо email)

**Дата:** 2026-04-30
**Автор:** Claude (брэйнсторм с Oleg)
**Статус:** Design — ждёт ревью пользователем
**Связан со спеком:** [`2026-04-28-user-notifications-design.md`](2026-04-28-user-notifications-design.md) — на котором эта фича строится.

---

## Проблема

Email-канал уведомлений (предыдущая фича) у пользователя не сработал — Gmail требует 2FA и App Password, что для одного-юзерного админа избыточно. Yandex/Mail.ru имеют похожие preconditions. SMTP-конфиг — это лишнее звено для человека, который и так весь день в Telegram.

Цель: **заменить email на Telegram** как единственный канал доставки уведомлений. Email-инфраструктура остаётся в коде (на будущее), но в UI и в коде эмиссии используется только Telegram.

## Не-цели (явно вне scope)

- **Удаление email-кода.** `mailer.ts`, `templates.ts` (HTML-шаблоны), таблица `notification_events`, `digestWorker.ts` — всё остаётся в репо как dead code на случай возврата. Только **в UI** скрываем email-настройки, и точки эмиссии больше не зовут email-тракт.
- **Дайджест-режимы.** Telegram — это пуш-канал. Каждое событие — отдельное сообщение или редактирование thread'а накладной. Никаких `digest_hourly`/`digest_daily`. Поле `notify_mode` в БД остаётся (для возможного email-режима в будущем), но для Telegram игнорируется.
- **Групповые чаты, рассылка нескольким юзерам.** Один пользователь = один `chat_id` в БД.
- **Двусторонний бот.** Бот не реагирует на команды от пользователя (никаких `/start`, `/list_invoices`). Он только отправляет и редактирует сообщения. Это просто notification sink, не интерфейс.
- **Inline-кнопки на сообщениях** («Утвердить из Telegram»). Только текст. Управление — через дашборд.
- **Multi-bot или поддержка разных провайдеров** (Telegram + Slack + Discord). Только Telegram.

---

## Архитектура

### Концепция «thread на накладную»

Каждой накладной соответствует **одно** сообщение в Telegram-чате, которое **редактируется** по мере прогресса. Telegram API позволяет редактировать сообщение бесконечно долго **в чатах с пользователями (private chats)** — у них нет 48-часового лимита (этот лимит существует только для групп/каналов). Поскольку у нас private chat — лимит нас не касается.

Структура сообщения:
```
📄 Накладная № НФНФ-000085
Поставщик: Свит лайф фудсервис
Сумма: 66 714,11 ₽

✅ Загружена 11:13
✅ Распознана 11:14
✅ Утверждена 11:18
⏳ Отправлена в 1С
```

При каждом эвенте:
- Если у накладной нет `telegram_message_id` → шлём `sendMessage` → сохраняем `message_id` в БД.
- Если есть → обновляем строку статуса и шлём `editMessageText`.
- Если `editMessageText` упал (404 message not found, например юзер удалил) → шлём как новое `sendMessage`, обновляем `message_id`.

### Срочные события (отдельные сообщения)

`recognition_error` и `suspicious_total` — НЕ редактируют thread накладной. Они шлются **отдельным новым сообщением** с акцентом, чтобы push-нотификация Telegram сработала и не утонула в обновлении длинного thread'а:

```
🚨 Ошибка распознавания
Накладная №85, Свит лайф фудсервис
Claude API timeout
```

После того как такое сообщение отправлено, оно живёт само по себе, не редактируется.

### Многостраничные накладные

Когда `fileWatcher` мерджит вторую страницу в существующую накладную (через `findRecentByNumber`) — `telegram_message_id` уже есть на первой странице, эмит `photo_uploaded` НЕ должен создавать новое сообщение. Логика: «если у `invoice.id` есть `telegram_message_id`, любое событие от этой накладной — `editMessageText`». То есть для второй страницы прогресс просто доехал до соответствующего шага, никаких отдельных сообщений.

---

## Изменения в БД

### Миграция 19

```sql
ALTER TABLE users ADD COLUMN telegram_chat_id TEXT;
ALTER TABLE users ADD COLUMN telegram_bot_token TEXT;

ALTER TABLE invoices ADD COLUMN telegram_message_id INTEGER;
```

- `users.telegram_chat_id` — куда слать (целое число от Telegram, но храним как TEXT для гибкости).
- `users.telegram_bot_token` — токен бота. Хранится в БД, не в `.env`, потому что (а) каждый юзер может иметь свой бот в будущем, (б) мы хотим менять его через UI без переразвёртывания.
- `invoices.telegram_message_id` — Telegram message_id отправленного thread-сообщения для этой накладной. NULL = ещё не отправлено.

`users.email`, `users.notify_mode`, `users.notify_events` — остаются как есть. Но в эмиссии для нового Telegram-канала используется только `notify_events` (фильтрует, на какие события юзер хочет реакцию). Поля `email`/`notify_mode` для Telegram-канала игнорируются.

---

## Архитектура кода

### Новый модуль `src/notifications/telegram/`

Три файла:

#### `telegramClient.ts`
Низкоуровневая обёртка над Telegram Bot API через `fetch`:
```typescript
export async function sendMessage(token: string, chatId: string, text: string): Promise<number /* message_id */>;
export async function editMessageText(token: string, chatId: string, messageId: number, text: string): Promise<void>;
```

Без `node-telegram-bot-api` или `grammy` — у нас только `sendMessage` и `editMessageText`, что-то добавить — три строки. Тащить в зависимости полноценный SDK ради двух методов — overkill.

Обработка ошибок:
- `editMessageText` → 400 «message not found» / 400 «message can't be edited» → возвращаем `MessageGoneError`, caller делает fallback на `sendMessage`.
- Любая другая ошибка → throw, caller логирует, эмит проваливается тихо (как и сейчас email).

#### `telegramFormatter.ts`
Чистые функции форматирования:
```typescript
export function buildInvoiceThread(invoice: Invoice, completedEvents: EventState): string;
export function buildUrgentMessage(eventType: 'recognition_error' | 'suspicious_total', payload: EventPayload): string;
```

`EventState` — структура `{ photo_uploaded: Date | null, invoice_recognized: Date | null, approved_for_1c: Date | null, sent_to_1c: Date | null }` — какие шаги пройдены и когда.

Отдельные тесты: snapshot HTML-render — но Telegram использует не HTML, а свой Markdown или plain text. Используем **plain text** (без `parse_mode`) — проще, не парим Telegram-парсер с экранированием спецсимволов в названиях поставщиков.

#### `telegramNotifier.ts`
Высокоуровневый эмиттер. Заменяет вызов `mailer.sendNotification` в существующем `events.ts`:

```typescript
export async function sendInvoiceNotification(
  userTelegram: { token: string; chat_id: string },
  invoice: Invoice,
  eventType: EventType,
  payload: EventPayload,
): Promise<void>;
```

Логика:
1. Если `eventType` — срочный → строим urgent-message → `sendMessage` → готово.
2. Иначе → загрузить `EventState` для накладной (по `invoice_id` подсчитать, какие эвенты уже состоялись из таблицы `notification_events`, либо по полям самой накладной — см. ниже).
3. Построить полный текст thread'а через `buildInvoiceThread`.
4. Если `invoice.telegram_message_id` есть → `editMessageText`. Если упал с `MessageGoneError` → `sendMessage`, обновляем `telegram_message_id` в БД.
5. Если нет → `sendMessage`, сохраняем `message_id`.

#### Где брать `EventState`?

Два варианта:

**A) По полям самой накладной** — `photo_uploaded` ⇔ `invoice` существует с момента `created_at`; `invoice_recognized` ⇔ `status='processed'`; `approved_for_1c` ⇔ `approved_for_1c=1` с `approved_at`; `sent_to_1c` ⇔ `sent_at != null`. Никакие новые таблицы не нужны.

**B) По таблице эмиссий** — отдельная таблица `invoice_event_log`, где для каждого `(invoice_id, event_type)` хранится timestamp. Точнее, но дублирует данные.

Берём **A**: данные уже есть в самой `invoices`, дополнительная таблица не нужна.

### Расширение `events.ts`

В существующем `emit()` сейчас:
```typescript
if (sendNow) {
  if (!smtpConfigured()) return;
  const { subject, html } = renderRealtime(eventType, payload);
  await sendNotification(cfg.email, subject, html);
}
```

Меняем на:
```typescript
if (sendNow) {
  if (!cfg.telegram_chat_id || !cfg.telegram_bot_token) return;
  const invoice = invoiceRepo.getById(payload.invoice_id);
  if (!invoice) return;
  await sendInvoiceNotification(
    { token: cfg.telegram_bot_token, chat_id: cfg.telegram_chat_id },
    invoice,
    eventType,
    payload,
  );
}
```

Логика ветвления `realtime` vs `digest` уходит — все события в Telegram идут в realtime. (Условие `sendNow` всегда true для Telegram-канала. Можно вообще убрать `URGENT_EVENT_TYPES` распайку, но оставим — она нужна для разделения «срочное → отдельное сообщение» vs «обычное → редактирование thread'а» в самом `telegramNotifier`.)

`notify_mode` в БД сохраняется, но для Telegram-канала игнорируется. `notify_events` (массив включённых event-types) **продолжает** работать — пользователь может выключить отдельные эвенты.

### `userRepo`

Добавить методы:
```typescript
getTelegramConfig(id: number): { chat_id: string | null; bot_token: string | null } | null;
setTelegramConfig(id: number, cfg: Partial<{chat_id: string | null; bot_token: string | null}>): void;
```

Расширить `User` interface новыми полями.

### `invoiceRepo`

Добавить методы:
```typescript
getTelegramMessageId(id: number): number | null;
setTelegramMessageId(id: number, messageId: number): void;
```

### Расширение API `/api/profile`

Существующий `GET /api/profile` сейчас возвращает `{email, notify_mode, notify_events, smtp_configured}`. Расширяем до:

```typescript
{
  email: ... ,            // оставляем — в коде используется (для будущего)
  notify_mode: ... ,
  notify_events: [...] ,
  smtp_configured: ... ,
  telegram_chat_id: string | null,
  telegram_bot_token_set: boolean,  // НЕ возвращаем сам токен — только флаг "задан"
}
```

`PATCH /api/profile` — принимает `telegram_chat_id` и `telegram_bot_token` (последний — write-only, при PATCH с null сбрасывает, при PATCH с строкой — устанавливает).

`POST /api/profile/test-telegram` — новый эндпоинт. Шлёт фейковое сообщение «Это тест ScanFlow» в `chat_id` через `bot_token` и возвращает `{ok: true}` либо ошибку (400 если конфиг не полный, 500 если Telegram API отверг — там же причина).

### UI «Профиль»

В существующем `view-profile` секции `app.html`:

- **Скрываем** (через `display:none` или удалением DOM) email-input, режим уведомлений (3 радио), плашку «SMTP не настроен», кнопку «Отправить тестовое письмо».
- **Добавляем** новую группу полей:
  - Поле `Telegram chat ID` (text input)
  - Поле `Bot Token` (password input — `<input type="password">` + кнопка «Показать/Скрыть»)
  - Под ними — небольшой блок инструкций «Как получить эти значения:»:
    1. Создать бота через @BotFather: написать `/newbot`, получить токен.
    2. Отправить боту любое сообщение «привет».
    3. Открыть `https://api.telegram.org/bot<TOKEN>/getUpdates` в браузере → найти `chat.id`.
    4. Вставить значения сюда.
  - Кнопка «Отправить тестовое сообщение»
  - Чекбоксы 7 эвентов (как раньше)
- **Сохраняем** — кнопка «Сохранить» делает `PATCH /api/profile` с `{telegram_chat_id, telegram_bot_token, notify_events}`.

---

## Точки эмиссии

Существующие 8 точек (4 в watcher, 3 в routes/invoices, 1 в webhook) — НЕ меняются. Внутри `events.ts.emit()` логика подмены — теперь идёт в Telegram, не в email.

---

## Тесты

Новые:
- `tests/notifications/telegram/telegramClient.test.ts` — мокаем `fetch`, проверяем что `sendMessage` шлёт правильный body, что `editMessageText` распознаёт `MessageGoneError`.
- `tests/notifications/telegram/telegramFormatter.test.ts` — `buildInvoiceThread` для разных комбинаций состояний; `buildUrgentMessage` для error/suspicious. Snapshot тесты на текст.
- `tests/notifications/telegram/telegramNotifier.test.ts` — мокаем client + invoiceRepo, проверяем сценарии: первое сообщение → `sendMessage` + setMessageId; обновление → `editMessageText`; `MessageGoneError` → fallback на `sendMessage` с обновлением message_id; срочное → отдельный `sendMessage`, message_id не трогаем.
- Расширить `tests/notifications/events.test.ts` — мок Telegram-канала, тестируем что `emit()` теперь идёт через Telegram (не email).
- Расширить `tests/api/profile.test.ts` — `PATCH /api/profile` с telegram-полями, `POST /api/profile/test-telegram`.

---

## Безопасность

`bot_token` — это **полный** доступ к боту. Если кто-то получит токен, может слать от имени бота кому угодно (включая в наш чат). Поэтому:

- `bot_token` хранится в БД в открытом виде (как `api_key` сейчас). Шифровать не будем — БД уже защищена тем, что лежит на сервере, а API-ключи рядом — той же ценности.
- В API `GET /api/profile` возвращается только `telegram_bot_token_set: true/false`, **не сам токен**. Один раз ввёл — больше не показываем (как пароли в большинстве сервисов).
- В UI поле — `<input type="password">`, при загрузке профиля заполнено dummy-значением (если токен задан в БД), и пользователь редактирует только если хочет заменить.

`chat_id` — публично-неудобный, но не секретный (зная его, никто не может тебе писать как бот, нужен ещё токен). Возвращаем как есть.

`POST /api/profile/test-telegram` — защищён `apiKeyAuth` middleware, как и остальные routes под `/api/*`.

---

## Риски

1. **Telegram API rate limit** — 30 сообщений/секунду в один чат. У нас не больше 50 накладных в день × 5 эвентов на накладную (4 редактирования + срочные) = ~250 операций в день, ~1 операция в 6 минут. Лимит даже близко не задеваем.

2. **`editMessageText` упал по причине, отличной от `MessageGoneError`** (например, network timeout) — это будет throw в `telegramNotifier`, перехватим в outer try/catch `events.emit()`, событие проваливается тихо. Накладная в Telegram остаётся в старом состоянии. Не критично — следующий эвент (или ручной retry через дашборд) обновит.

3. **Пользователь сменил бота / chat_id, а в БД остались `telegram_message_id` от старого** — все `editMessageText` будут возвращать `MessageGoneError`, fallback пойдёт на `sendMessage`, в результате каждый эвент = новое сообщение в новом чате, пока у каждой накладной не обновится `telegram_message_id`. Это не баг, это естественное поведение в нечастом сценарии.

4. **БД `bot_token` утёк** (через резервную копию, доступ по SSH) — атакующий может слать сообщения от имени бота в твой чат и редактировать наши уведомления. Не катастрофа, но неприятно. Для митигации: при подозрении на утечку — пересоздать бота в @BotFather.

5. **Юзер пытался настроить, ввёл неверный токен** — `POST /test-telegram` вернёт 500 с текстом ошибки от Telegram («Unauthorized: bot token incorrect»), пользователь увидит, поправит. Не блокирующий риск.

---

## Что появится в коде

**Новые файлы:**
- `src/notifications/telegram/telegramClient.ts`
- `src/notifications/telegram/telegramFormatter.ts`
- `src/notifications/telegram/telegramNotifier.ts`
- `tests/notifications/telegram/*.test.ts` (×3)

**Изменённые:**
- `src/database/migrations.ts` — миграция 19
- `src/database/repositories/userRepo.ts` — getTelegramConfig/setTelegramConfig
- `src/database/repositories/invoiceRepo.ts` — getTelegramMessageId/setTelegramMessageId, поле в Invoice interface
- `src/notifications/events.ts` — заменить email-вызов на Telegram
- `src/api/routes/profile.ts` — расширить GET/PATCH, добавить /test-telegram
- `tests/api/profile.test.ts`, `tests/notifications/events.test.ts` — обновить
- `public/app.html` — переделать секцию `view-profile`
- `public/js/profile.js` — обновить логику (telegram-поля вместо email)
- `CLAUDE.md` — обновить раздел «Уведомления»
- `.env.example` — комментарий «SMTP не нужен — используется Telegram»

**Что НЕ удаляем:**
- `src/utils/mailer.ts` — `sendNotification` и `smtpConfigured` остаются
- `src/notifications/templates.ts` — HTML email-шаблоны остаются
- `src/notifications/digestWorker.ts` — cron-job остаётся (но никогда не сработает с пустой очередью)
- `src/database/repositories/notificationRepo.ts` — остаётся
- Таблица `notification_events` — остаётся

Всё это — dead code, который активируется тривиально, если когда-нибудь понадобится email обратно (просто переключить ветку в `events.ts`).

---

## Открытые вопросы

Нет.
