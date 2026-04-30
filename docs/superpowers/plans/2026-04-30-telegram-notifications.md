# Telegram Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заменить email-канал уведомлений на Telegram. Каждой накладной соответствует один thread-сообщение в Telegram, обновляемое через `editMessageText` по мере прогресса. Срочные события (recognition_error, suspicious_total) идут отдельными сообщениями. Email-инфраструктура остаётся в коде как dead code.

**Architecture:** Новый модуль `src/notifications/telegram/` (3 файла: client + formatter + notifier). Внутри существующего `events.ts` подменяем вызов email-канала на Telegram. Хранение токена бота и chat_id — в `users` (миграция 19), `telegram_message_id` per-invoice — в `invoices`. UI в дашборде заменяет email-секцию на telegram-секцию с двумя полями + инструкцией.

**Tech Stack:** Node 25 + TypeScript, Express 5, better-sqlite3, native `fetch` (Node ≥18) для Telegram Bot API, vitest для тестов. Никакого нового SDK — только два метода Bot API.

**Spec:** [`docs/superpowers/specs/2026-04-30-telegram-notifications-design.md`](../specs/2026-04-30-telegram-notifications-design.md)

---

## File Structure

**Создаются:**
- `src/notifications/telegram/telegramClient.ts` — низкоуровневый wrapper над Bot API (`sendMessage`, `editMessageText`, `MessageGoneError`)
- `src/notifications/telegram/telegramFormatter.ts` — чистые функции форматирования текста (`buildInvoiceThread`, `buildUrgentMessage`)
- `src/notifications/telegram/telegramNotifier.ts` — высокоуровневый эмиттер `sendInvoiceNotification`
- `tests/notifications/telegram/telegramClient.test.ts`
- `tests/notifications/telegram/telegramFormatter.test.ts`
- `tests/notifications/telegram/telegramNotifier.test.ts`

**Изменяются:**
- `src/database/migrations.ts` — миграция 19
- `src/database/repositories/userRepo.ts` — `User` interface + `getTelegramConfig`/`setTelegramConfig`
- `src/database/repositories/invoiceRepo.ts` — `Invoice` interface + `getTelegramMessageId`/`setTelegramMessageId`
- `src/notifications/events.ts` — заменить email-вызов на Telegram-вызов
- `src/api/routes/profile.ts` — расширить GET/PATCH; добавить POST `/test-telegram`; убрать POST `/test-email` из UI-cценария (сам endpoint оставим как dead-code endpoint, чтоб не ломать ABI)
- `tests/notifications/events.test.ts` — обновить под новый канал
- `tests/api/profile.test.ts` — добавить кейсы для telegram-полей
- `public/app.html` — секция `view-profile` переписывается под Telegram
- `public/js/profile.js` — обновить под Telegram-конфиг
- `CLAUDE.md` — раздел «Уведомления» — переписать под Telegram
- `.env.example` — комментарий «SMTP_* больше не нужны для пользовательских уведомлений»

Каждый новый файл < 200 строк, одна ответственность.

---

## Task 0: Setup — закоммитить спек, спрятать чужие правки, создать worktree

**Files:**
- Add: `docs/superpowers/specs/2026-04-30-telegram-notifications-design.md` (уже создан)

- [ ] **Step 1: Закоммитить спек на main**

```bash
cd C:/www/ScanFlow
git add docs/superpowers/specs/2026-04-30-telegram-notifications-design.md
git commit -m "docs(spec): Telegram notifications replacing email channel"
```

- [ ] **Step 2: Спрятать чужие незакоммиченные правки в stash**

В git status есть 6 файлов с правками от прошлых сессий (`config.ts`, `index.ts`, `fileWatcher.ts`, `.env.example`, `claudeApiAnalyzer.ts`, `test-pipeline.ts`). Они НЕ относятся к Telegram-фиче.

```bash
git stash push -m "WIP: pre-existing changes (Apr 30 session — telegram start)" -- src/config.ts src/index.ts src/watcher/fileWatcher.ts .env.example src/ocr/claudeApiAnalyzer.ts src/scripts/test-pipeline.ts
git status --short
```

Expected: только untracked файлы вроде `data/database.sqlite-shm` (игнорируются `.gitignore`-ом). Modified должно быть пусто.

- [ ] **Step 3: Создать worktree для feature-ветки**

```bash
git worktree add .worktrees/telegram -b feature/telegram-notifications
cd .worktrees/telegram
npm install
```

- [ ] **Step 4: Verify baseline — все 127 тестов проходят**

```bash
npx vitest run
```

Expected: `Test Files 8 passed (8) | Tests 127 passed (127)`. Если упало — расследовать прежде чем стартовать.

- [ ] **Step 5: Закоммитить план**

План `docs/superpowers/plans/2026-04-30-telegram-notifications.md` ещё не в git (создан в worktree должен подтянуться через main, либо если в main не было — добавить).

```bash
# Worktree shares git history with main, so the plan committed on main is visible.
# If the plan was created in worktree directly, commit it here:
git add docs/superpowers/plans/2026-04-30-telegram-notifications.md
git commit -m "docs(plan): Telegram notifications implementation plan" || echo "Already committed on main"
```

---

## Task 1: Migration 19 — telegram fields in users + invoices

**Files:**
- Modify: `src/database/migrations.ts`

- [ ] **Step 1: Добавить миграцию 19 в массив**

В `src/database/migrations.ts` найти последний элемент массива `MIGRATIONS` (миграция 18 — `'user notification settings'`) и сразу после её закрывающей `},` добавить:

```typescript
  {
    version: 19,
    name: 'telegram notification fields',
    detect: (db) =>
      hasColumn(db, 'users', 'telegram_chat_id') &&
      hasColumn(db, 'users', 'telegram_bot_token') &&
      hasColumn(db, 'invoices', 'telegram_message_id'),
    run: (db) => {
      if (!hasColumn(db, 'users', 'telegram_chat_id')) {
        db.exec(`ALTER TABLE users ADD COLUMN telegram_chat_id TEXT;`);
      }
      if (!hasColumn(db, 'users', 'telegram_bot_token')) {
        db.exec(`ALTER TABLE users ADD COLUMN telegram_bot_token TEXT;`);
      }
      if (!hasColumn(db, 'invoices', 'telegram_message_id')) {
        db.exec(`ALTER TABLE invoices ADD COLUMN telegram_message_id INTEGER;`);
      }
    },
  },
```

- [ ] **Step 2: Verify migration applies cleanly**

```bash
npx tsx -e "
import Database from 'better-sqlite3';
import { runMigrations } from './src/database/migrations';
const db = new Database(':memory:');
runMigrations(db);
const userCols = db.prepare(\"PRAGMA table_info(users)\").all().map((r: any) => r.name);
const invCols = db.prepare(\"PRAGMA table_info(invoices)\").all().map((r: any) => r.name);
console.log('users has telegram_chat_id:', userCols.includes('telegram_chat_id'));
console.log('users has telegram_bot_token:', userCols.includes('telegram_bot_token'));
console.log('invoices has telegram_message_id:', invCols.includes('telegram_message_id'));
console.log('migration_history:', db.prepare('SELECT version FROM migration_history ORDER BY version DESC LIMIT 1').get());
"
```

Expected: все три `true`, последняя миграция version 19.

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/database/migrations.ts
git commit -m "feat(db): migration 19 — telegram_chat_id/bot_token + invoice telegram_message_id"
```

---

## Task 2: Расширить userRepo и invoiceRepo

**Files:**
- Modify: `src/database/repositories/userRepo.ts`
- Modify: `src/database/repositories/invoiceRepo.ts`

- [ ] **Step 1: Добавить telegram-поля в `User` interface**

В `src/database/repositories/userRepo.ts` найти `export interface User` и добавить в конец (после `notify_events: string;`):

```typescript
  telegram_chat_id: string | null;
  telegram_bot_token: string | null;
```

- [ ] **Step 2: Добавить методы getTelegramConfig/setTelegramConfig в userRepo**

В конце объекта `userRepo` (перед закрывающей `};`) добавить:

```typescript
  getTelegramConfig(id: number): { chat_id: string | null; bot_token: string | null } | null {
    const row = getDb()
      .prepare('SELECT telegram_chat_id, telegram_bot_token FROM users WHERE id = ?')
      .get(id) as { telegram_chat_id: string | null; telegram_bot_token: string | null } | undefined;
    if (!row) return null;
    return { chat_id: row.telegram_chat_id, bot_token: row.telegram_bot_token };
  },

  setTelegramConfig(id: number, cfg: Partial<{ chat_id: string | null; bot_token: string | null }>): void {
    const fields: string[] = [];
    const values: unknown[] = [];
    if (cfg.chat_id !== undefined) {
      fields.push('telegram_chat_id = ?');
      values.push(cfg.chat_id);
    }
    if (cfg.bot_token !== undefined) {
      fields.push('telegram_bot_token = ?');
      values.push(cfg.bot_token);
    }
    if (fields.length === 0) return;
    values.push(id);
    getDb().prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  },
