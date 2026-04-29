# User Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Доставлять админу-владельцу email-уведомления о 7 доменных событиях (загрузка фото, распознавание, ошибки, правки, апрув, отправка в 1С) с настройкой режима (realtime / hourly digest / daily digest) и набора включённых событий.

**Architecture:** Отдельный модуль `src/notifications/` с тремя файлами: `events.ts` (точка эмиссии), `digestWorker.ts` (cron-джоб для дайджестов), `templates.ts` (HTML-рендер). Хранение конфигурации — три новых колонки в `users`. Очередь дайджеста — новая таблица `notification_events`. Точки эмиссии добавляются в существующих местах (watcher, route handlers, webhook). Расширение `mailer.ts` функцией `sendNotification(to, subject, html)`. UI — отдельная страница «Профиль» в дашборде.

**Tech Stack:** Node 25 + TypeScript, Express 5, better-sqlite3, nodemailer (уже есть), node-cron (уже используется в `index.ts`), vitest (тесты), vanilla JS для фронта (как остальной дашборд).

**Spec:** `docs/superpowers/specs/2026-04-28-user-notifications-design.md`

---

## File Structure

**Создаются:**
- `src/notifications/events.ts` — `emit(eventType, payload, triggeredByUserId)` точка входа
- `src/notifications/digestWorker.ts` — `startDigestWorker()` стартует cron-джобы
- `src/notifications/templates.ts` — `renderRealtime(eventType, payload)`, `renderDigest(events)`
- `src/notifications/types.ts` — общие типы (`EventType`, `EventPayload`, `NotifyMode`)
- `src/database/repositories/notificationRepo.ts` — CRUD для `notification_events`
- `src/api/routes/profile.ts` — три ручки `GET/PATCH /api/profile`, `POST /api/profile/test-email`
- `public/profile.html` + `public/js/profile.js` — UI «Профиль»
- `tests/notifications/events.test.ts`
- `tests/notifications/digestWorker.test.ts`
- `tests/notifications/templates.test.ts`
- `tests/api/profile.test.ts`

**Изменяются:**
- `src/database/migrations.ts` — добавить миграцию 18
- `src/database/repositories/userRepo.ts` — методы `getNotifyConfig`, `setNotifyConfig`
- `src/utils/mailer.ts` — добавить `sendNotification`
- `src/index.ts` — стартовать `digestWorker`
- `src/api/server.ts` — смонтировать `profileRouter`
- `src/watcher/fileWatcher.ts` — точки эмиссии: `photo_uploaded`, `invoice_recognized`, `recognition_error`, `suspicious_total`
- `src/api/routes/invoices.ts` — точки эмиссии: `invoice_edited` (PATCH item), `approved_for_1c` (POST send), `sent_to_1c` (POST confirm)
- `src/integration/webhook.ts` — точка эмиссии `sent_to_1c` (после `markSent`)
- `public/index.html` — пункт меню «Профиль»
- `public/js/app.js` — навигация на `#profile`
- `.env.example` — комментарий, что SMTP_* нужны для пользовательских уведомлений
- `CLAUDE.md` — раздел «Уведомления»

Каждый файл < 250 строк, одна ответственность. `events.ts` не знает о cron, `digestWorker.ts` не знает о шаблонах напрямую (зовёт `templates.ts`), `templates.ts` чистые функции без БД.

---

## Task 1: Миграция 18 — колонки в `users` + таблица `notification_events`

**Files:**
- Modify: `src/database/migrations.ts:352` (добавить migration 18 в массив)

- [ ] **Step 1: Открыть migrations.ts и добавить migration 18 в конец массива MIGRATIONS**

В файле `src/database/migrations.ts`, найти строку `version: 17,` и закрывающую скобку `};` этого объекта (последний элемент массива). После этого закрывающего `}` добавить новый объект:

```typescript
  {
    version: 18,
    name: 'user notification settings',
    detect: (db) => hasColumn(db, 'users', 'email') && hasTable(db, 'notification_events'),
    run: (db) => {
      const defaultEvents = JSON.stringify([
        'photo_uploaded',
        'invoice_recognized',
        'recognition_error',
        'suspicious_total',
        'invoice_edited',
        'approved_for_1c',
        'sent_to_1c',
      ]);

      if (!hasColumn(db, 'users', 'email')) {
        db.exec(`ALTER TABLE users ADD COLUMN email TEXT;`);
      }
      if (!hasColumn(db, 'users', 'notify_mode')) {
        db.exec(`ALTER TABLE users ADD COLUMN notify_mode TEXT NOT NULL DEFAULT 'digest_hourly';`);
      }
      if (!hasColumn(db, 'users', 'notify_events')) {
        db.exec(`ALTER TABLE users ADD COLUMN notify_events TEXT NOT NULL DEFAULT '${defaultEvents.replace(/'/g, "''")}';`);
      }

      // One-shot: pre-fill email from MAIL_TO env for existing users.
      // After migration, user can change via profile UI.
      const mailTo = (process.env.MAIL_TO || '').trim();
      if (mailTo && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mailTo)) {
        db.prepare('UPDATE users SET email = ? WHERE email IS NULL').run(mailTo);
      }

      if (!hasTable(db, 'notification_events')) {
        db.exec(`
          CREATE TABLE notification_events (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id      INTEGER NOT NULL REFERENCES users(id),
            event_type   TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            created_at   TEXT NOT NULL DEFAULT (datetime('now')),
            sent_at      TEXT
          );
          CREATE INDEX idx_notif_pending ON notification_events(user_id, sent_at);
        `);
      }
    },
  },
```

- [ ] **Step 2: Запустить миграции вручную, убедиться что схема обновилась**

Run:
```bash
cd C:/www/ScanFlow
npm run dev
```

Подождать пока сервер стартанёт (посмотреть в логах `Running database migrations...` и `migration 18 applied`). Затем остановить (Ctrl+C).

Проверить схему:
```bash
node -e "const db = require('better-sqlite3')('./data/database.sqlite', {readonly: true}); console.log(db.prepare(\"PRAGMA table_info(users)\").all().map(r => r.name)); console.log(db.prepare(\"SELECT name FROM sqlite_master WHERE name = 'notification_events'\").all());"
```

Expected: в списке колонок `users` присутствуют `email`, `notify_mode`, `notify_events`. Таблица `notification_events` существует.

- [ ] **Step 3: Commit**

```bash
git add src/database/migrations.ts
git commit -m "feat(db): migration 18 — users notification settings + notification_events table"
```

---

## Task 2: Типы для модуля notifications

**Files:**
- Create: `src/notifications/types.ts`

- [ ] **Step 1: Создать файл типов**

Создать `src/notifications/types.ts`:

```typescript
// All event types this module knows about. Adding a new one requires:
//   1. Add it here
//   2. Add to DEFAULT_EVENTS in migrations.ts (if it should be on by default)
//   3. Add a renderRealtime case in templates.ts
//   4. Add a renderDigest grouping in templates.ts
//   5. Emit it from somewhere
export type EventType =
  | 'photo_uploaded'
  | 'invoice_recognized'
  | 'recognition_error'
  | 'suspicious_total'
  | 'invoice_edited'
  | 'approved_for_1c'
  | 'sent_to_1c';

export const ALL_EVENT_TYPES: readonly EventType[] = [
  'photo_uploaded',
  'invoice_recognized',
  'recognition_error',
  'suspicious_total',
  'invoice_edited',
  'approved_for_1c',
  'sent_to_1c',
] as const;

// Events that bypass digest mode and always send immediately.
export const URGENT_EVENT_TYPES: ReadonlySet<EventType> = new Set([
  'recognition_error',
  'suspicious_total',
]);

export type NotifyMode = 'realtime' | 'digest_hourly' | 'digest_daily';

export const ALL_NOTIFY_MODES: readonly NotifyMode[] = [
  'realtime',
  'digest_hourly',
  'digest_daily',
] as const;

// Carried in the email body. Must be JSON-serializable (goes through DB column).
export interface EventPayload {
  invoice_id: number;
  invoice_number?: string | null;
  supplier?: string | null;
  total_sum?: number | null;
  // Free-form per-event extras (e.g. error_message for recognition_error).
  [k: string]: unknown;
}

