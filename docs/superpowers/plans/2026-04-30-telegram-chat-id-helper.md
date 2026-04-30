# Telegram Chat ID Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать пользователю кнопку «Найти» рядом с полем Chat ID на странице Профиль, которая через Telegram Bot API находит chat_id (после того как юзер написал боту /start) и шлёт ему в Telegram подтверждающее сообщение с этим chat_id.

**Architecture:** Расширяем существующий `telegramClient.ts` двумя методами (`getMe`, `getUpdates`). Добавляем серверный endpoint `POST /api/profile/lookup-telegram-chat-id` в `profile.ts`, который оркестрирует три вызова Bot API: getMe → getUpdates → sendMessage. UI: рядом с полем Chat ID в `app.html` — кнопка «Найти», логика в `profile.js`. Никаких изменений в БД.

**Tech Stack:** Node 25 + TypeScript, Express 5, native fetch, vitest. Существующие `telegramClient.ts`, `profile.ts`, `app.html`, `profile.js`.

**Spec:** [`docs/superpowers/specs/2026-04-30-telegram-chat-id-helper-design.md`](../specs/2026-04-30-telegram-chat-id-helper-design.md)

---

## File Structure

**Изменяются:**
- `src/notifications/telegram/telegramClient.ts` — добавить `getMe`, `getUpdates`, тип `TelegramUpdate`
- `tests/notifications/telegram/telegramClient.test.ts` — тесты getMe/getUpdates
- `src/api/routes/profile.ts` — новый endpoint `POST /lookup-telegram-chat-id`
- `tests/api/profile.test.ts` — describe-блок для нового endpoint
- `public/app.html` — обернуть Chat ID в `.input-with-action`, добавить кнопку «Найти», span под полем для подсказки
- `public/js/profile.js` — метод `lookupChatId()`, привязка к кнопке
- `public/css/style.css` — `.input-with-action` (минимум)
- `CLAUDE.md` — однострочное упоминание нового endpoint в разделе Telegram

Каждый файл < 250 строк, одна ответственность.

---

## Task 0: Setup — закоммитить спек, спрятать чужие правки, создать worktree

**Files:**
- Add: `docs/superpowers/specs/2026-04-30-telegram-chat-id-helper-design.md` (уже создан)

- [ ] **Step 1: Закоммитить спек на main**

```bash
cd C:/www/ScanFlow
git add docs/superpowers/specs/2026-04-30-telegram-chat-id-helper-design.md
git commit -m "docs(spec): Telegram Chat ID lookup helper"
```

- [ ] **Step 2: Спрятать чужие незакоммиченные правки в stash**

В git status есть 6 файлов с правками от прошлых сессий (`config.ts`, `index.ts`, `fileWatcher.ts`, `.env.example`, `claudeApiAnalyzer.ts`, `test-pipeline.ts`). Не относятся к этой фиче.

```bash
git stash push -m "WIP: pre-existing changes (chat-id helper start)" -- src/config.ts src/index.ts src/watcher/fileWatcher.ts .env.example src/ocr/claudeApiAnalyzer.ts src/scripts/test-pipeline.ts
git status --short
```

Expected: только untracked PNG/SQLite-WAL и т.п. Modified должно быть пусто.

- [ ] **Step 3: Создать worktree для feature-ветки**

```bash
git worktree add .worktrees/chat-id-helper -b feature/telegram-chat-id-helper
cd .worktrees/chat-id-helper
npm install
```

- [ ] **Step 4: Verify baseline — все 153 теста проходят**

```bash
npx vitest run
```

Expected: `Test Files 11 passed (11) | Tests 153 passed (153)`. Если упало — расследовать.

- [ ] **Step 5: Закоммитить план на main, потянуть в worktree**

План (этот файл) уже создан в main и закоммичен заранее или сейчас:

```bash
# в main:
cd C:/www/ScanFlow
git add docs/superpowers/plans/2026-04-30-telegram-chat-id-helper.md
git commit -m "docs(plan): Telegram Chat ID lookup helper" || echo "no plan diff"

# в worktree чтобы подтянуть:
cd .worktrees/chat-id-helper
git pull origin main --no-edit 2>&1 | tail -3 || echo "no remote pull needed"
```