```

- [ ] **Step 3: Добавить telegram_message_id в `Invoice` interface**

В `src/database/repositories/invoiceRepo.ts` найти `export interface Invoice` и добавить в конец (после `items_total_mismatch: number;`):

```typescript
  telegram_message_id: number | null;
```

- [ ] **Step 4: Добавить методы getTelegramMessageId/setTelegramMessageId в invoiceRepo**

В конце объекта `invoiceRepo` (перед закрывающей `};`) добавить:

```typescript
  getTelegramMessageId(id: number): number | null {
    const row = getDb()
      .prepare('SELECT telegram_message_id FROM invoices WHERE id = ?')
      .get(id) as { telegram_message_id: number | null } | undefined;
    return row?.telegram_message_id ?? null;
  },

  setTelegramMessageId(id: number, messageId: number): void {
    getDb()
      .prepare('UPDATE invoices SET telegram_message_id = ? WHERE id = ?')
      .run(messageId, id);
  },
```

- [ ] **Step 5: Typecheck**

```bash
npx tsc --noEmit
```

Expected: 0 errors. Если падает на `getById` потому что нового поля нет в `SELECT *` — это ок, SQLite возвращает все колонки таблицы; TypeScript просто проверяет shape. Поскольку в схеме поле есть, при чтении `Invoice` оно появится.

- [ ] **Step 6: Commit**

```bash
git add src/database/repositories/userRepo.ts src/database/repositories/invoiceRepo.ts
git commit -m "feat(repos): telegram_chat_id/bot_token in userRepo + telegram_message_id in invoiceRepo"
```

---

## Task 3: telegramClient.ts — низкоуровневый wrapper

**Files:**
- Create: `src/notifications/telegram/telegramClient.ts`

- [ ] **Step 1: Создать модуль**

```typescript
import { logger } from '../../utils/logger';

// Thrown by editMessageText when Telegram says the message is gone
// (deleted by user, or doesn't exist). Caller should fall back to sendMessage.
export class MessageGoneError extends Error {
  constructor(public telegramDescription: string) {
    super(`Telegram message gone: ${telegramDescription}`);
    this.name = 'MessageGoneError';
  }
}

interface TelegramOk<T> {
  ok: true;
  result: T;
}
interface TelegramErr {
  ok: false;
  description: string;
  error_code: number;
}

async function callTelegram<T>(token: string, method: string, params: Record<string, unknown>): Promise<T> {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json()) as TelegramOk<T> | TelegramErr;
  if (!data.ok) {
    const errData = data as TelegramErr;
    // editMessageText returns 400 with descriptions like:
    //   "Bad Request: message to edit not found"
    //   "Bad Request: message can't be edited"
    //   "Bad Request: MESSAGE_ID_INVALID"
    if (
      method === 'editMessageText' &&
      errData.error_code === 400 &&
      /message (to edit )?not found|message can't be edited|MESSAGE_ID_INVALID/i.test(errData.description)
    ) {
      throw new MessageGoneError(errData.description);
    }
    throw new Error(`Telegram API ${method} failed: ${errData.error_code} ${errData.description}`);
  }
  return data.result;
}

interface SendMessageResult {
  message_id: number;
}

// Sends a new text message to chat. Returns the new message_id.
export async function sendMessage(token: string, chatId: string, text: string): Promise<number> {
  const result = await callTelegram<SendMessageResult>(token, 'sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });
  logger.debug('Telegram sendMessage ok', { chatId, messageId: result.message_id });
  return result.message_id;
}

// Edits an existing message. Throws MessageGoneError if the message is no
// longer editable; the caller should fall back to sendMessage.
export async function editMessageText(
  token: string,
  chatId: string,
  messageId: number,
  text: string,
): Promise<void> {
  await callTelegram(token, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
  });
  logger.debug('Telegram editMessageText ok', { chatId, messageId });
}
```

- [ ] **Step 2: Создать директорию для тестов**

```bash
mkdir -p tests/notifications/telegram
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/notifications/telegram/telegramClient.ts
git commit -m "feat(telegram): low-level Bot API client (sendMessage + editMessageText)"
```

---

## Task 4: telegramClient тесты

**Files:**
- Create: `tests/notifications/telegram/telegramClient.test.ts`

- [ ] **Step 1: Написать тесты**

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sendMessage, editMessageText, MessageGoneError } from '../../../src/notifications/telegram/telegramClient';

const TOKEN = 'test:bot-token';
const CHAT = '123456';

function mockFetchResponse(body: unknown, ok = true): void {
  global.fetch = vi.fn(async () => ({
    json: async () => body,
    ok,
  })) as any;
}

describe('telegramClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('sendMessage', () => {
    it('returns message_id on success', async () => {
      mockFetchResponse({ ok: true, result: { message_id: 999 } });
      const id = await sendMessage(TOKEN, CHAT, 'hello');
      expect(id).toBe(999);
    });

    it('posts the right body to Telegram API', async () => {
      const fetchMock = vi.fn(async () => ({
        json: async () => ({ ok: true, result: { message_id: 1 } }),
        ok: true,
      }));
      global.fetch = fetchMock as any;
      await sendMessage(TOKEN, CHAT, 'hi');
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toContain(`bot${TOKEN}/sendMessage`);
      expect(init?.method).toBe('POST');
      const body = JSON.parse(init?.body as string);
      expect(body.chat_id).toBe(CHAT);
      expect(body.text).toBe('hi');
      expect(body.disable_web_page_preview).toBe(true);
    });

    it('throws on Telegram API error', async () => {
      mockFetchResponse({ ok: false, error_code: 401, description: 'Unauthorized' });
      await expect(sendMessage(TOKEN, CHAT, 'x')).rejects.toThrow(/401 Unauthorized/);
    });
  });

  describe('editMessageText', () => {
    it('resolves on success', async () => {
      mockFetchResponse({ ok: true, result: true });
      await expect(editMessageText(TOKEN, CHAT, 42, 'updated')).resolves.toBeUndefined();
    });

    it('throws MessageGoneError when Telegram says message not found', async () => {
      mockFetchResponse({
        ok: false,
        error_code: 400,
        description: 'Bad Request: message to edit not found',
      });
      await expect(editMessageText(TOKEN, CHAT, 42, 'x')).rejects.toBeInstanceOf(MessageGoneError);
    });

    it('throws MessageGoneError when message can\'t be edited', async () => {
      mockFetchResponse({
        ok: false,
        error_code: 400,
        description: "Bad Request: message can't be edited",
      });
      await expect(editMessageText(TOKEN, CHAT, 42, 'x')).rejects.toBeInstanceOf(MessageGoneError);
    });

    it('throws generic Error for other 400 codes', async () => {
      mockFetchResponse({
        ok: false,
        error_code: 400,
        description: 'Bad Request: chat not found',
      });
      // Not "message not found" — general error
      const err = await editMessageText(TOKEN, CHAT, 42, 'x').catch(e => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(MessageGoneError);
    });
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run tests/notifications/telegram/telegramClient.test.ts
```

Expected: 6 tests passing.

- [ ] **Step 3: Commit**

```bash
git add tests/notifications/telegram/telegramClient.test.ts
git commit -m "test(telegram): client API behaviour incl. MessageGoneError detection"
```

---

## Task 5: telegramFormatter.ts

**Files:**
- Create: `src/notifications/telegram/telegramFormatter.ts`

- [ ] **Step 1: Создать модуль**

```typescript
import type { Invoice } from '../../database/repositories/invoiceRepo';
import type { EventType, EventPayload } from '../types';

// Per-event timestamp. Built from invoice fields directly (no separate event log
// is maintained; the invoice itself is the source of truth for state).
export interface EventState {
  photo_uploaded: Date | null;
  invoice_recognized: Date | null;
  approved_for_1c: Date | null;
  sent_to_1c: Date | null;
}

// Maps the current invoice state to which thread events have happened.
// approved_for_1c: presence of approved_at field.
// invoice_recognized: status='processed' or beyond.
// sent_to_1c: presence of sent_at.
// photo_uploaded: always true once the invoice exists; uses created_at.
export function deriveEventState(invoice: Invoice): EventState {
  const created = invoice.created_at ? new Date(invoice.created_at + 'Z') : null;
  // We don't have a precise timestamp for "recognized" in the schema; use the
  // invoice's created_at as a proxy when the invoice has progressed past parsing.
  // For better timestamps we'd need a separate column. Good enough.
  const recognized =
    invoice.status === 'processed' ||
    invoice.status === 'sent_to_1c' ||
    invoice.approved_for_1c === 1
      ? created
      : null;
  const approved = invoice.approved_at ? new Date(invoice.approved_at + 'Z') : null;
  const sent = invoice.sent_at ? new Date(invoice.sent_at + 'Z') : null;

  return {
    photo_uploaded: created,
    invoice_recognized: recognized,
    approved_for_1c: approved,
    sent_to_1c: sent,
  };
}

function fmtMoney(n: number | null | undefined): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n) + ' ₽';
}

function fmtTime(d: Date | null): string {
  if (!d) return '';
  // Local Moscow time in HH:mm format — concise for thread display.
  const fmt = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit',
  });
  return fmt.format(d);
}

const STEP_LABELS: Record<keyof EventState, string> = {
  photo_uploaded: 'Загружена',
  invoice_recognized: 'Распознана',
  approved_for_1c: 'Утверждена',
  sent_to_1c: 'Отправлена в 1С',
};

const STEP_ORDER: Array<keyof EventState> = [
  'photo_uploaded',
  'invoice_recognized',
  'approved_for_1c',
  'sent_to_1c',
];

// Builds the full thread message text reflecting all done/pending steps.
// Plain text (no parse_mode) so we don't have to escape special chars in
// supplier names. Telegram ignores most chars in plain text.
export function buildInvoiceThread(invoice: Invoice, state: EventState): string {
  const num = invoice.invoice_number || `#${invoice.id}`;
  const supplier = invoice.supplier || '—';
  const sum = fmtMoney(invoice.total_sum);

  const lines: string[] = [
    `📄 Накладная № ${num}`,
    `Поставщик: ${supplier}`,
    `Сумма: ${sum}`,
    '',
  ];

  for (const step of STEP_ORDER) {
    const ts = state[step];
    if (ts) {
      lines.push(`✅ ${STEP_LABELS[step]} ${fmtTime(ts)}`);
    } else {
      lines.push(`⏳ ${STEP_LABELS[step]}`);
    }
  }

  return lines.join('\n');
}