export interface NotifyConfig {
  email: string | null;
  notify_mode: NotifyMode;
  notify_events: EventType[];
}
```

- [ ] **Step 2: Проверить компиляцию**

Run: `npx tsc --noEmit`
Expected: 0 ошибок (новый файл компилируется без проблем).

- [ ] **Step 3: Commit**

```bash
git add src/notifications/types.ts
git commit -m "feat(notifications): types for event system"
```

---

## Task 3: Расширить userRepo методами для notify-config

**Files:**
- Modify: `src/database/repositories/userRepo.ts`

- [ ] **Step 1: Прочитать текущий userRepo**

Run: `cat src/database/repositories/userRepo.ts`

Обратить внимание на интерфейс `User` и существующие методы.

- [ ] **Step 2: Расширить интерфейс User новыми колонками**

В `src/database/repositories/userRepo.ts` найти `interface User` и добавить три новых поля. Заменить весь интерфейс на:

```typescript
export interface User {
  id: number;
  username: string;
  password_hash: string;
  api_key: string;
  role: string;
  created_at: string;
  last_login_at: string | null;
  email: string | null;
  notify_mode: string; // narrowed when read via getNotifyConfig
  notify_events: string; // JSON-encoded array; parsed by getNotifyConfig
}
```

- [ ] **Step 3: Добавить getNotifyConfig / setNotifyConfig / firstUser методы**

В конце объекта `userRepo` (перед закрывающей `};`) добавить:

```typescript
  getNotifyConfig(id: number): import('../../notifications/types').NotifyConfig | null {
    const row = getDb()
      .prepare('SELECT email, notify_mode, notify_events FROM users WHERE id = ?')
      .get(id) as { email: string | null; notify_mode: string; notify_events: string } | undefined;
    if (!row) return null;
    let events: import('../../notifications/types').EventType[];
    try {
      const parsed = JSON.parse(row.notify_events);
      events = Array.isArray(parsed) ? parsed : [];
    } catch {
      events = [];
    }
    return {
      email: row.email,
      notify_mode: row.notify_mode as import('../../notifications/types').NotifyMode,
      notify_events: events,
    };
  },

  setNotifyConfig(id: number, cfg: Partial<import('../../notifications/types').NotifyConfig>): void {
    const fields: string[] = [];
    const values: unknown[] = [];
    if (cfg.email !== undefined) {
      fields.push('email = ?');
      values.push(cfg.email);
    }
    if (cfg.notify_mode !== undefined) {
      fields.push('notify_mode = ?');
      values.push(cfg.notify_mode);
    }
    if (cfg.notify_events !== undefined) {
      fields.push('notify_events = ?');
      values.push(JSON.stringify(cfg.notify_events));
    }
    if (fields.length === 0) return;
    values.push(id);
    getDb().prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  },

  // Returns the row id of the first user (lowest id). Used by emit() when no
  // HTTP-context user is available (e.g. fileWatcher background events).
  // For the current single-user setup this is the owner.
  firstUserId(): number | null {
    const row = getDb()
      .prepare('SELECT id FROM users ORDER BY id LIMIT 1')
      .get() as { id: number } | undefined;
    return row?.id ?? null;
  },
```

- [ ] **Step 4: Компиляция**

Run: `npx tsc --noEmit`
Expected: 0 ошибок.

- [ ] **Step 5: Commit**

```bash
git add src/database/repositories/userRepo.ts
git commit -m "feat(userRepo): add getNotifyConfig/setNotifyConfig/firstUserId"
```

---

## Task 4: notificationRepo для очереди дайджеста

**Files:**
- Create: `src/database/repositories/notificationRepo.ts`

- [ ] **Step 1: Создать репозиторий**

Создать `src/database/repositories/notificationRepo.ts`:

```typescript
import { getDb } from '../db';
import type { EventType, EventPayload } from '../../notifications/types';

export interface PendingNotification {
  id: number;
  user_id: number;
  event_type: EventType;
  payload_json: string;
  created_at: string;
  sent_at: string | null;
}

export const notificationRepo = {
  enqueue(userId: number, eventType: EventType, payload: EventPayload): void {
    getDb()
      .prepare(
        `INSERT INTO notification_events (user_id, event_type, payload_json)
         VALUES (?, ?, ?)`,
      )
      .run(userId, eventType, JSON.stringify(payload));
  },

  // Returns rows created at or before `cutoffIso` for the given user that
  // haven't been sent yet. cutoffIso is taken at digest start so events
  // emitted DURING digest send roll into the next batch.
  pendingForUser(userId: number, cutoffIso: string): PendingNotification[] {
    return getDb()
      .prepare(
        `SELECT * FROM notification_events
         WHERE user_id = ? AND sent_at IS NULL AND created_at <= ?
         ORDER BY created_at`,
      )
      .all(userId, cutoffIso) as PendingNotification[];
  },

  markSent(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    getDb()
      .prepare(`UPDATE notification_events SET sent_at = datetime('now') WHERE id IN (${placeholders})`)
      .run(...ids);
  },

  // Cleanup: remove sent rows older than 7 days. Called from digestWorker
  // once a day.
  purgeOldSent(): number {
    const result = getDb()
      .prepare(`DELETE FROM notification_events WHERE sent_at IS NOT NULL AND sent_at < datetime('now', '-7 days')`)
      .run();
    return result.changes;
  },

  // For tests / debug
  countPending(userId: number): number {
    const row = getDb()
      .prepare(`SELECT COUNT(*) as cnt FROM notification_events WHERE user_id = ? AND sent_at IS NULL`)
      .get(userId) as { cnt: number };
    return row.cnt;
  },
};
```

- [ ] **Step 2: Компиляция**

Run: `npx tsc --noEmit`
Expected: 0 ошибок.

- [ ] **Step 3: Commit**

```bash
git add src/database/repositories/notificationRepo.ts
git commit -m "feat(notifications): notificationRepo for pending event queue"
```

---

## Task 5: Расширить mailer.ts функцией sendNotification

**Files:**
- Modify: `src/utils/mailer.ts`

- [ ] **Step 1: Добавить функцию в конец mailer.ts**

В `src/utils/mailer.ts` после функции `sendErrorEmail` (после её закрывающей `}`) добавить:

```typescript
// Send a domain-event notification to a specific recipient. Unlike
// sendErrorEmail, this:
//   - takes the `to` address explicitly (per-user, not global MAIL_TO)
//   - has no rate limit (digest mode handles regulation)
// SMTP must be configured in env. Returns void on success, throws on
// failure so the caller can decide whether to retry/log.
export async function sendNotification(to: string, subject: string, html: string): Promise<void> {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error('SMTP not configured (SMTP_HOST/SMTP_USER/SMTP_PASS missing)');
  }
  if (!to) {
    throw new Error('sendNotification: empty `to` address');
  }
  await transporter.sendMail({
    from: `"ScanFlow" <${SMTP_USER}>`,
    to,
    subject: `[ScanFlow] ${subject}`,
    html,
  });
  logger.info('Notification email sent', { subject, to });
}

// True if the runtime has the SMTP env vars filled in. Used by
// /api/profile to surface an "SMTP not configured on server" hint
// in the UI.
export function smtpConfigured(): boolean {
  return !!(SMTP_HOST && SMTP_USER && SMTP_PASS);
}
```

- [ ] **Step 2: Компиляция**

Run: `npx tsc --noEmit`
Expected: 0 ошибок.

- [ ] **Step 3: Commit**

```bash
git add src/utils/mailer.ts
git commit -m "feat(mailer): add sendNotification + smtpConfigured"
```

---

## Task 6: templates.ts — рендер HTML писем

**Files:**
- Create: `src/notifications/templates.ts`

- [ ] **Step 1: Создать модуль шаблонов**

Создать `src/notifications/templates.ts`:

```typescript
import type { EventType, EventPayload } from './types';

interface RenderedEmail {
  subject: string;
  html: string;
}

const EVENT_LABELS: Record<EventType, string> = {
  photo_uploaded:     'Фото загружено',
  invoice_recognized: 'Накладная распознана',
  recognition_error:  'Ошибка распознавания',
  suspicious_total:   'Подозрительная сумма',
  invoice_edited:     'Накладная отредактирована',
  approved_for_1c:    'Утверждена для 1С',
  sent_to_1c:         'Отправлена в 1С',
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtMoney(n: number | null | undefined): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n) + ' ₽';
}

function invoiceHeaderHtml(p: EventPayload, baseUrl: string): string {
  const num = p.invoice_number ? escapeHtml(String(p.invoice_number)) : `#${p.invoice_id}`;
  const supplier = p.supplier ? escapeHtml(String(p.supplier)) : '—';
  const link = `${baseUrl}/#invoices/${p.invoice_id}`;
  return `
    <p style="margin:0 0 8px"><b>Накладная:</b> <a href="${link}" style="color:#2563eb">№ ${num}</a></p>
    <p style="margin:0 0 8px"><b>Поставщик:</b> ${supplier}</p>
    <p style="margin:0 0 8px"><b>Сумма:</b> ${fmtMoney(p.total_sum as number | null | undefined)}</p>
  `;
}