(План будет виден через локальный git history main'а — worktree shares the same .git.)

---

## Task 1: getMe + getUpdates в telegramClient

**Files:**
- Modify: `src/notifications/telegram/telegramClient.ts`

- [ ] **Step 1: Добавить тип TelegramUpdate и две функции в конец файла**

Открыть `src/notifications/telegram/telegramClient.ts`. **После** существующего `editMessageText` (последняя экспортируемая функция) добавить:

```typescript
// Узкий type под наши нужды — Telegram Update имеет много полей,
// но для поиска chat_id нам нужно только это.
export interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: {
      id: number;
      type: 'private' | 'group' | 'supergroup' | 'channel';
    };
  };
}

interface GetMeResult {
  id: number;
  username: string;
  is_bot: boolean;
}

// Returns the bot's identity. Used to validate the token (401 = bad token)
// and surface the bot's @username to the UI so we can deep-link to t.me.
export async function getMe(token: string): Promise<{ id: number; username: string }> {
  const result = await callTelegram<GetMeResult>(token, 'getMe', {});
  logger.debug('Telegram getMe ok', { username: result.username });
  return { id: result.id, username: result.username };
}

// Returns recent updates for the bot. Telegram retains them for 24 hours
// and only as long as no webhook is configured. Empty array is normal —
// the user simply hasn't written anything to the bot yet.
export async function getUpdates(token: string): Promise<TelegramUpdate[]> {
  const result = await callTelegram<TelegramUpdate[]>(token, 'getUpdates', {});
  logger.debug('Telegram getUpdates ok', { count: result.length });
  return result;
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/notifications/telegram/telegramClient.ts
git commit -m "feat(telegram): add getMe + getUpdates client methods"
```

---

## Task 2: Тесты для getMe и getUpdates

**Files:**
- Modify: `tests/notifications/telegram/telegramClient.test.ts`

- [ ] **Step 1: Добавить два describe-блока в конец файла**

Открыть `tests/notifications/telegram/telegramClient.test.ts`. Найти последнюю закрывающую `});` корневого `describe('telegramClient', ...)`. **Перед** ней добавить два новых describe:

```typescript
  describe('getMe', () => {
    it('returns id and username on success', async () => {
      mockFetchResponse({ ok: true, result: { id: 12345, username: 'scanflow_bot', is_bot: true } });
      const me = await getMe(TOKEN);
      expect(me).toEqual({ id: 12345, username: 'scanflow_bot' });
    });

    it('throws "Unauthorized" on 401 (bad token)', async () => {
      mockFetchResponse({ ok: false, error_code: 401, description: 'Unauthorized' });
      await expect(getMe(TOKEN)).rejects.toThrow(/401 Unauthorized/);
    });
  });

  describe('getUpdates', () => {
    it('returns empty array when bot has no updates', async () => {
      mockFetchResponse({ ok: true, result: [] });
      const updates = await getUpdates(TOKEN);
      expect(updates).toEqual([]);
    });

    it('returns parsed updates with chat info', async () => {
      mockFetchResponse({
        ok: true,
        result: [
          { update_id: 1, message: { chat: { id: 111, type: 'private' } } },
          { update_id: 2, message: { chat: { id: -200, type: 'group' } } },
        ],
      });
      const updates = await getUpdates(TOKEN);
      expect(updates).toHaveLength(2);
      expect(updates[0].message?.chat.id).toBe(111);
      expect(updates[1].message?.chat.type).toBe('group');
    });

    it('throws on Telegram API error', async () => {
      mockFetchResponse({ ok: false, error_code: 401, description: 'Unauthorized' });
      await expect(getUpdates(TOKEN)).rejects.toThrow(/401 Unauthorized/);
    });
  });
```

Также в начале файла нужно подвезти эти функции в импорт. Найти существующую строку:

```typescript
import { sendMessage, editMessageText, MessageGoneError } from '../../../src/notifications/telegram/telegramClient';
```

И заменить на:

```typescript
import { sendMessage, editMessageText, MessageGoneError, getMe, getUpdates } from '../../../src/notifications/telegram/telegramClient';
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run tests/notifications/telegram/telegramClient.test.ts
```

Expected: 11 tests passing (7 старых + 4 новых).

- [ ] **Step 3: Commit**

```bash
git add tests/notifications/telegram/telegramClient.test.ts
git commit -m "test(telegram): coverage for getMe + getUpdates"
```

---

## Task 3: API endpoint /api/profile/lookup-telegram-chat-id

**Files:**
- Modify: `src/api/routes/profile.ts`

- [ ] **Step 1: Добавить импорт getMe + getUpdates**

В `src/api/routes/profile.ts` найти существующий импорт:

```typescript
import { sendMessage } from '../../notifications/telegram/telegramClient';
```

Заменить на:

```typescript
import { sendMessage, getMe, getUpdates } from '../../notifications/telegram/telegramClient';
```

- [ ] **Step 2: Добавить endpoint перед `export default router;`**

Найти строку `export default router;` в конце файла. **Перед** ней добавить:

```typescript
// Confirmation message sent to the chat after we successfully find chat_id.
// Plain text — no parse_mode (matches telegramClient convention).
const CHAT_ID_CONFIRMATION_TEMPLATE =
  '✅ Готово!\n\n' +
  'Ваш Chat ID: {chatId}\n\n' +
  'Скопируйте это число и вставьте в поле «Chat ID» в дашборде ScanFlow, ' +
  'затем нажмите «Сохранить».\n\n' +
  'После этого вы будете получать уведомления о накладных прямо в этот чат.';

// POST /api/profile/lookup-telegram-chat-id
//
// Helper for users who don't want to dig through raw getUpdates JSON. The
// flow is:
//   1. User types Bot Token (or has it saved in DB).
//   2. User opens their bot in Telegram and writes /start (sends any message).
//   3. User clicks "Найти" in the dashboard.
//   4. We call getMe to validate token + get bot's @username.
//   5. We call getUpdates and pick the most recent private chat.
//   6. We send the confirmation message containing the chat_id to that chat.
//   7. Frontend receives chat_id and pre-fills the Chat ID input.
//
// The user still has to click "Сохранить" — we don't auto-persist. That keeps
// the click-Save habit consistent with the rest of the form.
router.post('/lookup-telegram-chat-id', async (req: Request, res: Response) => {
  if (!req.user) { res.status(401).json({ error: 'Not authenticated' }); return; }

  // Token may come from request body (user just typed it but hasn't saved yet)
  // or from DB (already saved). Body takes precedence.
  const tokenFromBody = req.body?.telegram_bot_token;
  if (tokenFromBody !== undefined && tokenFromBody !== null) {
    if (typeof tokenFromBody !== 'string' || !BOT_TOKEN_RX.test(tokenFromBody)) {
      res.status(400).json({ error: 'telegram_bot_token must match bot id:secret format' });
      return;
    }
  }
  const tg = userRepo.getTelegramConfig(req.user.id);
  const token = (tokenFromBody as string | undefined) || tg?.bot_token || null;
  if (!token) {
    res.status(400).json({ error: 'Telegram bot token is not set' });
    return;
  }

  // Step 1: getMe validates the token and gives us the bot's @username
  // (we use it for the t.me deep-link in error responses).
  let botUsername: string;
  try {
    const me = await getMe(token);
    botUsername = me.username;
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('401') && msg.includes('Unauthorized')) {
      res.status(401).json({ error: 'Invalid bot token: Unauthorized' });
      return;
    }
    logger.warn('lookup: getMe failed', { error: msg });
    res.status(500).json({ error: `Telegram API failed: ${msg}` });
    return;
  }

  // Step 2: getUpdates and find the most recent private chat
  let updates;
  try {
    updates = await getUpdates(token);
  } catch (err) {
    const msg = (err as Error).message;
    logger.warn('lookup: getUpdates failed', { error: msg });
    res.status(500).json({ error: `Telegram API failed: ${msg}` });
    return;
  }

  const privateChats = updates
    .filter(u => u.message?.chat?.type === 'private' && u.message.chat.id != null)
    .map(u => ({ chat_id: String(u.message!.chat.id), update_id: u.update_id }))
    .sort((a, b) => b.update_id - a.update_id);

  if (privateChats.length === 0) {
    res.status(404).json({
      error: 'no_updates',
      bot_username: botUsername,
      message: 'Напишите боту /start и попробуйте снова',
    });
    return;
  }

  const chatId = privateChats[0].chat_id;

  // Step 3: send the confirmation message. If this fails, the user still
  // has the chat_id in our response — don't fail the whole call.
  let confirmationSent = false;
  try {
    await sendMessage(
      token,
      chatId,
      CHAT_ID_CONFIRMATION_TEMPLATE.replace('{chatId}', chatId),
    );
    confirmationSent = true;
  } catch (err) {
    logger.warn('lookup: confirmation send failed', {
      chatId,
      botUsername,
      error: (err as Error).message,
    });
  }

  res.json({
    data: {
      chat_id: chatId,
      bot_username: botUsername,
      confirmation_sent: confirmationSent,
    },
  });
});
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/api/routes/profile.ts
git commit -m "feat(api): POST /api/profile/lookup-telegram-chat-id helper"
```

---

## Task 4: Тесты для lookup endpoint

**Files:**
- Modify: `tests/api/profile.test.ts`

- [ ] **Step 1: Расширить мок telegramClient**

В `tests/api/profile.test.ts` найти `vi.mock('../../src/notifications/telegram/telegramClient', ...)`. Сейчас он мокает только `sendMessage`, `editMessageText`, `MessageGoneError`. Добавить туда `getMe` и `getUpdates`:

```typescript
vi.mock('../../src/notifications/telegram/telegramClient', () => ({
  sendMessage: vi.fn(async () => 999),
  editMessageText: vi.fn(async () => {}),
  MessageGoneError: class MessageGoneError extends Error {},
  getMe: vi.fn(async () => ({ id: 1, username: 'test_bot' })),
  getUpdates: vi.fn(async () => []),
}));
```

И в импорте файла поднять их рядом с `sendMessage`:

```typescript
import { sendMessage, getMe, getUpdates } from '../../src/notifications/telegram/telegramClient';
```

- [ ] **Step 2: Добавить describe-блок в конец файла**

Найти конец файла (последний `});`). **Перед** ним (т.е. на верхнем уровне) добавить:

```typescript
describe('POST /api/profile/lookup-telegram-chat-id', () => {
  beforeEach(() => {
    memTgChat = null;
    memTgToken = VALID_TOKEN;
    vi.clearAllMocks();
    (getMe as any).mockResolvedValue({ id: 1, username: 'test_bot' });
    (getUpdates as any).mockResolvedValue([]);
    (sendMessage as any).mockResolvedValue(999);
  });

  it('returns 400 if no token is set anywhere', async () => {
    memTgToken = null;
    const res = await request(makeApp()).post('/api/profile/lookup-telegram-chat-id').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not set');
  });

  it('returns 400 if body token has wrong shape', async () => {
    const res = await request(makeApp()).post('/api/profile/lookup-telegram-chat-id').send({
      telegram_bot_token: 'garbage',
    });
    expect(res.status).toBe(400);
  });

  it('returns 401 if Telegram says token is invalid', async () => {
    (getMe as any).mockRejectedValueOnce(new Error('Telegram API getMe failed: 401 Unauthorized'));
    const res = await request(makeApp()).post('/api/profile/lookup-telegram-chat-id').send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toContain('Invalid bot token');
  });

  it('returns 404 with bot_username when no updates exist', async () => {
    (getUpdates as any).mockResolvedValueOnce([]);
    const res = await request(makeApp()).post('/api/profile/lookup-telegram-chat-id').send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('no_updates');
    expect(res.body.bot_username).toBe('test_bot');
  });

  it('returns chat_id from the most recent private update', async () => {
    (getUpdates as any).mockResolvedValueOnce([
      { update_id: 1, message: { chat: { id: 100, type: 'private' } } },
      { update_id: 5, message: { chat: { id: 500, type: 'private' } } },
      { update_id: 3, message: { chat: { id: 300, type: 'private' } } },
    ]);
    const res = await request(makeApp()).post('/api/profile/lookup-telegram-chat-id').send({});
    expect(res.status).toBe(200);
    expect(res.body.data.chat_id).toBe('500');
    expect(res.body.data.bot_username).toBe('test_bot');
    expect(res.body.data.confirmation_sent).toBe(true);
    expect(sendMessage).toHaveBeenCalledOnce();
    const sendArgs = (sendMessage as any).mock.calls[0];
    expect(sendArgs[1]).toBe('500');
    expect(sendArgs[2]).toContain('Ваш Chat ID: 500');
  });

  it('skips group/supergroup/channel updates, returns private only', async () => {
    (getUpdates as any).mockResolvedValueOnce([
      { update_id: 1, message: { chat: { id: -100, type: 'group' } } },
      { update_id: 2, message: { chat: { id: -200, type: 'supergroup' } } },
      { update_id: 3, message: { chat: { id: 777, type: 'private' } } },
    ]);
    const res = await request(makeApp()).post('/api/profile/lookup-telegram-chat-id').send({});
    expect(res.status).toBe(200);
    expect(res.body.data.chat_id).toBe('777');
  });

  it('skips updates without message field', async () => {
    (getUpdates as any).mockResolvedValueOnce([
      { update_id: 1 },
      { update_id: 2, message: { chat: { id: 42, type: 'private' } } },
    ]);
    const res = await request(makeApp()).post('/api/profile/lookup-telegram-chat-id').send({});
    expect(res.status).toBe(200);
    expect(res.body.data.chat_id).toBe('42');
  });

  it('returns 200 with confirmation_sent=false if sendMessage fails', async () => {
    (getUpdates as any).mockResolvedValueOnce([
      { update_id: 1, message: { chat: { id: 555, type: 'private' } } },
    ]);
    (sendMessage as any).mockRejectedValueOnce(new Error('Telegram down'));
    const res = await request(makeApp()).post('/api/profile/lookup-telegram-chat-id').send({});
    expect(res.status).toBe(200);
    expect(res.body.data.chat_id).toBe('555');
    expect(res.body.data.confirmation_sent).toBe(false);
  });

  it('uses token from body when provided (overrides DB)', async () => {
    memTgToken = VALID_TOKEN; // DB has one
    const otherToken = '99999:OtherTokenXyzAbcdefghijklmnopqrstuv';
    (getUpdates as any).mockResolvedValueOnce([
      { update_id: 1, message: { chat: { id: 88, type: 'private' } } },
    ]);
    const res = await request(makeApp()).post('/api/profile/lookup-telegram-chat-id').send({
      telegram_bot_token: otherToken,
    });
    expect(res.status).toBe(200);
    // Verify the token actually passed through is the body one
    expect((getMe as any).mock.calls[0][0]).toBe(otherToken);
  });
});
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run tests/api/profile.test.ts
```

Expected: existing 12 tests pass + 9 new tests = **21 passing**.

- [ ] **Step 4: Commit**

```bash
git add tests/api/profile.test.ts
git commit -m "test(api): /api/profile/lookup-telegram-chat-id — token resolution, private-chat filter, confirmation"
```

---

## Task 5: UI — кнопка «Найти» рядом с Chat ID

**Files:**
- Modify: `public/app.html`
- Modify: `public/css/style.css`

- [ ] **Step 1: Найти Chat ID form-group в app.html**

```bash
grep -n "profile-tg-chat" public/app.html | head -5
```

Найти строки с `<input type="text" id="profile-tg-chat"` — это поле Chat ID внутри `<div class="form-group">`.

- [ ] **Step 2: Заменить form-group для Chat ID**

В `public/app.html` найти блок:

```html
            <div class="form-group">
              <label for="profile-tg-chat">Chat ID</label>
              <input type="text" id="profile-tg-chat" inputmode="numeric" placeholder="123456789" autocomplete="off">
              <div class="field-hint">Числовой идентификатор вашего личного чата с ботом.</div>
            </div>
```

Заменить на:

```html
            <div class="form-group">
              <label for="profile-tg-chat">Chat ID</label>
              <div class="input-with-action">
                <input type="text" id="profile-tg-chat" inputmode="numeric" placeholder="123456789" autocomplete="off">
                <button type="button" id="profile-tg-lookup" class="btn btn-outline btn-sm">Найти</button>
              </div>
              <div class="field-hint">
                Числовой идентификатор вашего личного чата с ботом.
                <span id="profile-tg-lookup-hint"></span>
              </div>
            </div>
```

- [ ] **Step 3: Добавить .input-with-action в style.css**

В `public/css/style.css` найти существующий блок `.token-row` (он уже есть для поля Bot Token). **После** него (после закрывающей `}`) добавить:

```css
/* Input with an action button on the right (e.g. Chat ID + "Найти") */
.input-with-action {
  display: flex;
  gap: 8px;
  align-items: stretch;
}

.input-with-action input { flex: 1; }

.input-with-action .btn-sm {
  padding: 0 14px;
  white-space: nowrap;
}

#profile-tg-lookup-hint {
  display: inline;
  margin-left: 4px;
}

#profile-tg-lookup-hint a {
  color: var(--primary);
  text-decoration: none;
  font-weight: 500;
}

#profile-tg-lookup-hint a:hover {
  text-decoration: underline;
}

#profile-tg-lookup-hint code {
  font-family: var(--mono);
  font-size: 12px;
  padding: 1px 5px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
}
```

- [ ] **Step 4: Visual smoke (optional)**

Если есть запущенный dev-сервер: открыть `http://localhost:8899/app.html#/profile`. Должно появиться поле Chat ID c кнопкой «Найти» справа. Кликом ничего не происходит — JS пока не привязан.

- [ ] **Step 5: Commit**

```bash
git add public/app.html public/css/style.css
git commit -m "feat(ui): add 'Найти' button next to Chat ID field"
```

---

## Task 6: JS — привязка кнопки Найти

**Files:**
- Modify: `public/js/profile.js`

- [ ] **Step 1: Добавить метод lookupChatId**

В `public/js/profile.js` найти конец объекта `Profile` (там где `init()` определён). **После** метода `toggleTokenVisibility()` (но до `init()`) добавить:

```javascript
    async lookupChatId() {
      const hint = document.getElementById('profile-tg-lookup-hint');
      const btn = document.getElementById('profile-tg-lookup');
      const tokenInputEl = document.getElementById('profile-tg-token');
      const tokenInput = tokenInputEl.value;
      const tokenChanged = tokenInput && tokenInput !== TOKEN_PLACEHOLDER;

      hint.innerHTML = '';
      hint.style.color = '';
      btn.disabled = true;
      btn.textContent = 'Ищем…';

      try {
        const body = tokenChanged ? { telegram_bot_token: tokenInput } : {};
        const r = await App.apiJson('/profile/lookup-telegram-chat-id', { method: 'POST', body });
        document.getElementById('profile-tg-chat').value = r.data.chat_id;
        const sentNote = r.data.confirmation_sent
          ? ' Проверьте Telegram и нажмите «Сохранить».'
          : ' Не удалось отправить подтверждение в Telegram, но Chat ID найден.';
        hint.textContent = ` Найдено: ${r.data.chat_id}.${sentNote}`;
        hint.style.color = 'var(--success)';
      } catch (err) {
        if (err.body && err.body.error === 'no_updates' && err.body.bot_username) {
          const u = err.body.bot_username;
          hint.innerHTML = ' Напишите боту <a href="https://t.me/' + u +
            '" target="_blank" rel="noopener noreferrer">@' + u + '</a> ' +
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

- [ ] **Step 2: Привязать в init()**

Найти блок:

```javascript
    init() {
      if (this._wired) {
        this.load();
        return;
      }
      this._wired = true;
      document.getElementById('profile-save').addEventListener('click', () => this.save());
      document.getElementById('profile-test').addEventListener('click', () => this.test());
      document
        .getElementById('profile-tg-token-toggle')
        .addEventListener('click', () => this.toggleTokenVisibility());
      this.load();
    },
```

Добавить **перед** строкой `this.load();` (последней) ещё одну привязку:

```javascript
      document
        .getElementById('profile-tg-lookup')
        .addEventListener('click', () => this.lookupChatId());
```

Финальный блок:

```javascript
    init() {
      if (this._wired) {
        this.load();
        return;
      }
      this._wired = true;
      document.getElementById('profile-save').addEventListener('click', () => this.save());
      document.getElementById('profile-test').addEventListener('click', () => this.test());
      document
        .getElementById('profile-tg-token-toggle')
        .addEventListener('click', () => this.toggleTokenVisibility());
      document
        .getElementById('profile-tg-lookup')
        .addEventListener('click', () => this.lookupChatId());
      this.load();
    },
```

- [ ] **Step 3: Smoke test (vitest baseline must still pass)**

```bash
npx vitest run
```

Expected: все тесты PASS, включая новые backend (Task 4) и existing (Task 2). Frontend (profile.js) не покрыт unit-тестами — это ок, ручная проверка в браузере на следующем шаге.

- [ ] **Step 4: Visual smoke в браузере (optional but recommended)**

Если хочется — запустить `npm run dev`, зайти на http://localhost:8899/app.html#/profile, нажать «Найти»:
- Если токен не задан → должна появиться красная подсказка «Сначала введите Bot Token...» (через ошибку 400 от API).
- Если токен задан, но getUpdates пуст → красная подсказка с кликабельной ссылкой на бота.

Это опционально — основной тест прошёл на уровне API.

- [ ] **Step 5: Commit**

```bash
git add public/js/profile.js
git commit -m "feat(ui): wire 'Найти' button — lookup chat_id, surface bot username on no_updates"
```

---

## Task 7: Документация

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Добавить упоминание endpoint в раздел «Уведомления пользователю в Telegram»**

В `CLAUDE.md` найти раздел `## Уведомления пользователю в Telegram`. В подсекции **Файлы** найти строку:

```markdown
- [`src/api/routes/profile.ts`](src/api/routes/profile.ts) — `GET/PATCH /api/profile`, `POST /api/profile/test-telegram`
```

Заменить на:

```markdown
- [`src/api/routes/profile.ts`](src/api/routes/profile.ts) — `GET/PATCH /api/profile`, `POST /api/profile/test-telegram`, `POST /api/profile/lookup-telegram-chat-id`
```

Также после блока **Безопасность** (последняя подсекция перед `---`) добавить новую подсекцию:

```markdown
### Helper: автоматический поиск Chat ID

`POST /api/profile/lookup-telegram-chat-id` — для пользователей, которые не хотят копаться в JSON `getUpdates` руками. Принимает (опционально) `telegram_bot_token` в теле — иначе берёт из БД. Делает `getMe` (валидация токена + получение @username бота), `getUpdates` (поиск свежего приватного чата), `sendMessage` с подтверждением. Возвращает `{chat_id, bot_username, confirmation_sent}` либо 404 `{error: 'no_updates', bot_username}` если юзер ещё не написал боту /start.

UI: рядом с полем Chat ID в Профиле есть кнопка «Найти», которая дёргает этот endpoint. На 404 фронт показывает кликабельную ссылку `https://t.me/<bot_username>` с инструкцией написать `/start`.

```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: lookup-telegram-chat-id endpoint in CLAUDE.md"
```

---

## Task 8: Финальный smoke

**Files:** (нет правок)

- [ ] **Step 1: Все тесты**

```bash
npx vitest run
```

Expected: всё PASS.
- было baseline: 153
- +4 от Task 2 (telegramClient: getMe×2 + getUpdates×3 = 5; в тесты добавил 4: «empty», «parsed updates», «throws on error», + ещё «401 throws» для getMe ⇒ 1+1+1+1=4)
- +9 от Task 4 (profile lookup endpoint)
- итого ~166 тестов.

Точное число можно проверить — главное, что 0 fail.

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 3: Краткий обзор изменений на ветке**

```bash
git log --oneline main..feature/telegram-chat-id-helper
```

Expected: ~7-8 коммитов (Tasks 1-7 и иногда поправки).

- [ ] **Step 4: (Опционально) PR**

Если работаем через PR:

```bash
gh pr create --title "Telegram Chat ID lookup helper" --body "$(cat <<'EOF'
## Summary
- Кнопка «Найти» рядом с Chat ID в Профиле
- POST /api/profile/lookup-telegram-chat-id оркестрирует getMe + getUpdates + sendMessage
- На 404 фронт показывает t.me-ссылку и просит написать /start

См. spec: `docs/superpowers/specs/2026-04-30-telegram-chat-id-helper-design.md`

## Test plan
- [ ] Прогнать `npx vitest run` — все green
- [ ] В дашборде → Профиль: ввести токен, нажать «Найти» **без** /start → должна появиться ссылка на бота с инструкцией
- [ ] Написать боту /start, нажать «Найти» снова → Chat ID появится в поле, в Telegram придёт подтверждающее сообщение
- [ ] Нажать «Сохранить» → токен и chat_id сохранены, кнопка «Отправить тестовое» работает
EOF
)"
```

---

## Self-review

Прохожу спек по разделам:

- ✅ **Не-цели зафиксированы** — auto-save chat_id не делаем (Task 6 только подставляет в поле, не PATCH'им), нет полного wizard, нет webhook/long-polling.
- ✅ **UX**:
  - Поток 1-9 → Tasks 5+6 (UI кнопка + JS lookupChatId с обработкой no_updates/success).
  - Bot username deep-link → Task 6 (`'https://t.me/' + u`).
- ✅ **API endpoint** `POST /api/profile/lookup-telegram-chat-id` → Task 3 (полный код всех 4 ветвей: 400 без токена, 400 малформ, 401 невалидный, 404 пусто, 200 ok).
- ✅ **Telegram API calls (getMe + getUpdates + sendMessage)** → Tasks 1, 2, 3.
- ✅ **Алгоритм выбора chat_id** (приватный, самый свежий по update_id) → Task 3 + Task 4 (тест с 3 разными update_id).
- ✅ **Confirmation message text** → Task 3 (template константа).
- ✅ **Изменения в файлах** — все 7 файлов из спека покрыты Tasks 1-7.
- ✅ **Тесты**:
  - getMe/getUpdates → Task 2.
  - lookup endpoint (8 кейсов) → Task 4.
- ✅ **Риски**: проверка через 200 даже при failed sendMessage (Task 4 «returns 200 with confirmation_sent=false if sendMessage fails»). Webhook risk и 24-часовое окно — поведенчески обрабатываются 404'кой, ничего отдельно тестировать не нужно.

**Placeholder scan:** searched for «similar to Task», «TBD», «handle edge cases» — нет.

**Type consistency:**
- `TelegramUpdate` — Task 1, используется в Task 3.
- `getMe`/`getUpdates` сигнатуры — Task 1, импорты Task 3 и тесты Task 2/4 совпадают.
- `BOT_TOKEN_RX` — уже существует в profile.ts (используется в PATCH), переиспользуется в Task 3.
- `userRepo.getTelegramConfig` — уже есть, Task 3 использует.
- `App.apiJson` сигнатура `(path, options)` — Task 6 совпадает с прошлой фичей.

Всё согласовано.

**Scope:** одна маленькая фича (~7 task'ов, 8 коммитов, ~30 минут работы). Размер OK.