// Builds the standalone urgent message body. Not part of the invoice thread.
export function buildUrgentMessage(
  eventType: 'recognition_error' | 'suspicious_total',
  payload: EventPayload,
): string {
  const num = payload.invoice_number ? String(payload.invoice_number) : `#${payload.invoice_id}`;
  const supplier = payload.supplier ? String(payload.supplier) : '—';
  const sum = fmtMoney(payload.total_sum as number | null | undefined);

  if (eventType === 'recognition_error') {
    const err = payload.error_message ? String(payload.error_message) : 'без описания';
    return [
      `🚨 Ошибка распознавания`,
      `Накладная: ${num}`,
      `Поставщик: ${supplier}`,
      ``,
      `Причина: ${err}`,
    ].join('\n');
  }

  // suspicious_total
  const itemsTotal = payload.items_total != null ? fmtMoney(payload.items_total as number) : null;
  const lines = [
    `⚠️ Подозрительная сумма`,
    `Накладная: ${num}`,
    `Поставщик: ${supplier}`,
    `Сумма по документу: ${sum}`,
  ];
  if (itemsTotal) lines.push(`Сумма строк: ${itemsTotal}`);
  lines.push('', 'Проверьте документ в дашборде.');
  return lines.join('\n');
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/notifications/telegram/telegramFormatter.ts
git commit -m "feat(telegram): plain-text formatter (invoice thread + urgent messages)"
```

---

## Task 6: telegramFormatter тесты

**Files:**
- Create: `tests/notifications/telegram/telegramFormatter.test.ts`

- [ ] **Step 1: Написать тесты**

```typescript
import { describe, it, expect } from 'vitest';
import {
  buildInvoiceThread,
  buildUrgentMessage,
  deriveEventState,
  type EventState,
} from '../../../src/notifications/telegram/telegramFormatter';
import type { Invoice } from '../../../src/database/repositories/invoiceRepo';

const NBSP = String.fromCharCode(160);

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 85,
    file_name: 'photo.jpg',
    file_path: '/data/photo.jpg',
    invoice_number: 'НФНФ-000085',
    invoice_date: '2026-04-25',
    supplier: 'Свит лайф фудсервис',
    total_sum: 66714.11,
    invoice_type: 'торг_12',
    supplier_inn: null,
    supplier_bik: null,
    supplier_account: null,
    supplier_corr_account: null,
    supplier_address: null,
    vat_sum: null,
    raw_text: null,
    status: 'processed',
    ocr_engine: null,
    error_message: null,
    created_at: '2026-04-29 11:13:00',
    sent_at: null,
    approved_for_1c: 0,
    approved_at: null,
    file_hash: null,
    items_total_mismatch: 0,
    telegram_message_id: null,
    ...overrides,
  };
}

describe('buildInvoiceThread', () => {
  it('shows pending state for unprocessed invoice', () => {
    const inv = makeInvoice({ status: 'parsing' });
    const state: EventState = {
      photo_uploaded: new Date('2026-04-29T11:13:00Z'),
      invoice_recognized: null,
      approved_for_1c: null,
      sent_to_1c: null,
    };
    const text = buildInvoiceThread(inv, state);
    expect(text).toContain('📄 Накладная № НФНФ-000085');
    expect(text).toContain('Свит лайф фудсервис');
    expect(text).toContain(`66${NBSP}714,11 ₽`);
    expect(text).toContain('✅ Загружена');
    expect(text).toContain('⏳ Распознана');
    expect(text).toContain('⏳ Утверждена');
    expect(text).toContain('⏳ Отправлена в 1С');
  });

  it('shows all steps complete when invoice is sent', () => {
    const inv = makeInvoice({ status: 'sent_to_1c', approved_at: '2026-04-29 11:18:00', sent_at: '2026-04-29 11:20:00' });
    const state: EventState = {
      photo_uploaded: new Date('2026-04-29T11:13:00Z'),
      invoice_recognized: new Date('2026-04-29T11:14:00Z'),
      approved_for_1c: new Date('2026-04-29T11:18:00Z'),
      sent_to_1c: new Date('2026-04-29T11:20:00Z'),
    };
    const text = buildInvoiceThread(inv, state);
    expect(text.match(/✅/g)?.length).toBe(4);
    expect(text).not.toContain('⏳');
  });

  it('falls back to #id when invoice_number is missing', () => {
    const inv = makeInvoice({ invoice_number: null });
    const state = deriveEventState(inv);
    const text = buildInvoiceThread(inv, state);
    expect(text).toContain('Накладная № #85');
  });
});

describe('buildUrgentMessage', () => {
  it('builds recognition_error message with error_message', () => {
    const text = buildUrgentMessage('recognition_error', {
      invoice_id: 1,
      invoice_number: '85',
      supplier: 'X',
      total_sum: 1000,
      error_message: 'Claude API timeout',
    });
    expect(text).toContain('🚨 Ошибка распознавания');
    expect(text).toContain('Накладная: 85');
    expect(text).toContain('Claude API timeout');
  });

  it('builds suspicious_total with both totals', () => {
    const text = buildUrgentMessage('suspicious_total', {
      invoice_id: 1,
      invoice_number: '85',
      supplier: 'Y',
      total_sum: 1000,
      items_total: 980,
    });
    expect(text).toContain('⚠️ Подозрительная сумма');
    expect(text).toContain(`1${NBSP}000,00 ₽`);
    expect(text).toContain('980,00 ₽');
  });

  it('omits items_total line when not provided', () => {
    const text = buildUrgentMessage('suspicious_total', {
      invoice_id: 1,
      invoice_number: '85',
      supplier: 'Y',
      total_sum: 1000,
    });
    expect(text).not.toContain('Сумма строк');
  });

  it('shows "без описания" when error_message missing', () => {
    const text = buildUrgentMessage('recognition_error', {
      invoice_id: 1,
      invoice_number: '85',
      supplier: 'X',
      total_sum: 1000,
    });
    expect(text).toContain('без описания');
  });
});