export function renderRealtime(eventType: EventType, payload: EventPayload, baseUrl = 'https://scanflow.ru'): RenderedEmail {
  const label = EVENT_LABELS[eventType];
  const headerHtml = invoiceHeaderHtml(payload, baseUrl);

  let extra = '';
  if (eventType === 'recognition_error' && payload.error_message) {
    extra = `<p style="margin:8px 0 0;color:#b91c1c"><b>Ошибка:</b> ${escapeHtml(String(payload.error_message))}</p>`;
  }
  if (eventType === 'suspicious_total' && payload.items_total != null) {
    extra = `<p style="margin:8px 0 0;color:#b45309"><b>Сумма строк:</b> ${fmtMoney(payload.items_total as number)} <i>(не сходится с total_sum)</i></p>`;
  }

  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px">
      <h3 style="color:#0f172a;margin:0 0 12px">${label}</h3>
      ${headerHtml}
      ${extra}
      <p style="color:#94a3b8;font-size:12px;margin-top:16px">ScanFlow · ${new Date().toLocaleString('ru-RU')}</p>
    </div>
  `;
  return { subject: label, html };
}

export interface DigestGroup {
  event_type: EventType;
  events: { payload: EventPayload; created_at: string }[];
}

export function renderDigest(groups: DigestGroup[], baseUrl = 'https://scanflow.ru'): RenderedEmail {
  const totalEvents = groups.reduce((acc, g) => acc + g.events.length, 0);
  if (totalEvents === 0) {
    return { subject: 'Дайджест ScanFlow (пусто)', html: '<p>Нет событий за период.</p>' };
  }

  const sectionsHtml = groups.map(g => {
    const rows = g.events.map(ev => {
      const num = ev.payload.invoice_number ? escapeHtml(String(ev.payload.invoice_number)) : `#${ev.payload.invoice_id}`;
      const supplier = ev.payload.supplier ? escapeHtml(String(ev.payload.supplier)) : '—';
      const link = `${baseUrl}/#invoices/${ev.payload.invoice_id}`;
      return `
        <tr>
          <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0"><a href="${link}" style="color:#2563eb">${num}</a></td>
          <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0">${supplier}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;text-align:right">${fmtMoney(ev.payload.total_sum as number | null | undefined)}</td>
        </tr>
      `;
    }).join('');
    return `
      <h4 style="margin:16px 0 8px;color:#0f172a">${EVENT_LABELS[g.event_type]} (${g.events.length})</h4>
      <table style="border-collapse:collapse;width:100%;font-size:14px">
        <thead><tr style="background:#f8fafc"><th style="padding:6px 12px;text-align:left">№</th><th style="padding:6px 12px;text-align:left">Поставщик</th><th style="padding:6px 12px;text-align:right">Сумма</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }).join('');

  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:720px">
      <h2 style="margin:0 0 8px;color:#0f172a">Дайджест ScanFlow</h2>
      <p style="margin:0 0 16px;color:#64748b">Всего событий: ${totalEvents}</p>
      ${sectionsHtml}
      <p style="color:#94a3b8;font-size:12px;margin-top:24px">ScanFlow · ${new Date().toLocaleString('ru-RU')}</p>
    </div>
  `;
  return { subject: `Дайджест (${totalEvents} событий)`, html };
}
```

- [ ] **Step 2: Компиляция**

Run: `npx tsc --noEmit`
Expected: 0 ошибок.

- [ ] **Step 3: Commit**

```bash
git add src/notifications/templates.ts
git commit -m "feat(notifications): HTML email templates (realtime + digest)"
```

---

## Task 7: Тесты для templates.ts

**Files:**
- Create: `tests/notifications/templates.test.ts`

- [ ] **Step 1: Написать тесты**

Создать `tests/notifications/templates.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { renderRealtime, renderDigest } from '../../src/notifications/templates';
import type { EventPayload } from '../../src/notifications/types';

const samplePayload: EventPayload = {
  invoice_id: 1318,
  invoice_number: 'НФНФ-000085',
  supplier: 'ООО "Свит лайф фудсервис"',
  total_sum: 66714.11,
};

describe('renderRealtime', () => {
  it('builds subject and html for photo_uploaded', () => {
    const out = renderRealtime('photo_uploaded', samplePayload);
    expect(out.subject).toBe('Фото загружено');
    expect(out.html).toContain('НФНФ-000085');
    expect(out.html).toContain('66 714,11 ₽');
    expect(out.html).toContain('Свит лайф фудсервис');
  });

  it('escapes HTML in supplier name', () => {
    const out = renderRealtime('photo_uploaded', { ...samplePayload, supplier: '<script>x</script>' });
    expect(out.html).not.toContain('<script>x</script>');
    expect(out.html).toContain('&lt;script&gt;x&lt;/script&gt;');
  });

  it('shows error_message for recognition_error', () => {
    const out = renderRealtime('recognition_error', { ...samplePayload, error_message: 'Claude API timeout' });
    expect(out.html).toContain('Claude API timeout');
  });

  it('handles missing optional fields gracefully', () => {
    const out = renderRealtime('photo_uploaded', { invoice_id: 5 });
    expect(out.html).toContain('#5'); // falls back to id when no invoice_number
    expect(out.html).toContain('—');  // dash for missing supplier/total
  });
});

describe('renderDigest', () => {
  it('groups events by type and counts them', () => {
    const out = renderDigest([
      {
        event_type: 'photo_uploaded',
        events: [
          { payload: samplePayload, created_at: '2026-04-28 10:00:00' },
          { payload: { ...samplePayload, invoice_id: 2 }, created_at: '2026-04-28 10:05:00' },
        ],
      },
      {
        event_type: 'sent_to_1c',
        events: [{ payload: samplePayload, created_at: '2026-04-28 10:10:00' }],
      },
    ]);
    expect(out.subject).toBe('Дайджест (3 событий)');
    expect(out.html).toContain('Фото загружено (2)');
    expect(out.html).toContain('Отправлена в 1С (1)');
  });

  it('returns empty stub when no events', () => {
    const out = renderDigest([]);
    expect(out.subject).toContain('пусто');
  });
});
```

- [ ] **Step 2: Запустить тесты**

Run: `npx vitest run tests/notifications/templates.test.ts`
Expected: все тесты PASS (6 тестов).

- [ ] **Step 3: Commit**

```bash
git add tests/notifications/templates.test.ts
git commit -m "test(notifications): templates render correctly + escape HTML"
```

---

## Task 8: events.ts — точка эмиссии

**Files:**
- Create: `src/notifications/events.ts`

- [ ] **Step 1: Создать модуль**

Создать `src/notifications/events.ts`:

```typescript
import { logger } from '../utils/logger';
import { userRepo } from '../database/repositories/userRepo';
import { notificationRepo } from '../database/repositories/notificationRepo';
import { sendNotification, smtpConfigured } from '../utils/mailer';
import { renderRealtime } from './templates';
import { URGENT_EVENT_TYPES, type EventType, type EventPayload } from './types';

// Domain-event entry point. Routes the event according to the user's
// notify_mode + notify_events config. Never throws — failure is logged
// and swallowed (notifications must never break the main pipeline).
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
    if (!cfg.email) {
      logger.debug('notifications.emit: user has no email', { eventType, userId });
      return;
    }
    if (!cfg.notify_events.includes(eventType)) {
      logger.debug('notifications.emit: event disabled in config', { eventType, userId });
      return;
    }

    const isUrgent = URGENT_EVENT_TYPES.has(eventType);
    const sendNow = isUrgent || cfg.notify_mode === 'realtime';

    if (sendNow) {
      if (!smtpConfigured()) {
        logger.warn('notifications.emit: SMTP not configured, dropping urgent event', { eventType });
        return;
      }
      const { subject, html } = renderRealtime(eventType, payload);
      try {
        await sendNotification(cfg.email, subject, html);
      } catch (err) {
        logger.error('notifications.emit: send failed', {
          eventType,
          userId,
          error: (err as Error).message,
        });
      }
    } else {
      // Queue for digest worker
      notificationRepo.enqueue(userId, eventType, payload);
      logger.debug('notifications.emit: queued for digest', { eventType, userId });
    }
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

- [ ] **Step 2: Компиляция**

Run: `npx tsc --noEmit`
Expected: 0 ошибок.

- [ ] **Step 3: Commit**

```bash
git add src/notifications/events.ts
git commit -m "feat(notifications): emit() entry point routes event by mode"
```

---

## Task 9: Тесты для events.ts

**Files:**
- Create: `tests/notifications/events.test.ts`

- [ ] **Step 1: Написать тесты**

