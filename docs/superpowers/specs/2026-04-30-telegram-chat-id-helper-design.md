# Telegram Chat ID helper

**Дата:** 2026-04-30
**Автор:** Claude (брэйнсторм с Oleg)
**Статус:** Design — ждёт ревью пользователем
**Связан со спеком:** [`2026-04-30-telegram-notifications-design.md`](2026-04-30-telegram-notifications-design.md) — расширение страницы Профиль.

---

## Проблема

Сейчас, чтобы настроить Telegram-уведомления, юзер должен:
1. Создать бота через @BotFather → получить токен
2. Написать боту `/start`
3. Открыть в браузере `https://api.telegram.org/bot<TOKEN>/getUpdates`
4. Найти в JSON `"chat":{"id":...}`
5. Скопировать число и вставить в дашборд

Шаг (3-4) — технический. Открытие raw-URL с токеном в строке адреса, чтение JSON — не каждый сотрудник магазина это осилит. Юзер уже сообщил, что поэтому не может настроить уведомления.

Цель: убрать шаги 3-4. Юзер вводит токен, жмёт «Проверить» — получает Chat ID и подтверждение прямо в Telegram.

## Не-цели

- **Полный setup wizard.** Не делаем «Connect Telegram» в один клик с deep-link и т.п. Минимальный кусок: убрать копание в raw JSON.
- **Авто-сохранение Chat ID** в БД сразу после нахождения. Юзер сам жмёт «Сохранить». (Иначе после «Проверить» не очевидно: записалось — не записалось, надо ли что-то ещё нажимать.)
- **Поддержка групповых чатов / нескольких чатов** одновременно. Один личный чат, один Chat ID.
- **Long-polling / webhook от бота**, обработка команд. Бот по-прежнему «безмолвный» — только шлёт уведомления.

---

## UX

В карточке «Подключение» рядом с полем `Chat ID` появляется кнопка **«Найти»** (или «Проверить» — на твой выбор финального текста, см. ниже):

```
┌─ Подключение ────────────────────────────────────┐
│                                                  │
│  Chat ID                                         │
│  [ 123456789                ]   [ Найти ]        │
│  Числовой идентификатор...                       │
│                                                  │
│  Bot Token                                       │
│  [ ••••••••••••••• ]            [ 👁 ]           │
│  Хранится только на сервере...                   │
└──────────────────────────────────────────────────┘
```

### Поток