describe('deriveEventState', () => {
  it('returns null for everything pending when invoice is parsing', () => {
    const inv = makeInvoice({ status: 'parsing', approved_at: null, sent_at: null });
    const state = deriveEventState(inv);
    expect(state.photo_uploaded).toBeInstanceOf(Date);
    expect(state.invoice_recognized).toBeNull();
    expect(state.approved_for_1c).toBeNull();
    expect(state.sent_to_1c).toBeNull();
  });

  it('marks recognized when status is processed', () => {
    const inv = makeInvoice({ status: 'processed' });
    const state = deriveEventState(inv);
    expect(state.invoice_recognized).toBeInstanceOf(Date);
  });

  it('marks all four steps when sent', () => {
    const inv = makeInvoice({
      status: 'sent_to_1c',
      approved_at: '2026-04-29 11:18:00',
      sent_at: '2026-04-29 11:20:00',
    });
    const state = deriveEventState(inv);
    expect(state.photo_uploaded).toBeInstanceOf(Date);
    expect(state.invoice_recognized).toBeInstanceOf(Date);
    expect(state.approved_for_1c).toBeInstanceOf(Date);
    expect(state.sent_to_1c).toBeInstanceOf(Date);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run tests/notifications/telegram/telegramFormatter.test.ts
```

Expected: 10 tests passing.

- [ ] **Step 3: Commit**

```bash
git add tests/notifications/telegram/telegramFormatter.test.ts
git commit -m "test(telegram): formatter — invoice thread, urgent messages, event state derivation"
```

---

## Task 7: telegramNotifier.ts

**Files:**
- Create: `src/notifications/telegram/telegramNotifier.ts`

- [ ] **Step 1: Создать модуль**

```typescript
import { logger } from '../../utils/logger';
import { invoiceRepo, type Invoice } from '../../database/repositories/invoiceRepo';
import { sendMessage, editMessageText, MessageGoneError } from './telegramClient';
import { buildInvoiceThread, buildUrgentMessage, deriveEventState } from './telegramFormatter';
import { URGENT_EVENT_TYPES, type EventType, type EventPayload } from '../types';

interface TelegramConfig {
  token: string;
  chat_id: string;
}

// Top-level Telegram emission. Decides whether the event is urgent (separate
// message) or progress (thread edit), formats accordingly, and persists the
// telegram_message_id when a new thread is created.
//
// Never throws. All errors are logged and swallowed — notifications must
// never break the main pipeline.
export async function sendInvoiceNotification(
  cfg: TelegramConfig,
  invoice: Invoice,
  eventType: EventType,
  payload: EventPayload,
): Promise<void> {
  try {
    if (URGENT_EVENT_TYPES.has(eventType)) {
      // Urgent → separate standalone message. Don't touch invoice thread.
      const text = buildUrgentMessage(
        eventType as 'recognition_error' | 'suspicious_total',
        payload,
      );
      try {
        await sendMessage(cfg.token, cfg.chat_id, text);
      } catch (err) {
        logger.error('telegramNotifier: urgent send failed', {
          eventType,
          invoiceId: invoice.id,
          error: (err as Error).message,
        });
      }
      return;
    }

    // Progress event → edit (or create) the invoice thread message.
    const state = deriveEventState(invoice);
    const text = buildInvoiceThread(invoice, state);

    const existingMessageId = invoice.telegram_message_id ?? null;

    if (existingMessageId != null) {
      try {
        await editMessageText(cfg.token, cfg.chat_id, existingMessageId, text);
        return;
      } catch (err) {
        if (err instanceof MessageGoneError) {
          logger.warn('telegramNotifier: thread message gone, sending new one', {
            invoiceId: invoice.id,
            oldMessageId: existingMessageId,
          });
          // fall through to sendMessage below
        } else {
          logger.error('telegramNotifier: edit failed (non-recoverable)', {
            eventType,
            invoiceId: invoice.id,
            error: (err as Error).message,
          });
          return;
        }
      }
    }

    // Either no existing message_id, or edit failed with MessageGoneError.
    try {
      const newMessageId = await sendMessage(cfg.token, cfg.chat_id, text);
      invoiceRepo.setTelegramMessageId(invoice.id, newMessageId);
    } catch (err) {
      logger.error('telegramNotifier: thread send failed', {
        eventType,
        invoiceId: invoice.id,
        error: (err as Error).message,
      });
    }
  } catch (err) {
    // Defensive: this function must never throw.
    logger.error('telegramNotifier: unexpected error', {
      eventType,
      invoiceId: invoice.id,
      error: (err as Error).message,
    });
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/notifications/telegram/telegramNotifier.ts
git commit -m "feat(telegram): notifier — thread edit with sendMessage fallback for gone messages"
```

---

## Task 8: telegramNotifier тесты

**Files:**
- Create: `tests/notifications/telegram/telegramNotifier.test.ts`

- [ ] **Step 1: Написать тесты**

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../src/notifications/telegram/telegramClient', () => ({
  sendMessage: vi.fn(async () => 999),
  editMessageText: vi.fn(async () => {}),
  MessageGoneError: class MessageGoneError extends Error {
    constructor(d: string) { super(d); this.name = 'MessageGoneError'; }
  },
}));

vi.mock('../../../src/database/repositories/invoiceRepo', () => ({
  invoiceRepo: {
    setTelegramMessageId: vi.fn(),
  },
}));

import { sendInvoiceNotification } from '../../../src/notifications/telegram/telegramNotifier';
import { sendMessage, editMessageText, MessageGoneError } from '../../../src/notifications/telegram/telegramClient';
import { invoiceRepo } from '../../../src/database/repositories/invoiceRepo';
import type { Invoice } from '../../../src/database/repositories/invoiceRepo';

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 85,
    file_name: 'photo.jpg',
    file_path: '/data/photo.jpg',
    invoice_number: '85',
    invoice_date: null,
    supplier: 'X',
    total_sum: 1000,
    invoice_type: null,
    supplier_inn: null,
    supplier_bik: null,
    supplier_account: null,
    supplier_corr_account: null,
    supplier_address: null,
    vat_sum: null,
    raw_text: null,
    status: 'processed',
    ocr_engine: null,
    error_message: null,
    created_at: '2026-04-29 10:00:00',
    sent_at: null,
    approved_for_1c: 0,
    approved_at: null,
    file_hash: null,
    items_total_mismatch: 0,
    telegram_message_id: null,
    ...overrides,
  };
}

const cfg = { token: 't', chat_id: 'c' };
const payload = { invoice_id: 85 };

describe('sendInvoiceNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends new message for first event on invoice (no telegram_message_id)', async () => {
    await sendInvoiceNotification(cfg, makeInvoice(), 'invoice_recognized', payload);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(editMessageText).not.toHaveBeenCalled();
    expect(invoiceRepo.setTelegramMessageId).toHaveBeenCalledWith(85, 999);
  });

  it('edits existing message when telegram_message_id is set', async () => {
    await sendInvoiceNotification(cfg, makeInvoice({ telegram_message_id: 42 }), 'approved_for_1c', payload);
    expect(editMessageText).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(invoiceRepo.setTelegramMessageId).not.toHaveBeenCalled();
  });

  it('falls back to sendMessage when edit hits MessageGoneError', async () => {
    (editMessageText as any).mockRejectedValueOnce(new MessageGoneError('gone'));
    await sendInvoiceNotification(cfg, makeInvoice({ telegram_message_id: 42 }), 'approved_for_1c', payload);
    expect(editMessageText).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(invoiceRepo.setTelegramMessageId).toHaveBeenCalledWith(85, 999);
  });

  it('does NOT fallback for non-MessageGoneError edit failures', async () => {
    (editMessageText as any).mockRejectedValueOnce(new Error('Network timeout'));
    await sendInvoiceNotification(cfg, makeInvoice({ telegram_message_id: 42 }), 'approved_for_1c', payload);
    expect(editMessageText).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('sends standalone message for urgent recognition_error', async () => {
    await sendInvoiceNotification(
      cfg,
      makeInvoice({ telegram_message_id: 42 }),
      'recognition_error',
      { ...payload, error_message: 'oops' },
    );
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(editMessageText).not.toHaveBeenCalled();
    // Crucially: telegram_message_id NOT updated (urgent message is standalone)
    expect(invoiceRepo.setTelegramMessageId).not.toHaveBeenCalled();
  });

  it('sends standalone message for urgent suspicious_total', async () => {
    await sendInvoiceNotification(
      cfg,
      makeInvoice({ telegram_message_id: 42 }),
      'suspicious_total',
      { ...payload, items_total: 980 },
    );
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(editMessageText).not.toHaveBeenCalled();
    expect(invoiceRepo.setTelegramMessageId).not.toHaveBeenCalled();
  });

  it('does not throw when sendMessage rejects', async () => {
    (sendMessage as any).mockRejectedValueOnce(new Error('Telegram down'));
    await expect(
      sendInvoiceNotification(cfg, makeInvoice(), 'invoice_recognized', payload),
    ).resolves.toBeUndefined();
  });

  it('does not throw when urgent send fails', async () => {
    (sendMessage as any).mockRejectedValueOnce(new Error('Telegram down'));
    await expect(
      sendInvoiceNotification(cfg, makeInvoice(), 'recognition_error', { ...payload, error_message: 'x' }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run tests/notifications/telegram/telegramNotifier.test.ts
```

Expected: 8 tests passing.

- [ ] **Step 3: Commit**

```bash
git add tests/notifications/telegram/telegramNotifier.test.ts
git commit -m "test(telegram): notifier — thread create/edit, fallback, urgent isolation"
```

---

## Task 9: Подменить email-канал на Telegram в events.ts

**Files:**
- Modify: `src/notifications/events.ts`

- [ ] **Step 1: Прочитать текущий events.ts**

```bash
cat src/notifications/events.ts
```

Текущая логика: получает `cfg = userRepo.getNotifyConfig(userId)`, проверяет `cfg.email`, проверяет `cfg.notify_events.includes(eventType)`, выбирает realtime vs digest, и вызывает `sendNotification(cfg.email, subject, html)` или `notificationRepo.enqueue(...)`.

- [ ] **Step 2: Заменить содержимое events.ts**

Полный новый текст файла:

```typescript
import { logger } from '../utils/logger';
import { userRepo } from '../database/repositories/userRepo';
import { invoiceRepo } from '../database/repositories/invoiceRepo';
import { sendInvoiceNotification } from './telegram/telegramNotifier';
import { type EventType, type EventPayload } from './types';

// Domain-event entry point. Routes the event to Telegram (current channel).
// Email infrastructure remains in the codebase as dead code, but no events
// reach it anymore.
//
// Never throws — failure is logged and swallowed (notifications must never
// break the main pipeline).
//
// triggeredByUserId: pass req.user?.id when in HTTP context. When the
// caller is a background process (file watcher, cron), pass null —
// we'll use the first user as the recipient (single-user system).
export async function emit(
  eventType: EventType,
  payload: EventPayload,
  triggeredByUserId: number | null,
): Promise<void> {
  try {
    const userId = triggeredByUserId ?? userRepo.firstUserId();
    if (userId == null) {
      logger.debug('notifications.emit: no user, skipping', { eventType });
      return;
    }

    const cfg = userRepo.getNotifyConfig(userId);
    if (!cfg) {
      logger.debug('notifications.emit: no config row', { eventType, userId });
      return;
    }
    if (!cfg.notify_events.includes(eventType)) {
      logger.debug('notifications.emit: event disabled in config', { eventType, userId });
      return;
    }

    const tg = userRepo.getTelegramConfig(userId);
    if (!tg || !tg.chat_id || !tg.bot_token) {
      logger.debug('notifications.emit: telegram not configured', { eventType, userId });
      return;
    }

    const invoice = invoiceRepo.getById(payload.invoice_id);
    if (!invoice) {
      logger.debug('notifications.emit: invoice not found', { invoiceId: payload.invoice_id });
      return;
    }

    await sendInvoiceNotification(
      { token: tg.bot_token, chat_id: tg.chat_id },
      invoice,
      eventType,
      payload,
    );
  } catch (err) {
    // Defensive: emit() must never throw. Even if the DB is locked or
    // userRepo blows up, the main pipeline continues.
    logger.error('notifications.emit: unexpected error', {
      eventType,
      error: (err as Error).message,
    });
  }
}
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

Expected: 0 errors. Existing imports of `URGENT_EVENT_TYPES` from `./types` may break if some other file imports that — check via:

```bash
grep -rn "URGENT_EVENT_TYPES" src/ tests/
```

Expected: only `src/notifications/types.ts` (definition), `src/notifications/telegram/telegramNotifier.ts` (use). Old usage in `events.ts` is gone.

- [ ] **Step 4: Commit**

```bash
git add src/notifications/events.ts
git commit -m "refactor(notifications): route events through Telegram instead of email"
```

---

## Task 10: Update events.test.ts under new channel

**Files:**
- Modify: `tests/notifications/events.test.ts`

- [ ] **Step 1: Заменить содержимое теста под Telegram**

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/database/repositories/userRepo', () => ({
  userRepo: {
    firstUserId: vi.fn(() => 1),
    getNotifyConfig: vi.fn(),
    getTelegramConfig: vi.fn(),
  },
}));

vi.mock('../../src/database/repositories/invoiceRepo', () => ({
  invoiceRepo: {
    getById: vi.fn(),
  },
}));

vi.mock('../../src/notifications/telegram/telegramNotifier', () => ({
  sendInvoiceNotification: vi.fn(async () => {}),
}));

import { emit } from '../../src/notifications/events';
import { userRepo } from '../../src/database/repositories/userRepo';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';
import { sendInvoiceNotification } from '../../src/notifications/telegram/telegramNotifier';

const ALL_EVENTS = [
  'photo_uploaded',
  'invoice_recognized',
  'recognition_error',
  'suspicious_total',
  'invoice_edited',
  'approved_for_1c',
  'sent_to_1c',
] as const;

const samplePayload = { invoice_id: 1, invoice_number: '85', supplier: 'X', total_sum: 1000 };
const sampleInvoice = { id: 1, status: 'processed', telegram_message_id: null } as any;

describe('emit()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips when event is disabled in notify_events', async () => {
    (userRepo.getNotifyConfig as any).mockReturnValue({
      email: null, notify_mode: 'realtime',
      notify_events: ['sent_to_1c'], // photo_uploaded NOT in
    });
    (userRepo.getTelegramConfig as any).mockReturnValue({ chat_id: 'c', bot_token: 't' });
    (invoiceRepo.getById as any).mockReturnValue(sampleInvoice);

    await emit('photo_uploaded', samplePayload, 1);
    expect(sendInvoiceNotification).not.toHaveBeenCalled();
  });

  it('skips when telegram not configured (no chat_id)', async () => {
    (userRepo.getNotifyConfig as any).mockReturnValue({
      email: null, notify_mode: 'realtime', notify_events: ALL_EVENTS,
    });
    (userRepo.getTelegramConfig as any).mockReturnValue({ chat_id: null, bot_token: 't' });
    await emit('photo_uploaded', samplePayload, 1);
    expect(sendInvoiceNotification).not.toHaveBeenCalled();
  });

  it('skips when telegram not configured (no bot_token)', async () => {
    (userRepo.getNotifyConfig as any).mockReturnValue({
      email: null, notify_mode: 'realtime', notify_events: ALL_EVENTS,
    });
    (userRepo.getTelegramConfig as any).mockReturnValue({ chat_id: 'c', bot_token: null });
    await emit('photo_uploaded', samplePayload, 1);
    expect(sendInvoiceNotification).not.toHaveBeenCalled();
  });

  it('skips when invoice not found in DB', async () => {
    (userRepo.getNotifyConfig as any).mockReturnValue({
      email: null, notify_mode: 'realtime', notify_events: ALL_EVENTS,
    });
    (userRepo.getTelegramConfig as any).mockReturnValue({ chat_id: 'c', bot_token: 't' });
    (invoiceRepo.getById as any).mockReturnValue(undefined);

    await emit('photo_uploaded', samplePayload, 1);
    expect(sendInvoiceNotification).not.toHaveBeenCalled();
  });

  it('routes to Telegram when fully configured', async () => {
    (userRepo.getNotifyConfig as any).mockReturnValue({
      email: null, notify_mode: 'realtime', notify_events: ALL_EVENTS,
    });
    (userRepo.getTelegramConfig as any).mockReturnValue({ chat_id: 'c', bot_token: 't' });
    (invoiceRepo.getById as any).mockReturnValue(sampleInvoice);

    await emit('invoice_recognized', samplePayload, 1);
    expect(sendInvoiceNotification).toHaveBeenCalledOnce();
    const callArgs = (sendInvoiceNotification as any).mock.calls[0];
    expect(callArgs[0]).toEqual({ token: 't', chat_id: 'c' });
    expect(callArgs[1]).toBe(sampleInvoice);
    expect(callArgs[2]).toBe('invoice_recognized');
  });

  it('falls back to firstUserId when triggeredByUserId is null', async () => {
    (userRepo.firstUserId as any).mockReturnValue(42);
    (userRepo.getNotifyConfig as any).mockReturnValue({
      email: null, notify_mode: 'realtime', notify_events: ALL_EVENTS,
    });
    (userRepo.getTelegramConfig as any).mockReturnValue({ chat_id: 'c', bot_token: 't' });
    (invoiceRepo.getById as any).mockReturnValue(sampleInvoice);

    await emit('photo_uploaded', samplePayload, null);
    expect(userRepo.firstUserId).toHaveBeenCalled();
    expect(userRepo.getNotifyConfig).toHaveBeenCalledWith(42);
    expect(userRepo.getTelegramConfig).toHaveBeenCalledWith(42);
  });

  it('does not throw if telegramNotifier rejects', async () => {
    (userRepo.getNotifyConfig as any).mockReturnValue({
      email: null, notify_mode: 'realtime', notify_events: ALL_EVENTS,
    });
    (userRepo.getTelegramConfig as any).mockReturnValue({ chat_id: 'c', bot_token: 't' });
    (invoiceRepo.getById as any).mockReturnValue(sampleInvoice);
    (sendInvoiceNotification as any).mockRejectedValueOnce(new Error('boom'));

    await expect(emit('photo_uploaded', samplePayload, 1)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run tests/notifications/events.test.ts
```

Expected: 7 tests passing.

- [ ] **Step 3: Commit**

```bash
git add tests/notifications/events.test.ts
git commit -m "test(notifications): events routed via Telegram (replaces email-mode test)"
```

---

## Task 11: API — расширить /api/profile под Telegram

**Files:**
- Modify: `src/api/routes/profile.ts`

- [ ] **Step 1: Заменить содержимое profile.ts**

```typescript
import { Router, Request, Response } from 'express';
import { userRepo } from '../../database/repositories/userRepo';
import { sendNotification, smtpConfigured } from '../../utils/mailer';
import { sendMessage } from '../../notifications/telegram/telegramClient';
import { ALL_NOTIFY_MODES, ALL_EVENT_TYPES, type NotifyMode, type EventType } from '../../notifications/types';
import { logger } from '../../utils/logger';

const router = Router();

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Telegram chat_id: digits, possibly negative (group chats); for our private
// chat usage it's a positive integer string. Accept either form to be lenient.
const CHAT_ID_RX = /^-?\d+$/;
// Telegram bot token shape: <bot_id>:<35-char-secret>. Examples differ in
// length, so we just check the basic shape <digits>:<at-least-30-chars>.
const BOT_TOKEN_RX = /^\d+:[A-Za-z0-9_-]{30,}$/;

router.get('/', (req: Request, res: Response) => {
  if (!req.user) { res.status(401).json({ error: 'Not authenticated' }); return; }

  const cfg = userRepo.getNotifyConfig(req.user.id);
  if (!cfg) { res.status(404).json({ error: 'User config not found' }); return; }

  const tg = userRepo.getTelegramConfig(req.user.id);

  res.json({
    data: {
      // Legacy email fields — kept in API for back-compat. UI ignores them.
      email: cfg.email,
      notify_mode: cfg.notify_mode,
      smtp_configured: smtpConfigured(),
      // Active fields
      notify_events: cfg.notify_events,
      telegram_chat_id: tg?.chat_id ?? null,
      telegram_bot_token_set: !!tg?.bot_token,
    },
  });
});

router.patch('/', (req: Request, res: Response) => {
  if (!req.user) { res.status(401).json({ error: 'Not authenticated' }); return; }
  const { email, notify_mode, notify_events, telegram_chat_id, telegram_bot_token } = req.body ?? {};

  const userUpdate: Record<string, unknown> = {};
  const tgUpdate: { chat_id?: string | null; bot_token?: string | null } = {};

  if (email !== undefined) {
    if (email !== null && (typeof email !== 'string' || !EMAIL_RX.test(email))) {
      res.status(400).json({ error: 'Invalid email' }); return;
    }
    userUpdate.email = email;
  }
  if (notify_mode !== undefined) {
    if (!ALL_NOTIFY_MODES.includes(notify_mode as NotifyMode)) {
      res.status(400).json({ error: `notify_mode must be one of: ${ALL_NOTIFY_MODES.join(', ')}` }); return;
    }
    userUpdate.notify_mode = notify_mode;
  }
  if (notify_events !== undefined) {
    if (!Array.isArray(notify_events)) { res.status(400).json({ error: 'notify_events must be an array' }); return; }
    for (const e of notify_events) {
      if (!ALL_EVENT_TYPES.includes(e as EventType)) {
        res.status(400).json({ error: `Unknown event type: ${e}` }); return;
      }
    }
    userUpdate.notify_events = notify_events;
  }
  if (telegram_chat_id !== undefined) {
    if (telegram_chat_id !== null && (typeof telegram_chat_id !== 'string' || !CHAT_ID_RX.test(telegram_chat_id))) {
      res.status(400).json({ error: 'telegram_chat_id must be a numeric string or null' }); return;
    }
    tgUpdate.chat_id = telegram_chat_id;
  }
  if (telegram_bot_token !== undefined) {
    if (telegram_bot_token !== null && (typeof telegram_bot_token !== 'string' || !BOT_TOKEN_RX.test(telegram_bot_token))) {
      res.status(400).json({ error: 'telegram_bot_token must match bot id:secret format' }); return;
    }
    tgUpdate.bot_token = telegram_bot_token;
  }

  const hasUserUpdates = Object.keys(userUpdate).length > 0;
  const hasTgUpdates = Object.keys(tgUpdate).length > 0;

  if (!hasUserUpdates && !hasTgUpdates) {
    res.status(400).json({ error: 'No fields to update' }); return;
  }

  if (hasUserUpdates) {
    userRepo.setNotifyConfig(req.user.id, userUpdate);
  }
  if (hasTgUpdates) {
    userRepo.setTelegramConfig(req.user.id, tgUpdate);
  }

  // Return fresh state (same shape as GET)
  const cfg = userRepo.getNotifyConfig(req.user.id);
  const tg = userRepo.getTelegramConfig(req.user.id);
  res.json({
    data: {
      email: cfg?.email ?? null,
      notify_mode: cfg?.notify_mode ?? 'digest_hourly',
      notify_events: cfg?.notify_events ?? [],
      smtp_configured: smtpConfigured(),
      telegram_chat_id: tg?.chat_id ?? null,
      telegram_bot_token_set: !!tg?.bot_token,
    },
  });
});

// Legacy: kept for back-compat. Sends a test email if SMTP is set up. UI no
// longer surfaces this — Telegram replaced email — but the endpoint stays
// alive so older bookmarks / scripts don't 404.
router.post('/test-email', async (req: Request, res: Response) => {
  if (!req.user) { res.status(401).json({ error: 'Not authenticated' }); return; }
  const cfg = userRepo.getNotifyConfig(req.user.id);
  if (!cfg?.email) { res.status(400).json({ error: 'No email configured' }); return; }
  if (!smtpConfigured()) { res.status(503).json({ error: 'SMTP not configured on server' }); return; }
  try {
    await sendNotification(
      cfg.email,
      'Тестовое письмо',
      `<p>Это тестовое письмо от ScanFlow на адрес <b>${cfg.email}</b>.</p>`,
    );
    res.json({ data: { ok: true } });
  } catch (err) {
    logger.warn('test-email failed', { error: (err as Error).message });
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/test-telegram', async (req: Request, res: Response) => {
  if (!req.user) { res.status(401).json({ error: 'Not authenticated' }); return; }
  const tg = userRepo.getTelegramConfig(req.user.id);
  if (!tg?.chat_id || !tg?.bot_token) {
    res.status(400).json({ error: 'Telegram not configured (chat_id and bot_token required)' });
    return;
  }
  try {
    await sendMessage(
      tg.bot_token,
      tg.chat_id,
      '🧪 Тестовое сообщение от ScanFlow.\n\nЕсли вы это видите — настройка Telegram-уведомлений работает.',
    );
    res.json({ data: { ok: true } });
  } catch (err) {
    logger.warn('test-telegram failed', { error: (err as Error).message });
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/api/routes/profile.ts
git commit -m "feat(api): /api/profile — telegram fields + /test-telegram endpoint"
```

---

## Task 12: Update profile.test.ts

**Files:**
- Modify: `tests/api/profile.test.ts`

- [ ] **Step 1: Заменить содержимое теста**

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

let memEmail: string | null = 'test@example.com';
let memMode = 'digest_hourly';
let memEvents = ['photo_uploaded'];
let memTgChat: string | null = null;
let memTgToken: string | null = null;

vi.mock('../../src/database/repositories/userRepo', () => ({
  userRepo: {
    getNotifyConfig: vi.fn(() => ({
      email: memEmail,
      notify_mode: memMode,
      notify_events: memEvents,
    })),
    setNotifyConfig: vi.fn((_id, cfg) => {
      if ('email' in cfg) memEmail = cfg.email;
      if ('notify_mode' in cfg) memMode = cfg.notify_mode;
      if ('notify_events' in cfg) memEvents = cfg.notify_events;
    }),
    getTelegramConfig: vi.fn(() => ({ chat_id: memTgChat, bot_token: memTgToken })),
    setTelegramConfig: vi.fn((_id, cfg) => {
      if ('chat_id' in cfg) memTgChat = cfg.chat_id;
      if ('bot_token' in cfg) memTgToken = cfg.bot_token;
    }),
  },
}));

vi.mock('../../src/utils/mailer', () => ({
  sendNotification: vi.fn(async () => {}),
  smtpConfigured: vi.fn(() => true),
}));

vi.mock('../../src/notifications/telegram/telegramClient', () => ({
  sendMessage: vi.fn(async () => 999),
  editMessageText: vi.fn(async () => {}),
  MessageGoneError: class MessageGoneError extends Error {},
}));

import profileRouter from '../../src/api/routes/profile';
import { sendMessage } from '../../src/notifications/telegram/telegramClient';

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 1, username: 'admin', role: 'admin' };
    next();
  });
  app.use('/api/profile', profileRouter);
  return app;
}

const VALID_TOKEN = '12345:ABCDEFGHIJKLMNOPQRSTUVWXYZ_-abcdef123';

describe('GET /api/profile', () => {
  beforeEach(() => {
    memEmail = 'test@example.com';
    memMode = 'digest_hourly';
    memEvents = ['photo_uploaded'];
    memTgChat = '111';
    memTgToken = VALID_TOKEN;
    vi.clearAllMocks();
  });

  it('returns telegram fields without exposing the bot token', async () => {
    const res = await request(makeApp()).get('/api/profile');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      telegram_chat_id: '111',
      telegram_bot_token_set: true,
    });
    expect(res.body.data.telegram_bot_token).toBeUndefined();
  });

  it('reports telegram_bot_token_set: false when token absent', async () => {
    memTgToken = null;
    const res = await request(makeApp()).get('/api/profile');
    expect(res.body.data.telegram_bot_token_set).toBe(false);
  });
});