Создать `tests/notifications/events.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the modules events.ts depends on. We're unit-testing the routing
// logic, not the SMTP transport or the DB.
vi.mock('../../src/database/repositories/userRepo', () => ({
  userRepo: {
    firstUserId: vi.fn(() => 1),
    getNotifyConfig: vi.fn(),
  },
}));

vi.mock('../../src/database/repositories/notificationRepo', () => ({
  notificationRepo: {
    enqueue: vi.fn(),
  },
}));

vi.mock('../../src/utils/mailer', () => ({
  sendNotification: vi.fn(async () => {}),
  smtpConfigured: vi.fn(() => true),
}));

import { emit } from '../../src/notifications/events';
import { userRepo } from '../../src/database/repositories/userRepo';
import { notificationRepo } from '../../src/database/repositories/notificationRepo';
import { sendNotification } from '../../src/utils/mailer';

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

describe('emit()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing if user has no email', async () => {
    (userRepo.getNotifyConfig as any).mockReturnValue({
      email: null, notify_mode: 'realtime', notify_events: ALL_EVENTS,
    });
    await emit('photo_uploaded', samplePayload, 1);
    expect(sendNotification).not.toHaveBeenCalled();
    expect(notificationRepo.enqueue).not.toHaveBeenCalled();
  });

  it('does nothing if event is disabled in config', async () => {
    (userRepo.getNotifyConfig as any).mockReturnValue({
      email: 'a@b.c', notify_mode: 'realtime',
      notify_events: ['sent_to_1c'], // photo_uploaded NOT in the list
    });
    await emit('photo_uploaded', samplePayload, 1);
    expect(sendNotification).not.toHaveBeenCalled();
    expect(notificationRepo.enqueue).not.toHaveBeenCalled();
  });

  it('sends immediately in realtime mode for non-urgent event', async () => {
    (userRepo.getNotifyConfig as any).mockReturnValue({
      email: 'a@b.c', notify_mode: 'realtime', notify_events: ALL_EVENTS,
    });
    await emit('photo_uploaded', samplePayload, 1);
    expect(sendNotification).toHaveBeenCalledOnce();
    expect(notificationRepo.enqueue).not.toHaveBeenCalled();
  });

  it('queues non-urgent event in digest mode', async () => {
    (userRepo.getNotifyConfig as any).mockReturnValue({
      email: 'a@b.c', notify_mode: 'digest_hourly', notify_events: ALL_EVENTS,
    });
    await emit('photo_uploaded', samplePayload, 1);
    expect(sendNotification).not.toHaveBeenCalled();
    expect(notificationRepo.enqueue).toHaveBeenCalledOnce();
    expect(notificationRepo.enqueue).toHaveBeenCalledWith(1, 'photo_uploaded', samplePayload);
  });

  it('sends urgent event immediately even in digest_daily mode', async () => {
    (userRepo.getNotifyConfig as any).mockReturnValue({
      email: 'a@b.c', notify_mode: 'digest_daily', notify_events: ALL_EVENTS,
    });
    await emit('recognition_error', { ...samplePayload, error_message: 'oops' }, 1);
    expect(sendNotification).toHaveBeenCalledOnce();
    expect(notificationRepo.enqueue).not.toHaveBeenCalled();
  });

  it('sends suspicious_total urgently even in digest_hourly mode', async () => {
    (userRepo.getNotifyConfig as any).mockReturnValue({
      email: 'a@b.c', notify_mode: 'digest_hourly', notify_events: ALL_EVENTS,
    });
    await emit('suspicious_total', samplePayload, 1);
    expect(sendNotification).toHaveBeenCalledOnce();
    expect(notificationRepo.enqueue).not.toHaveBeenCalled();
  });

  it('falls back to firstUserId when triggeredByUserId is null', async () => {
    (userRepo.firstUserId as any).mockReturnValue(42);
    (userRepo.getNotifyConfig as any).mockReturnValue({
      email: 'a@b.c', notify_mode: 'realtime', notify_events: ALL_EVENTS,
    });
    await emit('photo_uploaded', samplePayload, null);
    expect(userRepo.firstUserId).toHaveBeenCalled();
    expect(userRepo.getNotifyConfig).toHaveBeenCalledWith(42);
  });

  it('does not throw when sendNotification rejects', async () => {
    (userRepo.getNotifyConfig as any).mockReturnValue({
      email: 'a@b.c', notify_mode: 'realtime', notify_events: ALL_EVENTS,
    });
    (sendNotification as any).mockRejectedValueOnce(new Error('SMTP down'));
    // Must not throw
    await expect(emit('photo_uploaded', samplePayload, 1)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Запустить тесты**

Run: `npx vitest run tests/notifications/events.test.ts`
Expected: все 8 тестов PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/notifications/events.test.ts
git commit -m "test(notifications): emit() routing — config respect, urgency, error swallowing"
```

---

## Task 10: digestWorker.ts — фоновая отправка дайджестов

**Files:**
- Create: `src/notifications/digestWorker.ts`

- [ ] **Step 1: Создать воркер**

Создать `src/notifications/digestWorker.ts`:

```typescript
import cron from 'node-cron';
import { logger } from '../utils/logger';
import { getDb } from '../database/db';
import { notificationRepo, type PendingNotification } from '../database/repositories/notificationRepo';
import { sendNotification, smtpConfigured } from '../utils/mailer';
import { renderDigest, type DigestGroup } from './templates';
import type { EventType, NotifyMode } from './types';

interface UserDigestRow {
  id: number;
  email: string | null;
  notify_mode: string;
}

// Build the digest for a single user in a single mode tick. Returns the
// number of events sent (0 means nothing to send).
async function sendDigestForUser(user: UserDigestRow, cutoffIso: string): Promise<number> {
  if (!user.email) return 0;
  const pending = notificationRepo.pendingForUser(user.id, cutoffIso);
  if (pending.length === 0) return 0;

  // Group by event_type, preserving insertion order across types
  const seen = new Set<EventType>();
  const groups: DigestGroup[] = [];
  for (const ev of pending) {
    const evt = ev.event_type as EventType;
    if (!seen.has(evt)) {
      seen.add(evt);
      groups.push({ event_type: evt, events: [] });
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(ev.payload_json);
    } catch {
      payload = { invoice_id: -1 };
    }
    const group = groups.find(g => g.event_type === evt)!;
    group.events.push({
      payload: payload as DigestGroup['events'][number]['payload'],
      created_at: ev.created_at,
    });
  }

  const { subject, html } = renderDigest(groups);
  try {
    await sendNotification(user.email, subject, html);
    notificationRepo.markSent(pending.map(p => p.id));
    return pending.length;
  } catch (err) {
    logger.error('digestWorker: send failed for user', {
      userId: user.id,
      error: (err as Error).message,
    });
    return 0; // leave events unsent; next tick retries
  }
}

// Pulls users with the given notify_mode and runs sendDigestForUser
// for each. Cutoff = now() at the start so events emitted DURING the
// tick roll into the next batch.
async function runTickForMode(mode: NotifyMode): Promise<void> {
  if (!smtpConfigured()) {
    logger.debug('digestWorker: SMTP not configured, skipping tick', { mode });
    return;
  }
  const cutoffIso = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const users = getDb()
    .prepare(`SELECT id, email, notify_mode FROM users WHERE notify_mode = ?`)
    .all(mode) as UserDigestRow[];

  let totalSent = 0;
  for (const user of users) {
    totalSent += await sendDigestForUser(user, cutoffIso);
  }
  logger.info('digestWorker: tick done', { mode, users: users.length, totalSent });
}

// Cron handles. Started by startDigestWorker, stopped by stopDigestWorker.
const handles: cron.ScheduledTask[] = [];

// Start cron jobs. Call this once at app startup.
//   - hourly digest fires at minute 0 of hours 09..18 (Europe/Moscow)
//   - daily digest fires at 19:00 Europe/Moscow
//   - cleanup of sent rows older than 7 days runs at 03:30 daily
export function startDigestWorker(): void {
  // Hourly: minute 0, hours 9–18, all days, MSK
  handles.push(
    cron.schedule(
      '0 9-18 * * *',
      () => { runTickForMode('digest_hourly').catch(err => logger.error('digest_hourly tick failed', { error: (err as Error).message })); },
      { timezone: 'Europe/Moscow' },
    ),
  );

  // Daily: 19:00 MSK
  handles.push(
    cron.schedule(
      '0 19 * * *',
      () => { runTickForMode('digest_daily').catch(err => logger.error('digest_daily tick failed', { error: (err as Error).message })); },
      { timezone: 'Europe/Moscow' },
    ),
  );

  // Cleanup: 03:30 every day
  handles.push(
    cron.schedule(
      '30 3 * * *',
      () => {
        try {
          const removed = notificationRepo.purgeOldSent();
          if (removed > 0) logger.info('digestWorker: purged old sent events', { removed });
        } catch (err) {
          logger.error('digestWorker: purge failed', { error: (err as Error).message });
        }
      },
      { timezone: 'Europe/Moscow' },
    ),
  );

  logger.info('digestWorker: started (hourly @ 9-18 MSK, daily @ 19 MSK, purge @ 3:30 MSK)');
}

// For tests: drop schedules.
export function stopDigestWorker(): void {
  for (const h of handles) h.stop();
  handles.length = 0;
}

// Exposed for tests — callable directly without cron.
export const __testInternals = { runTickForMode, sendDigestForUser };
```

- [ ] **Step 2: Компиляция**

Run: `npx tsc --noEmit`
Expected: 0 ошибок.

- [ ] **Step 3: Commit**

```bash
git add src/notifications/digestWorker.ts
git commit -m "feat(notifications): digest worker — hourly/daily cron + 7-day cleanup"
```

---

## Task 11: Тесты для digestWorker

**Files:**
- Create: `tests/notifications/digestWorker.test.ts`

- [ ] **Step 1: Написать тесты**