1. Юзер вводит **Bot Token** (если уже сохранён — поле уже заполнено placeholder'ом).
2. Юзер жмёт **«Найти»** возле Chat ID.
3. Frontend проверяет: токен есть в поле или сохранён на сервере? Если нет — показывает inline-ошибку «Сначала введите Bot Token и нажмите Сохранить».
4. Frontend вызывает `POST /api/profile/lookup-telegram-chat-id`.
5. Сервер берёт токен (из тела запроса, или из БД если в теле пусто), вызывает Telegram `getUpdates`, ищет последний update с `message.chat.id` от приватного чата.
6. Если **нашёл chat_id** → шлёт в этот чат подтверждающее сообщение → возвращает `{chat_id: "123..."}`.
7. Frontend подставляет chat_id в поле, показывает зелёный статус «Найдено: 123456789. Проверьте Telegram и нажмите Сохранить.»
8. Если **не нашёл** (пустой `getUpdates`) → возвращает 404 с сообщением «Сначала напишите боту /start в Telegram, потом нажмите Найти ещё раз».
9. Юзер видит ошибку, идёт в Telegram, пишет `/start` своему боту, возвращается, жмёт «Найти» снова.

### Как пользователь узнаёт username бота, чтобы написать /start?

Помимо ошибки «напишите /start» сервер при первом успехе или при ошибке возвращает также `bot_username` (через Telegram `getMe`). Frontend показывает кликабельную ссылку:

> ❌ Сначала напишите боту [@scanflow\_my\_bot](https://t.me/scanflow_my_bot) команду `/start` и нажмите «Найти» снова.

Клик по ссылке открывает Telegram с предзаполненным «Start» — самый прямой путь к написанию первого сообщения.

---

## Архитектура

### API: новый endpoint

`POST /api/profile/lookup-telegram-chat-id`

**Body:**
```json
{ "telegram_bot_token": "12345:ABC..." }
```
- Опциональное. Если пусто — берём токен из `users.telegram_bot_token` текущего юзера.
- Это позволяет юзеру **сначала Сохранить** токен (без chat_id), потом нажать «Найти» — и сервер использует уже сохранённый токен. Также позволяет нажать «Найти» прямо после ввода токена в поле, до сохранения.

**Responses:**

```json
// 200 OK — нашли
{ "data": { "chat_id": "123456789", "bot_username": "scanflow_my_bot", "confirmation_sent": true } }
```

```json
// 404 — getUpdates пустой
{ "error": "no_updates", "bot_username": "scanflow_my_bot",
  "message": "Напишите боту /start и попробуйте снова" }
```

```json
// 400 — токен не задан вообще
{ "error": "Telegram bot token is not set" }
```

```json
// 401 — Telegram отверг токен (через getMe)
{ "error": "Invalid bot token: Unauthorized" }
```

```json
// 500 — Telegram API упал
{ "error": "Telegram API failed: ..." }
```

### Telegram API calls

Сервер делает **два** последовательных вызова:
1. **`getMe`** — для получения `bot_username`. Используется для подсказки юзеру (ссылка на t.me) и для валидации токена. Дешевле и явнее, чем по `getUpdates` определять «токен валидный, но чат пуст».
2. **`getUpdates`** — для нахождения свежего chat.id. Берём последний (с наибольшим `update_id`), у которого есть `message.chat.id` И `message.chat.type === 'private'` (отбрасываем группы).

Оба вызова — через расширение существующего `telegramClient.ts`.

### Алгоритм выбора chat_id

```
updates = telegramClient.getUpdates(token)
private_chats = updates filter where message.chat.type === 'private'
if private_chats is empty:
  return { error: 'no_updates', bot_username }
chat_id = private_chats[last].message.chat.id  // самый свежий
telegramClient.sendMessage(token, chat_id, CONFIRMATION_MESSAGE_TEMPLATE)
return { chat_id, bot_username, confirmation_sent: true }
```

**Почему «последний приватный»?** В реальном single-user сетапе у бота будет ровно один приватный собеседник — сам админ. Если когда-нибудь добавятся другие — берём самый свежий update (юзер только что написал `/start`), и текст подтверждающего сообщения уйдёт ему лично.

### Confirmation message text

```
✅ Готово!

Ваш Chat ID: <code>123456789</code>

Скопируйте это число и вставьте в поле «Chat ID» в дашборде ScanFlow,
затем нажмите «Сохранить».

После этого вы будете получать уведомления о накладных прямо в этот чат.
```

(Plain text, без `parse_mode` — наша конвенция в `telegramClient`. Числа без обёртки `<code>` — пользователь его выделит и скопирует обычным выделением.)

Финальный текст без HTML:
```
✅ Готово!

Ваш Chat ID: 123456789

Скопируйте это число и вставьте в поле «Chat ID» в дашборде ScanFlow, затем нажмите «Сохранить».

После этого вы будете получать уведомления о накладных прямо в этот чат.
```

### Изменения в существующих файлах

#### `src/notifications/telegram/telegramClient.ts`
Добавить две функции:

```typescript
export async function getMe(token: string): Promise<{ id: number; username: string }>;
export async function getUpdates(token: string): Promise<TelegramUpdate[]>;
```

`TelegramUpdate` — узкий type под наши нужды:
```typescript
interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel' };
  };
}
```

Обработка ошибок: `getMe` 401 «Unauthorized» — это «токен невалидный», бросаем `Error` с явным текстом «Invalid bot token». Прочие — generic.

#### `src/api/routes/profile.ts`
Новый роут `POST /api/profile/lookup-telegram-chat-id`:

```typescript
router.post('/lookup-telegram-chat-id', async (req, res) => {
  if (!req.user) return 401;
  const tokenFromBody = req.body?.telegram_bot_token;
  if (tokenFromBody !== undefined && tokenFromBody !== null) {
    if (typeof tokenFromBody !== 'string' || !BOT_TOKEN_RX.test(tokenFromBody)) {
      return 400 "Invalid token shape";
    }
  }
  const tg = userRepo.getTelegramConfig(req.user.id);
  const token = tokenFromBody || tg?.bot_token;
  if (!token) return 400 "Telegram bot token is not set";

  // Step 1: getMe
  let botUsername: string;
  try {
    const me = await getMe(token);
    botUsername = me.username;
  } catch (err) {
    if (err.message includes 'Unauthorized') return 401 "Invalid bot token";
    return 500 "Telegram API failed: ...";
  }

  // Step 2: getUpdates
  let updates;
  try {
    updates = await getUpdates(token);
  } catch (err) { return 500 "Telegram API failed: ..."; }

  const privateChats = updates
    .filter(u => u.message?.chat?.type === 'private')
    .map(u => ({ chat_id: String(u.message.chat.id), update_id: u.update_id }))
    .sort((a, b) => b.update_id - a.update_id);

  if (privateChats.length === 0) {
    return 404 { error: 'no_updates', bot_username: botUsername,
                 message: 'Напишите боту /start и попробуйте снова' };
  }

  const chatId = privateChats[0].chat_id;

  // Step 3: confirmation
  try {
    await sendMessage(token, chatId, CONFIRMATION_TEXT.replace('{chatId}', chatId));
  } catch {
    // Ok if confirmation fails — user already has the ID returned in the response.
    // Just log; don't fail the whole call.
    logger.warn('lookup: confirmation send failed', { chatId, botUsername });
  }

  return 200 { chat_id: chatId, bot_username: botUsername, confirmation_sent: true };
});
```

#### `public/app.html`
В карточке «Подключение» поле `Chat ID` оборачиваем в `.input-with-action` (новый класс рядом с `.token-row`), добавляем кнопку:

```html
<div class="form-group">
  <label for="profile-tg-chat">Chat ID</label>
  <div class="input-with-action">
    <input type="text" id="profile-tg-chat" inputmode="numeric" placeholder="123456789">
    <button type="button" id="profile-tg-lookup" class="btn btn-outline btn-sm">
      Найти
    </button>
  </div>
  <div class="field-hint">
    Числовой идентификатор вашего личного чата с ботом.
    <span id="profile-tg-lookup-hint"></span>
  </div>
</div>
```

`#profile-tg-lookup-hint` — место для динамической подсказки (успех / ошибка / ссылка на бота).

#### `public/js/profile.js`
Добавить метод `Profile.lookupChatId()`:

```javascript
async lookupChatId() {
  const hint = document.getElementById('profile-tg-lookup-hint');
  const btn = document.getElementById('profile-tg-lookup');
  const tokenInput = document.getElementById('profile-tg-token').value;
  const tokenChanged = tokenInput && tokenInput !== TOKEN_PLACEHOLDER;

  hint.textContent = ''; hint.style.color = '';
  btn.disabled = true;
  btn.textContent = 'Ищем…';

  try {
    const body = tokenChanged ? { telegram_bot_token: tokenInput } : {};
    const r = await App.apiJson('/profile/lookup-telegram-chat-id', { method: 'POST', body });
    document.getElementById('profile-tg-chat').value = r.data.chat_id;
    hint.textContent = ` Найдено: ${r.data.chat_id}. Проверьте Telegram и нажмите «Сохранить».`;
    hint.style.color = 'var(--success)';
  } catch (err) {
    if (err.body?.error === 'no_updates' && err.body.bot_username) {
      hint.innerHTML = ' Напишите боту <a href="https://t.me/' + err.body.bot_username +
        '" target="_blank" rel="noopener noreferrer">@' + err.body.bot_username + '</a> ' +
        'команду <code>/start</code> и нажмите «Найти» снова.';
      hint.style.color = 'var(--error)';
    } else {
      hint.textContent = ' ' + (err.message || 'Ошибка');
      hint.style.color = 'var(--error)';
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Найти';
  }
},
```

Привязать к кнопке в `init()`.

#### `public/css/style.css`
Добавить минимум:
```css
.input-with-action {
  display: flex;
  gap: 8px;
  align-items: stretch;
}
.input-with-action input { flex: 1; }
.input-with-action .btn-sm { padding: 0 14px; white-space: nowrap; }
```

---

## Тесты

Новые:
- `tests/notifications/telegram/telegramClient.test.ts` — расширить:
  - `getMe` returns username on success
  - `getMe` throws «Invalid bot token» on 401
  - `getUpdates` returns parsed updates array
  - `getUpdates` returns empty array when Telegram returns empty `result`

- `tests/api/profile.test.ts` — новый describe-блок `POST /api/profile/lookup-telegram-chat-id`:
  - 400 если ни в теле, ни в БД нет токена
  - 400 если токен в теле — мусор (не подходит regex)
  - 401 если getMe бросает «Unauthorized»
  - 404 + bot_username если getUpdates пустой
  - 200 + chat_id из последнего private update + sendMessage вызван
  - 200 даже если sendMessage упал (мы уже нашли chat_id)
  - 200 игнорирует update'ы из групповых чатов
  - 200 берёт самый свежий по `update_id`

---

## Риски

1. **getUpdates с активным webhook.** Если у бота настроен webhook (Telegram пушит updates на URL), `getUpdates` всегда возвращает пусто. Наш бот никогда webhook не использует (мы только пушим), так что риск умозрительный. Если юзер вручную сделал webhook на стороне — мы покажем «no_updates», что direct mismatch с реальностью. Митигация: в ошибке «no_updates» добавить уточнение «(если вы настраивали webhook у бота, удалите его командой deleteWebhook)». Но это редкость, добавим только если кто-то реально нарвётся.

2. **Длинная история updates.** Telegram хранит updates 24 часа. Если юзер написал `/start` 25 часов назад и не делает новых — getUpdates пуст. Покажем «no_updates» — правильное действие в этом случае всё равно `/start` снова.

3. **Несколько разных пользователей у одного бота.** Юзер А создал бота, юзер Б тоже написал ему `/start`. Кто из них последний — тот и попадёт в результат. Для single-user setup нашего проекта — несущественно (бот частный, его username знает только owner).

4. **Rate limit Telegram.** `getMe` + `getUpdates` + `sendMessage` = 3 вызова на одну кнопку. Telegram bot API позволяет 30 msg/sec. Не задеваем.

5. **Конкурентность.** Два юзера дашборда жмут «Найти» одновременно. Каждый делает свой запрос со своим токеном (или общим из БД admin'а). Телеграм отдаст один и тот же chat_id обоим. Никакой race condition в БД нет — мы только читаем токен и не пишем chat_id (юзер сам потом «Сохранить»).

6. **Что если телеграм отдаёт `bot_username` как `null` (теоретически)?** Маловероятно, но фронт должен gracefully — если `bot_username` отсутствует в ответе, не строить ссылку, а показать просто текст «Напишите боту /start».

---

## Что появится в коде

**Изменяется:**
- `src/notifications/telegram/telegramClient.ts` — добавить `getMe`, `getUpdates` + типы
- `src/api/routes/profile.ts` — добавить `POST /lookup-telegram-chat-id`
- `tests/notifications/telegram/telegramClient.test.ts` — тесты getMe/getUpdates
- `tests/api/profile.test.ts` — describe-блок lookup
- `public/app.html` — обернуть Chat ID в `.input-with-action`, кнопка «Найти», span под полем для подсказки
- `public/js/profile.js` — `lookupChatId()` метод, привязка к кнопке
- `public/css/style.css` — `.input-with-action` (минимум)
- `CLAUDE.md` — однострочное обновление в разделе Telegram про новый endpoint

**Не меняется:**
- БД: ничего нового
- Существующие notify-flow и emit() — никак

---

## Открытые вопросы

Нет.