describe('PATCH /api/profile (Telegram fields)', () => {
  beforeEach(() => {
    memTgChat = null;
    memTgToken = null;
    vi.clearAllMocks();
  });

  it('saves valid chat_id and token', async () => {
    const res = await request(makeApp())
      .patch('/api/profile')
      .send({ telegram_chat_id: '123456', telegram_bot_token: VALID_TOKEN });
    expect(res.status).toBe(200);
    expect(memTgChat).toBe('123456');
    expect(memTgToken).toBe(VALID_TOKEN);
  });

  it('accepts negative chat_id (group chat shape)', async () => {
    const res = await request(makeApp()).patch('/api/profile').send({ telegram_chat_id: '-1001234567' });
    expect(res.status).toBe(200);
  });

  it('rejects non-numeric chat_id', async () => {
    const res = await request(makeApp()).patch('/api/profile').send({ telegram_chat_id: 'not-a-number' });
    expect(res.status).toBe(400);
  });

  it('rejects malformed bot token', async () => {
    const res = await request(makeApp()).patch('/api/profile').send({ telegram_bot_token: 'garbage' });
    expect(res.status).toBe(400);
  });

  it('allows clearing telegram fields with null', async () => {
    memTgChat = '111';
    memTgToken = VALID_TOKEN;
    const res = await request(makeApp()).patch('/api/profile').send({
      telegram_chat_id: null,
      telegram_bot_token: null,
    });
    expect(res.status).toBe(200);
    expect(memTgChat).toBeNull();
    expect(memTgToken).toBeNull();
  });
});

