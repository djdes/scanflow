# Integration activity log + real 1C status

**Date:** 2026-06-02
**Status:** approved

## Problem

The «Интеграции» menu has two pages — Сбербанк and «Webhook 1C» — but no record
of **what** the integrations did and **when**. Sber actions live in
`sber_payments`; 1C lifecycle is implied by `invoices.approved_at`/`sent_at`; 1C's
inbound polls land in the generic `api_requests_log` (7-day retention); webhook
sends and config changes are not recorded anywhere. There is no unified,
user-visible activity log.

Separately, the «Webhook 1C» page shows the **legacy** webhook as "Выключен",
which the user reasonably reads as "1C is not connected". In reality the legacy
webhook is optional/dead; the real 1C integration is **pull-based** — 1C polls
`GET /api/invoices/pending` and confirms via `POST /api/invoices/:id/confirm`, no
webhook required. The UI conflates "webhook disabled" with "1C not connected".

## Decisions (from brainstorming)

- **Unified page:** one «Журнал» page under Интеграции showing all events
  (1С / Сбер / webhook / номенклатура), each row labelled by integration, with a
  filter. (Not per-integration blocks.)
- **Fix the 1C-status confusion:** show a real 1C status ("1С последний раз
  обращалась: …", derived from `api_requests_log`) and add a note on the Webhook
  page clarifying it is an optional legacy webhook while 1C works by polling.
- **Dedicated append-only table** `integration_events` is the backbone, written by
  a never-throwing `logIntegrationEvent()` at each important action point. (The
  existing `emit()` stream only goes to Telegram and persists nothing reusable;
  `notification_events` is dead.) Forward-only — no backfill of past actions.
- **Do not log every 1C poll** (spam). The durable record of "what went to 1C" is
  the `sent` event; the poll cadence is surfaced as a derived status only.

## Architecture

### Migration 32 — `integration_events`

Idempotent (`CREATE TABLE IF NOT EXISTS`), `detect` = `hasTable`.

```sql
CREATE TABLE IF NOT EXISTS integration_events (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  ts           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  integration  VARCHAR(16)   NOT NULL,   -- '1c' | 'sber' | 'webhook' | 'nomenclature'
  event_type   VARCHAR(48)   NOT NULL,   -- see vocabulary below
  status       VARCHAR(8)    NOT NULL DEFAULT 'ok',  -- 'ok' | 'error' | 'info'
  invoice_id   INT           NULL,       -- NO FK: the audit row must outlive the invoice
  summary      VARCHAR(512)  NOT NULL,   -- human-readable Russian one-liner
  detail       TEXT          NULL,       -- optional JSON (e.g. Sber error body, HTTP status)
  INDEX idx_integration_events_ts (ts),
  INDEX idx_integration_events_integration (integration)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
```

`event_type` vocabulary: `approved`, `sent`, `reset`, `unapproved` (1c);
`payment_created`, `payment_failed` (sber); `webhook_sent`, `webhook_failed`
(webhook); `catalog_synced` (nomenclature); `config_changed` (any).

### Writer — `src/integration/integrationLog.ts`

```ts
export type IntegrationName = '1c' | 'sber' | 'webhook' | 'nomenclature';
export interface IntegrationEventInput {
  integration: IntegrationName;
  event_type: string;
  status?: 'ok' | 'error' | 'info';   // default 'ok'
  invoice_id?: number | null;
  summary: string;
  detail?: unknown;                    // JSON.stringify'd if present
}
export async function logIntegrationEvent(e: IntegrationEventInput): Promise<void>;
```

- Inserts one row. **Never throws** — wrapped in try/catch that logs and swallows
  (an audit-log write must not break the action it records), mirroring `emit()`.
- `summary` is clamped to 512 chars; `detail` (JSON string) is clamped to 4000
  chars before insert to bound row size.

### Read repo — `src/database/repositories/integrationEventRepo.ts`

- `recent({ integration?, limit, offset })` → rows (newest first, `limit` clamped ≤ 200).
- `last1cPollAt()` → most recent `api_requests_log.timestamp` where
  `path LIKE '/api/invoices/pending%'` (the derived 1C status).
- `prune(days = 90)` → delete rows older than N days (called from the same daily
  cron that runs `cleanupOldRequestLogs`).

### Instrumentation points (one `logIntegrationEvent(...)` call each)

All in existing route/service files; each is a single fire-and-forget call
(`logIntegrationEvent(...).catch(()=>{})` is unnecessary since it never throws, but
calls are still `await`ed where convenient or left floating where in a hot path).

| Where | event | summary example |
|---|---|---|
| `POST /api/invoices/:id/send` (after `approveForOneC`) | `1c/approved` | «Накладная №400 одобрена для отправки в 1С» |
| `POST /api/invoices/:id/confirm` (after `markSent`) | `1c/sent` | «Накладная №400 загружена в 1С (подтверждено)» |
| `POST /api/invoices/:id/reset` | `1c/reset` | «Статус накладной №400 сброшен (можно отправить заново)» |
| `POST /api/invoices/:id/unapprove` | `1c/unapproved` | «Отозвана отправка накладной №400 в 1С» |
| `POST /api/invoices/:id/send-sber` (success) | `sber/payment_created` | «Платёж в Сбербанк по №400 создан (черновик), № …» |
| `POST /api/invoices/:id/send-sber` (SberApiError / failure) | `sber/payment_failed` (status=error) | «Ошибка платежа в Сбербанк по №400: HTTP 400» (+ body in `detail`) |
| `sendToWebhook()` (`src/integration/webhook.ts`) success/fail | `webhook/webhook_sent` / `webhook_failed` | «Вебхук по №400 отправлен (HTTP 200)» |
| nomenclature sync route (`src/api/routes/nomenclature.ts`) | `nomenclature/catalog_synced` | «Справочник 1С синхронизирован: N позиций» |
| `PUT /api/webhook/config` | `webhook/config_changed` | «Изменены настройки вебхука (вкл/выкл, URL)» |
| Sber connect / disconnect (`src/api/routes/sber.ts`) | `sber/config_changed` | «Сбербанк подключён» / «Сбербанк отключён» |
| `PATCH /api/settings/analyzer` — **only when the auto-send flags change** | `1c/config_changed` (auto_send_1c) / `sber/config_changed` (auto_send_sber) | «Авто-отправка в 1С включена» / «Авто-отправка в Сбер выключена» |

OCR mode / Claude key / LLM-mapper changes are NOT logged — they are recognition
settings, not integration actions.

1C **polls** (`GET /api/invoices/pending`) are intentionally NOT logged as events
(avoids per-minute spam); the poll cadence is surfaced via `last1cPollAt()`.

### API — `src/api/routes/integrations.ts` (new), mounted at `/api/integrations`

- `GET /api/integrations/log?integration=<name>&limit=<n>&offset=<n>` (X-API-Key)
  → `{ data: events[], onec_last_poll_at: string | null }`.
- Registered in `src/api/server.ts` next to the other routers. Route-order safe
  (static path, no `:id` collision).

### Frontend

- **Nav** (`public/app.html`): add `<a href="#/integrations-log"
  data-tab="integrations-log">Журнал</a>` to the Интеграции `nav-menu`, and extend
  the group trigger's `data-tab` to include `integrations-log` so the group stays
  highlighted.
- **Section** `view-integrations-log`: a 1C-status banner («✓ 1С на связи —
  последний запрос: <время>» when `onec_last_poll_at` within ~recent, else «1С
  пока не обращалась к серверу»), a filter (Все / 1С / Сбер / Webhook), and a
  table: Время · Интеграция (цветной бейдж) · Событие · Описание · (ссылка на
  накладную when `invoice_id`). Error-status rows tinted red.
- **Routing** (`public/js/app.js`): `#/integrations-log` → show the section +
  `IntegrationsLog.load()`.
- **`public/js/integrations-log.js`** (new): fetch `/api/integrations/log`, render
  banner + filter + rows; all user/DB text via `App.esc`.
- **Webhook page note** (`public/app.html` webhook section + maybe `webhook.js`):
  add a muted explanation that this is an optional legacy webhook and that the
  main 1C integration works by polling (with a link to «Журнал» for real status).

### Retention

`integrationEventRepo.prune(90)` wired into the existing daily cron alongside
`cleanupOldRequestLogs`. Low event volume; 90 days is generous.

## Error handling / edge cases

- `logIntegrationEvent` never throws — a logging failure is swallowed (logged via
  winston), the recorded action proceeds normally.
- `invoice_id` has no FK and is nullable — deleting an invoice leaves its history
  intact; config-change events carry `invoice_id = null`.
- Empty log → page shows an empty state, not an error.
- `onec_last_poll_at` null (1C hasn't polled in the 7-day `api_requests_log`
  window) → banner shows «1С пока не обращалась…». Documented caveat: this signal
  is bounded by `api_requests_log`'s 7-day prune.
- All inserted `summary`/`detail` are clamped (≤512 / few KB) — STRICT_TRANS_TABLES
  on prod throws `ER_DATA_TOO_LONG` otherwise (lesson from the History-tab audit).

## Testing

- `npx tsc --noEmit` + `npm test` (full suite; DB-backed suites remain dormant).
- Pure-testable unit if extracted: none strictly required; the writer is thin.
- Migration 32 idempotency: manual (DB suite dormant).
- Live verification after deploy: perform a 1C approve + confirm and a Sber send on
  a test invoice → the «Журнал» page shows the corresponding rows; the 1C-status
  banner reflects recent polls.

## Out of scope

- Logging every individual 1C poll as an event (only the derived status).
- Backfilling history for actions taken before this ships.
- Real-time push/websocket updates to the log page (it loads on open / refresh).
- Replacing or removing the legacy webhook (only a clarifying note is added).