Создать `tests/notifications/digestWorker.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// We test runTickForMode directly via __testInternals. To do that, the
// worker imports getDb / notificationRepo / mailer — we mock those.
let memDb: Database.Database;

vi.mock('../../src/database/db', () => ({
  getDb: () => memDb,
}));

vi.mock('../../src/utils/mailer', () => ({
  sendNotification: vi.fn(async () => {}),
  smtpConfigured: vi.fn(() => true),
}));

import { __testInternals } from '../../src/notifications/digestWorker';
import { sendNotification, smtpConfigured } from '../../src/utils/mailer';

function setupDb(): void {
  memDb = new Database(':memory:');
  memDb.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT,
      notify_mode TEXT NOT NULL DEFAULT 'digest_hourly'
    );
    CREATE TABLE notification_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at TEXT
    );
  `);
}

describe('runTickForMode', () => {
  beforeEach(() => {
    setupDb();
    vi.clearAllMocks();
    (smtpConfigured as any).mockReturnValue(true);
  });

  it('does not send if no users in this mode', async () => {
    memDb.prepare(`INSERT INTO users (email, notify_mode) VALUES ('a@b.c', 'realtime')`).run();
    await __testInternals.runTickForMode('digest_hourly');
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('does not send when user has no pending events', async () => {
    memDb.prepare(`INSERT INTO users (id, email, notify_mode) VALUES (1, 'a@b.c', 'digest_hourly')`).run();
    await __testInternals.runTickForMode('digest_hourly');
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('sends digest with all pending events and marks them sent', async () => {
    memDb.prepare(`INSERT INTO users (id, email, notify_mode) VALUES (1, 'a@b.c', 'digest_hourly')`).run();
    const payload = JSON.stringify({ invoice_id: 1, invoice_number: '85', supplier: 'X', total_sum: 1000 });
    memDb.prepare(`INSERT INTO notification_events (user_id, event_type, payload_json) VALUES (1, 'photo_uploaded', ?)`).run(payload);
    memDb.prepare(`INSERT INTO notification_events (user_id, event_type, payload_json) VALUES (1, 'sent_to_1c', ?)`).run(payload);

    await __testInternals.runTickForMode('digest_hourly');
    expect(sendNotification).toHaveBeenCalledOnce();
    const callArgs = (sendNotification as any).mock.calls[0];
    expect(callArgs[0]).toBe('a@b.c');
    expect(callArgs[1]).toContain('Дайджест');
    expect(callArgs[2]).toContain('Фото загружено');

    const remaining = memDb.prepare(`SELECT COUNT(*) as cnt FROM notification_events WHERE sent_at IS NULL`).get() as { cnt: number };
    expect(remaining.cnt).toBe(0);
  });

  it('does NOT mark events sent if smtp send throws', async () => {
    memDb.prepare(`INSERT INTO users (id, email, notify_mode) VALUES (1, 'a@b.c', 'digest_hourly')`).run();
    memDb.prepare(`INSERT INTO notification_events (user_id, event_type, payload_json) VALUES (1, 'photo_uploaded', '{"invoice_id":1}')`).run();
    (sendNotification as any).mockRejectedValueOnce(new Error('SMTP down'));

    await __testInternals.runTickForMode('digest_hourly');
    const remaining = memDb.prepare(`SELECT COUNT(*) as cnt FROM notification_events WHERE sent_at IS NULL`).get() as { cnt: number };
    expect(remaining.cnt).toBe(1);
  });

  it('skips entire tick if SMTP not configured', async () => {
    (smtpConfigured as any).mockReturnValue(false);
    memDb.prepare(`INSERT INTO users (id, email, notify_mode) VALUES (1, 'a@b.c', 'digest_hourly')`).run();
    memDb.prepare(`INSERT INTO notification_events (user_id, event_type, payload_json) VALUES (1, 'photo_uploaded', '{"invoice_id":1}')`).run();
    await __testInternals.runTickForMode('digest_hourly');
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('processes multiple users independently', async () => {
    memDb.prepare(`INSERT INTO users (id, email, notify_mode) VALUES (1, 'a@b.c', 'digest_hourly')`).run();
    memDb.prepare(`INSERT INTO users (id, email, notify_mode) VALUES (2, 'd@e.f', 'digest_hourly')`).run();
    memDb.prepare(`INSERT INTO notification_events (user_id, event_type, payload_json) VALUES (1, 'photo_uploaded', '{"invoice_id":1}')`).run();
    memDb.prepare(`INSERT INTO notification_events (user_id, event_type, payload_json) VALUES (2, 'sent_to_1c', '{"invoice_id":2}')`).run();
    await __testInternals.runTickForMode('digest_hourly');
    expect(sendNotification).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Запустить тесты**

Run: `npx vitest run tests/notifications/digestWorker.test.ts`
Expected: все 6 тестов PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/notifications/digestWorker.test.ts
git commit -m "test(notifications): digest worker batches per user, retries on SMTP fail"
```

---

## Task 12: API роут /api/profile

**Files:**
- Create: `src/api/routes/profile.ts`

- [ ] **Step 1: Создать роут**

Создать `src/api/routes/profile.ts`:

```typescript
import { Router, Request, Response } from 'express';
import { userRepo } from '../../database/repositories/userRepo';
import { sendNotification, smtpConfigured } from '../../utils/mailer';
import { ALL_NOTIFY_MODES, ALL_EVENT_TYPES, type NotifyMode, type EventType } from '../../notifications/types';
import { logger } from '../../utils/logger';

const router = Router();

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.get('/', (req: Request, res: Response) => {
  if (!req.user) { res.status(401).json({ error: 'Not authenticated' }); return; }
  const cfg = userRepo.getNotifyConfig(req.user.id);
  if (!cfg) { res.status(404).json({ error: 'User config not found' }); return; }
  res.json({
    data: {
      email: cfg.email,
      notify_mode: cfg.notify_mode,
      notify_events: cfg.notify_events,
      smtp_configured: smtpConfigured(),
    },
  });
});

router.patch('/', (req: Request, res: Response) => {
  if (!req.user) { res.status(401).json({ error: 'Not authenticated' }); return; }
  const { email, notify_mode, notify_events } = req.body ?? {};
  const update: Record<string, unknown> = {};

  if (email !== undefined) {
    if (email !== null && (typeof email !== 'string' || !EMAIL_RX.test(email))) {
      res.status(400).json({ error: 'Invalid email' }); return;
    }
    update.email = email; // null clears
  }
  if (notify_mode !== undefined) {
    if (!ALL_NOTIFY_MODES.includes(notify_mode as NotifyMode)) {
      res.status(400).json({ error: `notify_mode must be one of: ${ALL_NOTIFY_MODES.join(', ')}` }); return;
    }
    update.notify_mode = notify_mode;
  }
  if (notify_events !== undefined) {
    if (!Array.isArray(notify_events)) { res.status(400).json({ error: 'notify_events must be an array' }); return; }
    for (const e of notify_events) {
      if (!ALL_EVENT_TYPES.includes(e as EventType)) {
        res.status(400).json({ error: `Unknown event type: ${e}` }); return;
      }
    }
    update.notify_events = notify_events;
  }

  if (Object.keys(update).length === 0) {
    res.status(400).json({ error: 'No fields to update' }); return;
  }

  userRepo.setNotifyConfig(req.user.id, update);
  const fresh = userRepo.getNotifyConfig(req.user.id);
  res.json({ data: { ...fresh, smtp_configured: smtpConfigured() } });
});

router.post('/test-email', async (req: Request, res: Response) => {
  if (!req.user) { res.status(401).json({ error: 'Not authenticated' }); return; }
  const cfg = userRepo.getNotifyConfig(req.user.id);
  if (!cfg?.email) { res.status(400).json({ error: 'No email configured' }); return; }
  if (!smtpConfigured()) { res.status(503).json({ error: 'SMTP not configured on server' }); return; }
  try {
    await sendNotification(
      cfg.email,
      'Тестовое письмо',
      `<p>Это тестовое письмо от ScanFlow на адрес <b>${cfg.email}</b>.</p><p>Если вы получили это письмо — настройка уведомлений работает.</p>`,
    );
    res.json({ data: { ok: true } });
  } catch (err) {
    logger.warn('test-email failed', { error: (err as Error).message });
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
```

- [ ] **Step 2: Смонтировать в server.ts**

В `src/api/server.ts` найти строку с импортами роутов (около `import authRouter from './routes/auth';`) и добавить:

```typescript
import profileRouter from './routes/profile';
```

Затем найти блок монтирования (около `app.use('/api/nomenclature', apiKeyAuth, nomenclatureRouter);`) и после него добавить:

```typescript
  app.use('/api/profile', apiKeyAuth, profileRouter);
```

- [ ] **Step 3: Компиляция**

Run: `npx tsc --noEmit`
Expected: 0 ошибок.

- [ ] **Step 4: Commit**

```bash
git add src/api/routes/profile.ts src/api/server.ts
git commit -m "feat(api): /api/profile — GET/PATCH config + POST test-email"
```

---

## Task 13: Тесты для /api/profile

**Files:**
- Create: `tests/api/profile.test.ts`

- [ ] **Step 1: Написать тесты**

Создать `tests/api/profile.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

let memEmail: string | null = 'test@example.com';
let memMode = 'digest_hourly';
let memEvents = ['photo_uploaded'];

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
  },
}));

vi.mock('../../src/utils/mailer', () => ({
  sendNotification: vi.fn(async () => {}),
  smtpConfigured: vi.fn(() => true),
}));

import profileRouter from '../../src/api/routes/profile';
import { sendNotification, smtpConfigured } from '../../src/utils/mailer';

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

describe('GET /api/profile', () => {
  beforeEach(() => {
    memEmail = 'test@example.com';
    memMode = 'digest_hourly';
    memEvents = ['photo_uploaded'];
    vi.clearAllMocks();
    (smtpConfigured as any).mockReturnValue(true);
  });

  it('returns current config', async () => {
    const res = await request(makeApp()).get('/api/profile');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      email: 'test@example.com',
      notify_mode: 'digest_hourly',
      notify_events: ['photo_uploaded'],
      smtp_configured: true,
    });
  });
});

describe('PATCH /api/profile', () => {
  beforeEach(() => {
    memEmail = 'test@example.com';
    memMode = 'digest_hourly';
    memEvents = ['photo_uploaded'];
    vi.clearAllMocks();
  });

  it('updates email when valid', async () => {
    const res = await request(makeApp()).patch('/api/profile').send({ email: 'new@x.com' });
    expect(res.status).toBe(200);
    expect(memEmail).toBe('new@x.com');
  });

  it('rejects invalid email', async () => {
    const res = await request(makeApp()).patch('/api/profile').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  it('allows clearing email with null', async () => {
    const res = await request(makeApp()).patch('/api/profile').send({ email: null });
    expect(res.status).toBe(200);
    expect(memEmail).toBeNull();
  });

  it('rejects invalid notify_mode', async () => {
    const res = await request(makeApp()).patch('/api/profile').send({ notify_mode: 'fake_mode' });
    expect(res.status).toBe(400);
  });

  it('rejects unknown event types', async () => {
    const res = await request(makeApp()).patch('/api/profile').send({ notify_events: ['photo_uploaded', 'fake_event'] });
    expect(res.status).toBe(400);
  });

  it('rejects empty body', async () => {
    const res = await request(makeApp()).patch('/api/profile').send({});
    expect(res.status).toBe(400);
  });
});

describe('POST /api/profile/test-email', () => {
  beforeEach(() => {
    memEmail = 'test@example.com';
    vi.clearAllMocks();
    (smtpConfigured as any).mockReturnValue(true);
  });

  it('sends a test email when email + smtp configured', async () => {
    const res = await request(makeApp()).post('/api/profile/test-email');
    expect(res.status).toBe(200);
    expect(sendNotification).toHaveBeenCalledOnce();
  });

  it('refuses if no email', async () => {
    memEmail = null;
    const res = await request(makeApp()).post('/api/profile/test-email');
    expect(res.status).toBe(400);
  });

  it('refuses if SMTP not configured', async () => {
    (smtpConfigured as any).mockReturnValue(false);
    const res = await request(makeApp()).post('/api/profile/test-email');
    expect(res.status).toBe(503);
  });
});
```

- [ ] **Step 2: Установить supertest если ещё нет**

Run: `npm ls supertest 2>&1 | head -5`

Если `supertest` не установлен, добавить как dev-зависимость:
```bash
npm install --save-dev supertest @types/supertest
```

- [ ] **Step 3: Запустить тесты**

Run: `npx vitest run tests/api/profile.test.ts`
Expected: все 10 тестов PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/api/profile.test.ts package.json package-lock.json
git commit -m "test(api): /api/profile validation + test-email flow"
```

---

## Task 14: Запуск digestWorker в index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Добавить импорт и старт**

В `src/index.ts` найти секцию импортов (после `import { FileWatcher } from './watcher/fileWatcher';`) и добавить:

```typescript
import { startDigestWorker } from './notifications/digestWorker';
```

Затем найти место после `cron.schedule('0 */6 * * *', () => {` (последний `cron.schedule` блок) и его закрывающую `});`. После этой закрывающей скобки и закрывающей `);` добавить:

```typescript
  startDigestWorker();
```

- [ ] **Step 2: Компиляция и быстрый старт**

Run:
```bash
npx tsc --noEmit
npm run dev
```

Дождаться лога `digestWorker: started`. Остановить (Ctrl+C).

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(notifications): start digest worker on app boot"
```

---

## Task 15: Точки эмиссии в fileWatcher.ts

**Files:**
- Modify: `src/watcher/fileWatcher.ts`

- [ ] **Step 1: Найти места для эмиссии и сделать пометки**

Run: `grep -n "invoiceRepo.create\|markProcessed\|markError\|catch (err\|items_total_mismatch" src/watcher/fileWatcher.ts | head -20`

Запомнить номера строк ключевых мест.

- [ ] **Step 2: Добавить импорт**

В `src/watcher/fileWatcher.ts` в начало файла (после остальных `import`-ов из `../`) добавить:

```typescript
import { emit as emitNotification } from '../notifications/events';
```

- [ ] **Step 3: Эмиссия photo_uploaded**

Найти место сразу после успешного `invoiceRepo.create({...})` (вызов, который возвращает свежесозданную накладную) — это в начале обработки нового файла. После строки получения новой `invoice` (где есть `invoice.id` и file_name), добавить:

```typescript
      // Fire-and-forget: notifications never block the pipeline.
      emitNotification('photo_uploaded', {
        invoice_id: invoice.id,
        invoice_number: invoice.invoice_number,
        supplier: invoice.supplier,
        total_sum: invoice.total_sum,
      }, null).catch(() => {});
```

- [ ] **Step 4: Эмиссия invoice_recognized + suspicious_total**

Найти место, где после полного процессинга накладная переходит в `status='processed'` и для неё уже посчитан `items_total_mismatch`. Сразу после этого добавить:

```typescript
      const finalInvoice = invoiceRepo.getById(targetInvoiceId);
      if (finalInvoice) {
        emitNotification('invoice_recognized', {
          invoice_id: finalInvoice.id,
          invoice_number: finalInvoice.invoice_number,
          supplier: finalInvoice.supplier,
          total_sum: finalInvoice.total_sum,
        }, null).catch(() => {});
        if (finalInvoice.items_total_mismatch === 1) {
          // The repo may not expose items_total directly; fall back to total_sum
          // and let the email say "items_total mismatch" without the explicit value.
          emitNotification('suspicious_total', {
            invoice_id: finalInvoice.id,
            invoice_number: finalInvoice.invoice_number,
            supplier: finalInvoice.supplier,
            total_sum: finalInvoice.total_sum,
            items_total: null,
          }, null).catch(() => {});
        }
      }
```

(Точное место — сразу после `recalculateTotal` / `markProcessed` для накладной. Если `targetInvoiceId` не существует в текущем scope — использовать переменную, под которой накладная известна там.)

- [ ] **Step 5: Эмиссия recognition_error**

В catch-блоке самого высокого уровня обработки файла (где вызывается `markError` или статус ставится в `error`), сразу после установки статуса добавить:

```typescript
      emitNotification('recognition_error', {
        invoice_id: invoice.id,
        invoice_number: invoice.invoice_number,
        supplier: invoice.supplier,
        total_sum: invoice.total_sum,
        error_message: (err as Error).message,
      }, null).catch(() => {});
```

(Использовать переменную `invoice`, доступную в этом scope. Если accessibility отличается, взять id из ближайшей доступной переменной.)

- [ ] **Step 6: Компиляция**

Run: `npx tsc --noEmit`
Expected: 0 ошибок.

- [ ] **Step 7: Прогнать существующие тесты watcher**

Run: `npx vitest run tests/watcher/`
Expected: все existing tests PASS — мы добавили только эмиссию, не поменяли логику merge / markStaleAsFailed.

- [ ] **Step 8: Commit**

```bash
git add src/watcher/fileWatcher.ts
git commit -m "feat(notifications): emit photo_uploaded/invoice_recognized/recognition_error/suspicious_total from watcher"
```

---

## Task 16: Точки эмиссии в роутах invoices.ts и webhook.ts

**Files:**
- Modify: `src/api/routes/invoices.ts`
- Modify: `src/integration/webhook.ts`

- [ ] **Step 1: Импорт в invoices.ts**

В `src/api/routes/invoices.ts` в начало добавить:

```typescript
import { emit as emitNotification } from '../../notifications/events';
```

- [ ] **Step 2: Эмиссия invoice_edited на PATCH /:invoiceId/items/:itemId**

Найти роут `router.patch('/:invoiceId/items/:itemId', ...)`. После успешной записи правки (после `db.prepare(...).run(...)` в этом обработчике, перед `res.json`), добавить:

```typescript
  const inv = invoiceRepo.getById(invoiceId);
  if (inv) {
    emitNotification('invoice_edited', {
      invoice_id: inv.id,
      invoice_number: inv.invoice_number,
      supplier: inv.supplier,
      total_sum: inv.total_sum,
    }, req.user?.id ?? null).catch(() => {});
  }
```

- [ ] **Step 3: Эмиссия approved_for_1c на POST /:id/send**

Найти роут `router.post('/:id/send', ...)`. После `invoiceRepo.approveForOneC(id);` (но до `res.json`), добавить:

```typescript
  const invForNotif = invoiceRepo.getById(id);
  if (invForNotif) {
    emitNotification('approved_for_1c', {
      invoice_id: invForNotif.id,
      invoice_number: invForNotif.invoice_number,
      supplier: invForNotif.supplier,
      total_sum: invForNotif.total_sum,
    }, req.user?.id ?? null).catch(() => {});
  }
```

- [ ] **Step 4: Эмиссия sent_to_1c на POST /:id/confirm**

Найти роут `router.post('/:id/confirm', ...)`. После `invoiceRepo.markSent(id);` (или после статуса перехода в `sent_to_1c`, до `res.json`) добавить:

```typescript
  const invConfirmed = invoiceRepo.getById(id);
  if (invConfirmed) {
    emitNotification('sent_to_1c', {
      invoice_id: invConfirmed.id,
      invoice_number: invConfirmed.invoice_number,
      supplier: invConfirmed.supplier,
      total_sum: invConfirmed.total_sum,
    }, req.user?.id ?? null).catch(() => {});
  }
```

- [ ] **Step 5: Импорт + эмиссия в webhook.ts**

В `src/integration/webhook.ts` в начало добавить:

```typescript
import { emit as emitNotification } from '../notifications/events';
```

Найти строку `invoiceRepo.markSent(invoiceId);` (внутри `if (response.ok) {...}`). Сразу после неё добавить:

```typescript
      const sent = invoiceRepo.getById(invoiceId);
      if (sent) {
        emitNotification('sent_to_1c', {
          invoice_id: sent.id,
          invoice_number: sent.invoice_number,
          supplier: sent.supplier,
          total_sum: sent.total_sum,
        }, null).catch(() => {});
      }
```

- [ ] **Step 6: Компиляция**

Run: `npx tsc --noEmit`
Expected: 0 ошибок.

- [ ] **Step 7: Прогнать все существующие тесты**

Run: `npx vitest run`
Expected: все тесты PASS, ничего не сломали.

- [ ] **Step 8: Commit**

```bash
git add src/api/routes/invoices.ts src/integration/webhook.ts
git commit -m "feat(notifications): emit invoice_edited/approved_for_1c/sent_to_1c from routes"
```

---

## Task 17: UI — страница «Профиль»

**Files:**
- Create: `public/profile.html`
- Create: `public/js/profile.js`
- Modify: `public/index.html` (пункт меню)
- Modify: `public/js/app.js` (роутинг)

- [ ] **Step 1: Создать profile.html**

Создать `public/profile.html`:

```html
<div class="page page-profile">
  <h1>Профиль</h1>
  <div id="profile-form">
    <fieldset>
      <legend>Email для уведомлений</legend>
      <input type="email" id="profile-email" placeholder="you@example.com" autocomplete="email">
      <p class="hint" id="smtp-hint"></p>
    </fieldset>

    <fieldset>
      <legend>Режим уведомлений</legend>
      <label><input type="radio" name="profile-mode" value="realtime"> Реалтайм — каждое событие отдельным письмом</label>
      <label><input type="radio" name="profile-mode" value="digest_hourly"> Дайджест каждый час (рекомендуется)</label>
      <label><input type="radio" name="profile-mode" value="digest_daily"> Дайджест раз в день в 19:00</label>
    </fieldset>

    <fieldset>
      <legend>События</legend>
      <label><input type="checkbox" data-event="photo_uploaded">     Фото загружено</label>
      <label><input type="checkbox" data-event="invoice_recognized"> Накладная распознана</label>
      <label><input type="checkbox" data-event="recognition_error">  Ошибка распознавания (срочно)</label>
      <label><input type="checkbox" data-event="suspicious_total">   Подозрительная сумма (срочно)</label>
      <label><input type="checkbox" data-event="invoice_edited">     Правка в дашборде</label>
      <label><input type="checkbox" data-event="approved_for_1c">    Утверждена для 1С</label>
      <label><input type="checkbox" data-event="sent_to_1c">         Отправлена в 1С</label>
    </fieldset>

    <div class="actions">
      <button id="profile-save" class="btn btn-primary">Сохранить</button>
      <button id="profile-test" class="btn">Отправить тестовое письмо</button>
      <span id="profile-status"></span>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Создать profile.js**

Создать `public/js/profile.js`:

```javascript
(function () {
  const Profile = {
    async load() {
      const r = await App.api('GET', '/api/profile');
      const data = r.data;
      document.getElementById('profile-email').value = data.email || '';
      const modeInput = document.querySelector(`input[name="profile-mode"][value="${data.notify_mode}"]`);
      if (modeInput) modeInput.checked = true;
      const enabled = new Set(data.notify_events || []);
      document.querySelectorAll('input[type=checkbox][data-event]').forEach(cb => {
        cb.checked = enabled.has(cb.dataset.event);
      });
      const hint = document.getElementById('smtp-hint');
      hint.textContent = data.smtp_configured
        ? ''
        : '⚠ SMTP не настроен на сервере — письма не будут отправлены, обратитесь к администратору.';
      hint.style.color = data.smtp_configured ? '' : '#b91c1c';
    },

    collect() {
      const email = document.getElementById('profile-email').value.trim() || null;
      const modeEl = document.querySelector('input[name="profile-mode"]:checked');
      const notify_mode = modeEl ? modeEl.value : 'digest_hourly';
      const notify_events = Array.from(document.querySelectorAll('input[type=checkbox][data-event]:checked'))
        .map(cb => cb.dataset.event);
      return { email, notify_mode, notify_events };
    },

    async save() {
      const status = document.getElementById('profile-status');
      try {
        await App.api('PATCH', '/api/profile', this.collect());
        status.textContent = 'Сохранено';
        status.style.color = '#16a34a';
      } catch (err) {
        status.textContent = 'Ошибка: ' + (err.message || err);
        status.style.color = '#b91c1c';
      }
      setTimeout(() => { status.textContent = ''; }, 3000);
    },

    async test() {
      const status = document.getElementById('profile-status');
      status.textContent = 'Отправляем тестовое письмо…';
      status.style.color = '';
      try {
        await App.api('POST', '/api/profile/test-email');
        status.textContent = 'Тестовое письмо отправлено — проверьте почту';
        status.style.color = '#16a34a';
      } catch (err) {
        status.textContent = 'Не удалось: ' + (err.message || err);
        status.style.color = '#b91c1c';
      }
    },

    init() {
      document.getElementById('profile-save').addEventListener('click', () => this.save());
      document.getElementById('profile-test').addEventListener('click', () => this.test());
      this.load();
    },
  };
  window.Profile = Profile;
})();
```

- [ ] **Step 3: Подключить файлы и пункт меню в index.html**

Открыть `public/index.html`. Найти место подключения остальных JS (например `<script src="/js/invoices.js"></script>`) и рядом добавить:

```html
<script src="/js/profile.js"></script>
```

В навигационном меню (там где ссылки `Накладные`/`Маппинги`/`Настройки`) добавить рядом:

```html
<a href="#profile" data-route="profile">Профиль</a>
```

- [ ] **Step 4: Добавить роут в app.js**

В `public/js/app.js` найти hash-роутер и добавить обработку `profile`:

Найти switch/if-цепочку, которая по `route` решает какую функцию init вызвать (там уже есть `invoices`, `mappings`, `settings`, `webhook`). Добавить ветку:

```javascript
} else if (route === 'profile') {
  await loadPage('/profile.html');
  Profile.init();
}
```

(точная вставка зависит от структуры роутера; общий подход — после блока для `settings` или `webhook`)

- [ ] **Step 5: Проверить вручную в браузере**

Run: `npm run dev`. Открыть http://localhost:8899/, залогиниться, перейти на «Профиль». Проверить:
- email подгружается (если был задан в `MAIL_TO`)
- режим выбран правильно
- 7 чекбоксов в нужном состоянии
- сохранение работает (после reload — значение остаётся)
- кнопка «Отправить тестовое письмо» — если SMTP настроен, письмо приходит

Остановить dev-сервер.

- [ ] **Step 6: Commit**

```bash
git add public/profile.html public/js/profile.js public/index.html public/js/app.js
git commit -m "feat(ui): профиль — email, режим уведомлений, переключатели событий"
```

---

## Task 18: .env.example и CLAUDE.md

**Files:**
- Modify: `.env.example`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Найти SMTP-блок в .env.example (если есть) или добавить**

Run: `grep -n "SMTP\|MAIL_TO" .env.example`

Если ничего не найдено — добавить блок в конец `.env.example`:

```
# =============================================================================
# Email (SMTP)
# =============================================================================
# Используется для системных писем (uncaughtException, диск-монитор) и
# пользовательских уведомлений (см. /api/profile в дашборде). Если SMTP_*
# не заданы — все письма молча не отправляются. MAIL_TO — fallback-адрес
# для системных писем; пользовательские уведомления идут на users.email.
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
MAIL_TO=
```

- [ ] **Step 2: Добавить раздел в CLAUDE.md**

В `CLAUDE.md` найти раздел `## Авторизация: пользователи и API-ключи` и сразу после него (перед `## Деплой и CI/CD`) вставить новый раздел:

```markdown
## Уведомления пользователю на email

**Файлы:**
- [`src/notifications/events.ts`](src/notifications/events.ts) — `emit(eventType, payload, userId)` точка эмиссии
- [`src/notifications/digestWorker.ts`](src/notifications/digestWorker.ts) — cron 9-18 MSK почасовой, 19 MSK дневной, 03:30 чистка > 7 дней
- [`src/notifications/templates.ts`](src/notifications/templates.ts) — HTML рендер (realtime + digest)
- [`src/notifications/types.ts`](src/notifications/types.ts) — `EventType`, `NotifyMode`, `URGENT_EVENT_TYPES`
- [`src/api/routes/profile.ts`](src/api/routes/profile.ts) — `GET/PATCH /api/profile`, `POST /api/profile/test-email`
- [`public/profile.html`](public/profile.html), [`public/js/profile.js`](public/js/profile.js) — UI

### Модель

- 7 событий: `photo_uploaded`, `invoice_recognized`, `recognition_error`, `suspicious_total`, `invoice_edited`, `approved_for_1c`, `sent_to_1c`
- 2 события — срочные (`recognition_error`, `suspicious_total`), всегда шлются мгновенно
- 3 режима: `realtime` / `digest_hourly` (default) / `digest_daily`
- Email и режим хранятся в `users` (миграция 18: колонки `email`, `notify_mode`, `notify_events`)
- Очередь дайджеста — таблица `notification_events`, чистится раз в сутки

### emit()

`emit(eventType, payload, triggeredByUserId)` никогда не бросает исключение — failure логируется и глотается. Если `triggeredByUserId === null`, берётся `userRepo.firstUserId()` (для текущего single-user сетапа это владелец). Если у юзера нет `email` или событие выключено в `notify_events` — return без сайд-эффекта.

### Точки эмиссии

- `fileWatcher.ts` → `photo_uploaded`, `invoice_recognized`, `recognition_error`, `suspicious_total`
- `api/routes/invoices.ts` → `invoice_edited` (PATCH item), `approved_for_1c` (POST send), `sent_to_1c` (POST confirm)
- `integration/webhook.ts` → `sent_to_1c` (после `markSent`)

### Существующие системные письма не трогаем

`sendErrorEmail` (uncaughtException, диск-монитор) продолжает слаться через `MAIL_TO` из `.env`. Это сделано специально — системные письма должны работать даже когда БД недоступна.

### Конфигурация SMTP

`SMTP_HOST/PORT/USER/PASS` в `.env`. Если не заданы — `smtpConfigured()` возвращает `false`, в UI видна плашка «SMTP не настроен на сервере», тестовое письмо отдаёт 503.
```

- [ ] **Step 3: Commit**

```bash
git add .env.example CLAUDE.md
git commit -m "docs: notifications module + SMTP env vars"
```

---

## Task 19: Финальный smoke test и проверка

**Files:** (нет правок, только верификация)

- [ ] **Step 1: Прогнать все тесты**

Run: `npx vitest run`
Expected: все тесты PASS, в том числе новые: `tests/notifications/*.test.ts`, `tests/api/profile.test.ts`.

- [ ] **Step 2: Полная проверка типов**

Run: `npx tsc --noEmit`
Expected: 0 ошибок.

- [ ] **Step 3: Запустить dev-сервер и проверить миграцию**

Run: `npm run dev`

В логах должно быть `migration 18 applied`. Затем зайти в дашборд, открыть «Профиль», убедиться:
- email заполнен (если был `MAIL_TO`) или пустой
- режим = `digest_hourly`
- все 7 чекбоксов включены
- «Тестовое письмо» отправляет письмо (если SMTP настроен) или показывает понятную ошибку

Остановить dev-сервер.

- [ ] **Step 4: Финальный коммит-маркер**

```bash
git log --oneline -25
```

Проверить, что у нас 18+ зелёных коммитов по фиче, каждая с осмысленным сообщением.

- [ ] **Step 5: (Опционально) PR**

Если работаем через PR — создать PR в main:
```bash
gh pr create --title "User notifications: email per-event with realtime/digest modes" --body "$(cat <<'EOF'
## Summary
- 7 доменных событий → email на адрес из users.email
- Режимы: realtime / digest_hourly (default) / digest_daily
- Срочные (recognition_error, suspicious_total) всегда сразу
- UI «Профиль» в дашборде
- Существующие системные письма (uncaughtException) не трогаем

См. spec: `docs/superpowers/specs/2026-04-28-user-notifications-design.md`

## Test plan
- [ ] Прогнать `npx vitest run` — все green
- [ ] Зайти в дашборд → «Профиль» → отправить тестовое письмо
- [ ] Загрузить накладную → получить `photo_uploaded` либо в почту (realtime), либо в очередь (digest)
- [ ] Заскриптовать ошибку (например, неправильный API-ключ Claude) → получить `recognition_error` мгновенно
- [ ] Подождать 1 час в `digest_hourly` режиме — получить дайджест
EOF
)"
```

---

## Self-review

Прохожу спек по разделам:

- ✅ **Проблема + не-цели** — отражены в Goal/Architecture; не-цели зафиксированы тем, что в плане нет ни ролей, ни UI юзеров, ни Telegram.
- ✅ **7 событий** — Task 2 (типы), Task 15-16 (точки эмиссии). Все 7 покрыты.
- ✅ **3 режима** — Task 2 типы, Task 8 routing в emit, Task 10 worker для двух digest-режимов.
- ✅ **Срочные** — `URGENT_EVENT_TYPES` в Task 2, проверка в Task 8.
- ✅ **Конфиг (`email`, `notify_mode`, `notify_events`) + миграция с MAIL_TO** — Task 1.
- ✅ **`notification_events`** таблица — Task 1, repo Task 4.
- ✅ **`events.ts` + `digestWorker.ts` + `templates.ts`** — Tasks 2, 6, 8, 10.
- ✅ **API `/api/profile` + test-email** — Task 12.
- ✅ **UI** — Task 17.
- ✅ **Точки эмиссии** — Tasks 15, 16.
- ✅ **Mailer.sendNotification** — Task 5.
- ✅ **Тесты (events, digest, templates, profile)** — Tasks 7, 9, 11, 13. Тесты для самого fileWatcher не дописывал — там уже есть существующие, мы только добавляем эмиссии (которые мокать в watcher-тестах не имеет смысла, мы тестируем emit() отдельно). Это адекватно.
- ✅ **`smtp_configured` в API** — Task 12 возвращает в `data.smtp_configured`, UI Task 17 показывает плашку.
- ✅ **Cleanup `> 7 days`** — Task 10 (cron 03:30).
- ✅ **Гонка эмиссии и воркера** — Task 4 `pendingForUser(userId, cutoffIso)` фиксирует cutoff, Task 10 берёт `new Date().toISOString()` на старте тика.

**Placeholder scan:** Поискал `TBD`/`TODO`/«similar to Task N» — нет.

**Type consistency:**
- `EventType` — определён в Task 2, используется во всех остальных
- `NotifyConfig.notify_events: EventType[]` — Task 2; userRepo Task 3 парсит JSON в этот же тип; routes Task 12 валидирует через `ALL_EVENT_TYPES`
- `EventPayload` — Task 2; всё, что эмитят в Task 15-16, соответствует
- `firstUserId()` (Task 3) — вызывается в Task 8 как `userRepo.firstUserId()` — совпадает
- `notificationRepo.enqueue/pendingForUser/markSent/purgeOldSent` — определены в Task 4, используются в Task 8 и Task 10 — совпадают
- `sendNotification(to, subject, html)` — Task 5; вызывается в Task 8 (`sendNotification(cfg.email, subject, html)`), Task 10, Task 12 — совпадает

Всё согласовано.

**Scope check:** план собирается в одну логическую фичу (~19 задач × 2-5 минут × несколько коммитов). Это нормальный размер. Не разбиваю.

---

## Что не вошло в план (явно)

- **Связь «фото → конкретный сотрудник».** В спеке отмечено как не-цель. Когда появится — добавим колонку `created_by_user_id` в `invoices` и подмена `triggeredByUserId` в Task 15.
- **Telegram/SMS.** Не-цель.
- **UI управления юзерами.** Не-цель.
- **Локализация писем кроме русского.** Достаточно русского.