describe('POST /api/profile/test-telegram', () => {
  beforeEach(() => {
    memTgChat = '111';
    memTgToken = VALID_TOKEN;
    vi.clearAllMocks();
  });

  it('sends test message when configured', async () => {
    const res = await request(makeApp()).post('/api/profile/test-telegram');
    expect(res.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it('refuses if chat_id missing', async () => {
    memTgChat = null;
    const res = await request(makeApp()).post('/api/profile/test-telegram');
    expect(res.status).toBe(400);
  });

  it('refuses if bot_token missing', async () => {
    memTgToken = null;
    const res = await request(makeApp()).post('/api/profile/test-telegram');
    expect(res.status).toBe(400);
  });

  it('returns 500 with details when Telegram rejects token', async () => {
    (sendMessage as any).mockRejectedValueOnce(new Error('Telegram API: 401 Unauthorized'));
    const res = await request(makeApp()).post('/api/profile/test-telegram');
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('Unauthorized');
  });
});

// Sanity check: the legacy /test-email endpoint still works (back-compat).
describe('POST /api/profile/test-email (legacy)', () => {
  beforeEach(() => {
    memEmail = 'test@example.com';
    vi.clearAllMocks();
  });
  it('still sends email when SMTP configured', async () => {
    const res = await request(makeApp()).post('/api/profile/test-email');
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run tests/api/profile.test.ts
```

Expected: 12 tests passing.

- [ ] **Step 3: Commit**

```bash
git add tests/api/profile.test.ts
git commit -m "test(api): /api/profile telegram fields + test-telegram"
```

---

## Task 13: UI — переделать секцию Профиль под Telegram

**Files:**
- Modify: `public/app.html` (section `view-profile`)
- Modify: `public/js/profile.js`

- [ ] **Step 1: Прочитать существующую секцию view-profile**

```bash
grep -n "view-profile" public/app.html
sed -n '475,580p' public/app.html
```

Найти границы секции `<section id="view-profile">...</section>`.

- [ ] **Step 2: Заменить секцию view-profile**

В `public/app.html` найти `<section id="view-profile">` и заменить **всё внутри** этого тега (но оставить сам открывающий и закрывающий тег) на:

```html
<section id="view-profile">
  <div class="section-header">
    <h2>Профиль</h2>
  </div>

  <fieldset class="profile-fieldset">
    <legend>Telegram-уведомления</legend>

    <div class="profile-field">
      <label for="profile-tg-chat">Chat ID</label>
      <input type="text" id="profile-tg-chat" placeholder="123456789">
    </div>

    <div class="profile-field">
      <label for="profile-tg-token">Bot Token</label>
      <input type="password" id="profile-tg-token" placeholder="••••••••">
      <button type="button" id="profile-tg-token-toggle" class="btn btn-small">Показать</button>
    </div>

    <details class="profile-help">
      <summary>Как получить Chat ID и Bot Token</summary>
      <ol>
        <li>В Telegram найди бота <b>@BotFather</b>, напиши <code>/newbot</code>, дай имя боту → получишь токен вида <code>123456789:ABC...</code>.</li>
        <li>Найди своего бота по имени, напиши ему любое сообщение «привет».</li>
        <li>Открой в браузере <code>https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</code> (заменив <code>&lt;TOKEN&gt;</code>) — найди в JSON поле <code>"chat":{"id":123456789}</code>.</li>
        <li>Вставь токен и chat ID сюда, нажми «Сохранить», затем «Отправить тестовое сообщение».</li>
      </ol>
    </details>
  </fieldset>

  <fieldset class="profile-fieldset">
    <legend>Какие события присылать</legend>
    <label><input type="checkbox" data-event="photo_uploaded"> Фото загружено</label>
    <label><input type="checkbox" data-event="invoice_recognized"> Накладная распознана</label>
    <label><input type="checkbox" data-event="recognition_error"> Ошибка распознавания (срочно)</label>
    <label><input type="checkbox" data-event="suspicious_total"> Подозрительная сумма (срочно)</label>
    <label><input type="checkbox" data-event="invoice_edited"> Правка в дашборде</label>
    <label><input type="checkbox" data-event="approved_for_1c"> Утверждена для 1С</label>
    <label><input type="checkbox" data-event="sent_to_1c"> Отправлена в 1С</label>
  </fieldset>

  <div class="profile-actions">
    <button type="button" id="profile-save" class="btn btn-primary">Сохранить</button>
    <button type="button" id="profile-test" class="btn">Отправить тестовое сообщение</button>
    <span id="profile-status"></span>
  </div>
</section>
```

- [ ] **Step 3: Заменить profile.js**

```javascript
(function () {
  const TOKEN_PLACEHOLDER = '••••••••';
  let tokenSetOnServer = false;

  const Profile = {
    async load() {
      const r = await App.api('GET', '/api/profile');
      const data = r.data || {};

      document.getElementById('profile-tg-chat').value = data.telegram_chat_id || '';

      tokenSetOnServer = !!data.telegram_bot_token_set;
      const tokenEl = document.getElementById('profile-tg-token');
      tokenEl.value = tokenSetOnServer ? TOKEN_PLACEHOLDER : '';
      tokenEl.type = 'password';
      document.getElementById('profile-tg-token-toggle').textContent = 'Показать';

      const enabled = new Set(data.notify_events || []);
      document.querySelectorAll('input[type=checkbox][data-event]').forEach(cb => {
        cb.checked = enabled.has(cb.dataset.event);
      });
    },

    collect() {
      const chat = document.getElementById('profile-tg-chat').value.trim() || null;
      const tokenInputValue = document.getElementById('profile-tg-token').value;
      // Don't overwrite if user didn't change the placeholder
      const sendToken = tokenInputValue !== TOKEN_PLACEHOLDER;

      const events = Array.from(
        document.querySelectorAll('input[type=checkbox][data-event]:checked'),
      ).map(cb => cb.dataset.event);

      const body = { telegram_chat_id: chat, notify_events: events };
      if (sendToken) body.telegram_bot_token = tokenInputValue || null;
      return body;
    },

    async save() {
      const status = document.getElementById('profile-status');
      try {
        await App.api('PATCH', '/api/profile', this.collect());
        status.textContent = 'Сохранено';
        status.style.color = '#16a34a';
        // Re-load so token UI returns to placeholder
        await this.load();
      } catch (err) {
        status.textContent = 'Ошибка: ' + (err.message || err);
        status.style.color = '#b91c1c';
      }
      setTimeout(() => { status.textContent = ''; }, 3000);
    },

    async test() {
      const status = document.getElementById('profile-status');
      status.textContent = 'Отправляем тестовое сообщение…';
      status.style.color = '';
      try {
        await App.api('POST', '/api/profile/test-telegram');
        status.textContent = 'Тестовое сообщение отправлено — проверьте Telegram';
        status.style.color = '#16a34a';
      } catch (err) {
        status.textContent = 'Не удалось: ' + (err.message || err);
        status.style.color = '#b91c1c';
      }
    },

    toggleTokenVisibility() {
      const tokenEl = document.getElementById('profile-tg-token');
      const btn = document.getElementById('profile-tg-token-toggle');
      if (tokenEl.type === 'password') {
        tokenEl.type = 'text';
        btn.textContent = 'Скрыть';
      } else {
        tokenEl.type = 'password';
        btn.textContent = 'Показать';
      }
    },

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
  };

  window.Profile = Profile;
})();
```

- [ ] **Step 4: Smoke test in browser (manual, optional)**

```bash
npm run dev
```

Открыть http://localhost:8899/ → залогиниться → «Профиль». Проверить визуально:
- Chat ID и Bot Token поля видны
- Кнопка «Показать/Скрыть» для токена работает
- Чекбоксы 7 эвентов видны
- Кнопки «Сохранить» и «Отправить тестовое сообщение» работают (в смысле UI; реальная отправка упадёт пока токен неверный)

Остановить dev-сервер.

- [ ] **Step 5: Commit**

```bash
git add public/app.html public/js/profile.js
git commit -m "feat(ui): профиль — Telegram (chat_id + bot_token + инструкция)"
```

---

## Task 14: Документация — CLAUDE.md и .env.example

**Files:**
- Modify: `CLAUDE.md`
- Modify: `.env.example`

- [ ] **Step 1: Найти раздел «Уведомления» в CLAUDE.md**

```bash
grep -n "## Уведомления" CLAUDE.md
```

Раздел существует (создан предыдущей фичей). Заменить его содержимое целиком.

- [ ] **Step 2: Переписать раздел «Уведомления» в CLAUDE.md**

Найти `## Уведомления пользователю на email` и **заменить весь раздел** (от заголовка до `---` перед следующим разделом) на:

```markdown
## Уведомления пользователю в Telegram

**Файлы:**
- [`src/notifications/events.ts`](src/notifications/events.ts) — `emit(eventType, payload, userId)` точка эмиссии
- [`src/notifications/telegram/telegramClient.ts`](src/notifications/telegram/telegramClient.ts) — wrapper над Telegram Bot API (`sendMessage`, `editMessageText`)
- [`src/notifications/telegram/telegramFormatter.ts`](src/notifications/telegram/telegramFormatter.ts) — форматирование текста (thread + urgent)
- [`src/notifications/telegram/telegramNotifier.ts`](src/notifications/telegram/telegramNotifier.ts) — высокоуровневый эмиттер (thread edit + fallback)
- [`src/api/routes/profile.ts`](src/api/routes/profile.ts) — `GET/PATCH /api/profile`, `POST /api/profile/test-telegram`
- В дашборде: вкладка «Профиль» → секция «Telegram-уведомления»

### Модель

- **Канал:** Telegram (private chat между ботом и пользователем).
- **Один thread на накладную:** при первом эвенте отправляется новое сообщение, его `message_id` сохраняется в `invoices.telegram_message_id`. Все последующие эвенты этой накладной — `editMessageText` того же сообщения. Сообщение растёт чек-листом: загружена → распознана → утверждена → отправлена в 1С.
- **Срочные эвенты** (`recognition_error`, `suspicious_total`) — отдельные standalone-сообщения, не редактируют thread (чтобы push-нотификация Telegram сработала).
- **Конфигурация:** в `users.telegram_chat_id` и `users.telegram_bot_token` (миграция 19), плюс `users.notify_events` (включённые типы эвентов).

### emit()

`emit(eventType, payload, triggeredByUserId)` никогда не бросает. Если `triggeredByUserId` null — берётся `userRepo.firstUserId()`. Если у юзера нет `telegram_chat_id` или `telegram_bot_token`, или эвент не в `notify_events`, или накладная по `payload.invoice_id` не найдена — return без сайд-эффекта.

### Точки эмиссии (не менялись)

- `fileWatcher.ts` → `photo_uploaded`, `invoice_recognized`, `recognition_error`, `suspicious_total`
- `api/routes/invoices.ts` → `invoice_edited`, `approved_for_1c`, `sent_to_1c`
- `integration/webhook.ts` → `sent_to_1c`

### Email — dead code

Email-инфраструктура осталась в репо как dead code на случай возврата:
- `src/utils/mailer.ts` (sendNotification, smtpConfigured) — работает, но никем не вызывается из эмиттера.
- `src/notifications/templates.ts` (HTML email-шаблоны) — не вызывается.
- `src/notifications/digestWorker.ts` — cron жив, но `notification_events` пуста, и tick'и завершаются мгновенно.
- Таблица `notification_events` остаётся.
- Endpoint `POST /api/profile/test-email` остаётся для back-compat.

`SMTP_*` env-переменные больше не нужны для пользовательских уведомлений. Они всё ещё используются для системных писем (`uncaughtException`, `diskMonitor`) — это оставлено как было.

### Edge case: thread message gone

Если Telegram возвращает на `editMessageText` 400 «message to edit not found» — клиент кидает `MessageGoneError`. Notifier ловит → шлёт `sendMessage` → обновляет `telegram_message_id`. Старое сообщение — потеряно. Не критично.

### Безопасность

- `bot_token` хранится в БД в открытом виде (как `users.api_key`). Шифровать не будем.
- `GET /api/profile` возвращает только `telegram_bot_token_set: boolean`, не сам токен. UI заполняет поле плейсхолдером.
- При `PATCH /api/profile` если поле `telegram_bot_token` совпадает с плейсхолдером (фронт это делает не отправляя ключ при не-измененном поле) — `bot_token` в БД не трогается.

```

- [ ] **Step 3: Обновить .env.example**

В `.env.example` найти секцию `# Email (SMTP)` и заменить комментарий:

```
# =============================================================================
# Email (SMTP) — ОПЦИОНАЛЬНО
# =============================================================================
# Используется ТОЛЬКО для системных писем (uncaughtException, диск-монитор).
# Для пользовательских уведомлений используется Telegram (см. /api/profile в
# дашборде). Если SMTP_* пусты — системные письма не идут (но программа
# работает нормально). MAIL_TO — fallback-адрес для системных писем.
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
MAIL_TO=
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md .env.example
git commit -m "docs: Telegram replaces email for user notifications"
```

---

## Task 15: Финальный smoke test

**Files:** (нет правок, только верификация)

- [ ] **Step 1: Прогнать все тесты**

```bash
npx vitest run
```

Expected: все тесты PASS, в том числе новые/изменённые: `tests/notifications/telegram/*.test.ts` (3 файла), `tests/notifications/events.test.ts` (изменён), `tests/api/profile.test.ts` (изменён).

Ожидаемое количество тестов: **127** (baseline) **−** 8 events.test.ts старых **+** 7 новых events tests **−** 10 profile.test.ts старых **+** 12 новых profile tests **+** 6 telegramClient + 10 telegramFormatter + 8 telegramNotifier = **127 + 25 = ~152 теста**. Точное число можно проверить, главное — все проходят.

- [ ] **Step 2: Полная проверка типов**

```bash
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 3: Запустить dev-сервер и проверить миграцию**

```bash
npm run dev
```

В логах должно быть:
- `Running database migrations...`
- `migration 19 applied` (или эквивалент)

Зайти в дашборд → «Профиль» → секция «Telegram-уведомления» → видны два поля + 7 чекбоксов. Email-полей быть не должно.

Остановить dev-сервер.

- [ ] **Step 4: (Опционально) PR**

Если работаем через PR:

```bash
gh pr create --title "Telegram notifications replacing email channel" --body "$(cat <<'EOF'
## Summary
- 7 доменных событий → Telegram (private chat бот ↔ пользователь)
- Один thread на накладную (sendMessage первый раз, editMessageText далее)
- Срочные (recognition_error, suspicious_total) — отдельными сообщениями
- UI «Профиль» переделан: chat_id + bot_token + инструкция
- Email-инфраструктура остаётся как dead code

См. spec: `docs/superpowers/specs/2026-04-30-telegram-notifications-design.md`

## Test plan
- [ ] Прогнать `npx vitest run` — все green
- [ ] В дашборде → «Профиль» → ввести chat_id + bot_token → «Сохранить» → «Отправить тестовое сообщение» → пришло
- [ ] Загрузить накладную → пришло уведомление в Telegram, при следующем шаге обновилось то же сообщение
- [ ] Удалить сообщение в Telegram → следующий эвент создаёт новое сообщение
- [ ] Заскриптовать ошибку (неправильный API-ключ Claude) → пришло отдельное urgent-сообщение
EOF
)"
```

---

## Self-review

Прохожу спек по разделам:

- ✅ **Не-цели** — email-код остаётся (Tasks не удаляют mailer/templates/digestWorker), `notify_mode` оставлен в БД (миграция 19 не трогает). Дайджест-режимы в Telegram не реализуются (Task 7 шлёт всё в realtime). Двусторонний бот, multi-bot, групповые чаты — не реализуются.
- ✅ **Концепция thread на накладную** — Task 7 (`sendInvoiceNotification`) реализует именно это.
- ✅ **Срочные = отдельные сообщения** — Task 7, отдельная ветка для `URGENT_EVENT_TYPES`.
- ✅ **Multi-page** — `invoiceRepo.getById` возвращает накладную с правильным `telegram_message_id` независимо от того, сколько раз `findRecentByNumber` мерджил страницы.
- ✅ **Миграция 19** — Task 1.
- ✅ **userRepo / invoiceRepo расширения** — Task 2.
- ✅ **`telegramClient.ts`** — Task 3, тесты Task 4.
- ✅ **`telegramFormatter.ts`** — Task 5, тесты Task 6.
- ✅ **`telegramNotifier.ts`** — Task 7, тесты Task 8.
- ✅ **events.ts подмена канала** — Task 9, тесты Task 10.
- ✅ **API /api/profile расширение** — Task 11, тесты Task 12.
- ✅ **UI** — Task 13.
- ✅ **Документация** — Task 14.
- ✅ **Безопасность** — bot_token не возвращается в `GET`, поле password в UI, плейсхолдер при загрузке (Task 13 + 11).
- ✅ **Edge case MessageGoneError** — Task 4 (тест) + Task 7 (код) + Task 8 (тест).

**Placeholder scan:** «similar to» / «TBD» — не использую.

**Type consistency:**
- `MessageGoneError` — определён в Task 3, экспортируется и используется в Tasks 4, 7, 8, 12.
- `EventState` — определён в Task 5, используется в Task 7 через `deriveEventState`.
- `getTelegramConfig`/`setTelegramConfig` — Task 2 определяет, Tasks 9, 11 используют. Возвращаемая форма `{ chat_id, bot_token }` совпадает.
- `getTelegramMessageId`/`setTelegramMessageId` — Task 2, используется в Task 7.
- `sendInvoiceNotification` — Task 7 определяет сигнатуру `(cfg, invoice, eventType, payload)`, Task 9 вызывает с этой же сигнатурой, Task 10 проверяет.

Всё согласовано.

**Scope check:** одна логическая фича (~15 задач, 30-60 минут). Размер хорош.
