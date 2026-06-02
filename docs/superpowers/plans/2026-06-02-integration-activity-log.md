# Integration Activity Log — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A unified «Журнал» page under Интеграции that records important integration actions (1С approve/sent/reset, Сбер payments, webhook, catalog sync, key config changes) into a new `integration_events` table, plus a real "1С last polled at" status that resolves the misleading "1C not connected" webhook display.

**Architecture:** New append-only `integration_events` table (migration 32). A never-throwing `logIntegrationEvent()` writer is called at each action point. A read repo serves recent events + the derived 1С poll time (from `api_requests_log`). A new `/api/integrations/log` endpoint feeds a new vanilla-JS page. The legacy webhook page gets a clarifying note.

**Tech Stack:** Node 25 + TypeScript (strict), Express 5, MariaDB/MySQL (mysql2/promise), vanilla HTML/CSS/JS, Vitest.

**Spec:** [docs/superpowers/specs/2026-06-02-integration-activity-log-design.md](../specs/2026-06-02-integration-activity-log-design.md)

---

## Testing reality

Same as prior plans: the DB-backed Vitest suite is dormant (all `tests/database/*`
skipped; this env's DB has `STRICT_TRANS_TABLES` so over-length inserts THROW —
hence the summary/detail clamps). The writer/repo hit the DB, so they're verified
by `tsc` + the full suite staying green + manual/live checks after deploy. No
`describe.skip` placeholder tests.

Run the suite: `npm test`. Baseline: 236 passed / 58 skipped.

---

## File Structure

**Backend:**
- `src/database/migrations.ts` — append migration 32 (Modify).
- `src/integration/integrationLog.ts` — `logIntegrationEvent()` writer + `IntegrationName` type (Create).
- `src/database/repositories/integrationEventRepo.ts` — `recent()`, `last1cPollAt()`, `prune()` (Create).
- `src/api/routes/integrations.ts` — `GET /log` (Create).
- `src/api/server.ts` — import + mount the router (Modify).
- `src/index.ts` — wire `prune(90)` into the daily cron (Modify).
- Instrumentation (Modify, one `logIntegrationEvent(...)` call each):
  `src/api/routes/invoices.ts`, `src/integration/webhook.ts`,
  `src/api/routes/webhook.ts`, `src/api/routes/nomenclature.ts`,
  `src/api/routes/sber.ts`, `src/api/routes/settings.ts`.

**Frontend:**
- `public/app.html` — nav item, `view-integrations-log` section, webhook note (Modify).
- `public/js/app.js` — `#/integrations-log` route (Modify).
- `public/js/integrations-log.js` — the page module (Create).
- `public/app.html` — `<script src="js/integrations-log.js">` include (Modify).

---

## Task 1: Migration 32 — `integration_events` table

**Files:** Modify `src/database/migrations.ts` (append after the `version: 31` object, before the closing `];`).

- [ ] **Step 1: Append the migration**

```typescript
  {
    version: 32,
    name: 'integration_events — activity log for 1C/Sber/webhook actions',
    detect: (exec) => hasTable(exec, 'integration_events'),
    run: async (exec) => {
      await exec.query(`
        CREATE TABLE IF NOT EXISTS integration_events (
          id           INT AUTO_INCREMENT PRIMARY KEY,
          ts           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
          integration  VARCHAR(16)   NOT NULL,
          event_type   VARCHAR(48)   NOT NULL,
          status       VARCHAR(8)    NOT NULL DEFAULT 'ok',
          invoice_id   INT           NULL,
          summary      VARCHAR(512)  NOT NULL,
          detail       TEXT          NULL,
          INDEX idx_integration_events_ts (ts),
          INDEX idx_integration_events_integration (integration)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    },
  },
```

- [ ] **Step 2: Type-check** — `npx tsc --noEmit` → PASS.
- [ ] **Step 3: Commit**

```bash
git add src/database/migrations.ts
git commit -m "feat(db): migration 32 — integration_events activity-log table"
```

---

## Task 2: Writer + read repo

**Files:** Create `src/integration/integrationLog.ts`, `src/database/repositories/integrationEventRepo.ts`.

- [ ] **Step 1: Create the read repo** `src/database/repositories/integrationEventRepo.ts`

```typescript
import { getDb } from '../db';

export interface IntegrationEvent {
  id: number;
  ts: string;
  integration: string;
  event_type: string;
  status: string;
  invoice_id: number | null;
  summary: string;
  detail: string | null;
}

export const integrationEventRepo = {
  async recent(opts: { integration?: string; limit?: number; offset?: number } = {}): Promise<IntegrationEvent[]> {
    const lim = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 100)));
    const off = Math.max(0, Math.floor(opts.offset ?? 0));
    if (opts.integration) {
      return getDb().prepare(
        `SELECT * FROM integration_events WHERE integration = ? ORDER BY ts DESC, id DESC LIMIT ${lim} OFFSET ${off}`
      ).all<IntegrationEvent>(opts.integration);
    }
    return getDb().prepare(
      `SELECT * FROM integration_events ORDER BY ts DESC, id DESC LIMIT ${lim} OFFSET ${off}`
    ).all<IntegrationEvent>();
  },

  // Derived 1C "connection" signal: the most recent time 1C polled /pending.
  // Bounded by api_requests_log's 7-day retention — null means no poll in that window.
  async last1cPollAt(): Promise<string | null> {
    const row = await getDb().prepare(
      `SELECT MAX(timestamp) AS t FROM api_requests_log WHERE path LIKE '/api/invoices/pending%'`
    ).get<{ t: string | null }>();
    return row?.t ?? null;
  },

  async prune(days = 90): Promise<number> {
    const d = Math.max(1, Math.floor(days));
    const r = await getDb().prepare(
      `DELETE FROM integration_events WHERE ts < (NOW() - INTERVAL ${d} DAY)`
    ).run();
    return r.changes;
  },
};
```

(LIMIT/OFFSET are inlined after `Math.floor`/clamp — the mysql2 named-placeholder
pool can't bind LIMIT; this mirrors `invoiceRepo.getAll`. `integration` is bound.)

- [ ] **Step 2: Create the writer** `src/integration/integrationLog.ts`

```typescript
import { getDb } from '../database/db';
import { logger } from '../utils/logger';

export type IntegrationName = '1c' | 'sber' | 'webhook' | 'nomenclature';

export interface IntegrationEventInput {
  integration: IntegrationName;
  event_type: string;
  status?: 'ok' | 'error' | 'info';
  invoice_id?: number | null;
  summary: string;
  detail?: unknown;
}

/**
 * Append one row to integration_events. NEVER throws — an audit-log write must
 * not break the action it records (mirrors notifications/events.ts emit()).
 * summary clamped to 512, detail (JSON) clamped to 4000 to satisfy STRICT mode.
 */
export async function logIntegrationEvent(e: IntegrationEventInput): Promise<void> {
  try {
    const summary = String(e.summary ?? '').slice(0, 512);
    let detail: string | null = null;
    if (e.detail != null) {
      const raw = typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail);
      detail = raw.slice(0, 4000);
    }
    await getDb().prepare(
      `INSERT INTO integration_events (integration, event_type, status, invoice_id, summary, detail)
       VALUES (:integration, :event_type, :status, :invoice_id, :summary, :detail)`
    ).run({
      integration: e.integration,
      event_type: e.event_type,
      status: e.status ?? 'ok',
      invoice_id: e.invoice_id ?? null,
      summary,
      detail,
    });
  } catch (err) {
    logger.error('logIntegrationEvent failed (swallowed)', { error: (err as Error).message, event_type: e.event_type });
  }
}
```

- [ ] **Step 3:** `npx tsc --noEmit` → PASS. **Commit**

```bash
git add src/integration/integrationLog.ts src/database/repositories/integrationEventRepo.ts
git commit -m "feat(integration): integration_events writer + read repo"
```

---

## Task 3: Instrument 1C lifecycle + Sber in invoices.ts

**Files:** Modify `src/api/routes/invoices.ts`.

- [ ] **Step 1: Import the writer** (after the `emit as emitNotification` import, ~line 17)

```typescript
import { logIntegrationEvent } from '../../integration/integrationLog';
```

- [ ] **Step 2: `POST /:id/send` (approve)** — after `await invoiceRepo.approveForOneC(id);` and the existing `emitNotification('approved_for_1c', …)` block, add:

```typescript
  void logIntegrationEvent({
    integration: '1c', event_type: 'approved', invoice_id: id,
    summary: `Накладная №${invForNotif?.invoice_number ?? id} одобрена для отправки в 1С`,
  });
```

- [ ] **Step 3: `POST /:id/confirm` (sent)** — after `await invoiceRepo.markSent(id);` + the clear of `approved_for_1c`, near the `emitNotification('sent_to_1c', …)`:

```typescript
  void logIntegrationEvent({
    integration: '1c', event_type: 'sent', invoice_id: id,
    summary: `Накладная №${invConfirmed?.invoice_number ?? id} загружена в 1С (подтверждено)`,
  });
```

- [ ] **Step 4: `POST /:id/reset`** — after the `UPDATE invoices SET status='processed' …` run:

```typescript
  void logIntegrationEvent({
    integration: '1c', event_type: 'reset', invoice_id: id,
    summary: `Статус накладной №${invoice.invoice_number ?? id} сброшен (можно отправить в 1С заново)`,
  });
```

- [ ] **Step 5: `POST /:id/unapprove`** — after `await invoiceRepo.unapproveForOneC(id);`:

```typescript
  void logIntegrationEvent({
    integration: '1c', event_type: 'unapproved', invoice_id: id,
    summary: `Отозвана отправка накладной №${invoice.invoice_number ?? id} в 1С`,
  });
```

- [ ] **Step 6: `POST /:id/send-sber`** — in the success branch (after `sberPaymentRepo.updateStatus(id, { status: 'created', … })`):

```typescript
    void logIntegrationEvent({
      integration: 'sber', event_type: 'payment_created', invoice_id: id,
      summary: `Платёж в Сбербанк по №${invoice.invoice_number ?? id} создан (черновик)${result.number ? `, № ${result.number}` : ''}`,
    });
```

  and in BOTH failure branches (the `SberApiError` catch and the generic catch, where `sberPaymentRepo.updateStatus(id, { status: 'failed', … })` is called):

```typescript
    // SberApiError branch:
    void logIntegrationEvent({
      integration: 'sber', event_type: 'payment_failed', status: 'error', invoice_id: id,
      summary: `Ошибка платежа в Сбербанк по №${invoice.invoice_number ?? id}: HTTP ${err.status}`,
      detail: err.body,
    });
    // generic catch branch:
    void logIntegrationEvent({
      integration: 'sber', event_type: 'payment_failed', status: 'error', invoice_id: id,
      summary: `Ошибка платежа в Сбербанк по №${invoice.invoice_number ?? id}`,
      detail: (err as Error).message,
    });
```

- [ ] **Step 7:** `npx tsc --noEmit` → PASS; `npm test` → 236/58. **Commit**

```bash
git add src/api/routes/invoices.ts
git commit -m "feat(integration): log 1C lifecycle + Sber payment events"
```

---

## Task 4: Instrument webhook, nomenclature, sber config, analyzer flags

**Files:** Modify `src/integration/webhook.ts`, `src/api/routes/webhook.ts`, `src/api/routes/nomenclature.ts`, `src/api/routes/sber.ts`, `src/api/routes/settings.ts`.

- [ ] **Step 1: `src/integration/webhook.ts` — `sendToWebhook()`** Import the writer
  (`import { logIntegrationEvent } from './integrationLog';`). After a successful
  POST (HTTP < 400) and on failure, log:

```typescript
  // success path (after response.status < 400 confirmed):
  void logIntegrationEvent({
    integration: 'webhook', event_type: 'webhook_sent', invoice_id: invoiceId,
    summary: `Вебхук по накладной №${invoiceId} отправлен (HTTP ${response.status})`,
  });
  // failure path (4xx/5xx or thrown):
  void logIntegrationEvent({
    integration: 'webhook', event_type: 'webhook_failed', status: 'error', invoice_id: invoiceId,
    summary: `Ошибка вебхука по накладной №${invoiceId} (HTTP ${response?.status ?? '?'})`,
  });
```

  (Place the failure call where the function returns false / catches; keep it
  inside the existing try/catch — `logIntegrationEvent` never throws.)

- [ ] **Step 2: `src/api/routes/webhook.ts` — `PUT /config`** After the config is
  saved successfully, add (import the writer first):

```typescript
  void logIntegrationEvent({
    integration: 'webhook', event_type: 'config_changed',
    summary: `Изменены настройки вебхука: ${body.enabled ? 'включён' : 'выключен'}`,
  });
```

- [ ] **Step 3: `src/api/routes/nomenclature.ts` — `POST /sync`** After the
  successful upsert (where `upserted` is known, ~line 39), add (import writer):

```typescript
  void logIntegrationEvent({
    integration: 'nomenclature', event_type: 'catalog_synced',
    summary: `Справочник 1С синхронизирован: ${upserted} позиц.`,
  });
```

- [ ] **Step 4: `src/api/routes/sber.ts` — connect & disconnect** Import the writer.
  In the OAuth `callback` success and the `seed-token` success handlers, log
  `sber/config_changed` «Сбербанк подключён»; in the disconnect handler (find the
  `router.post('/disconnect'…` or `delete` handler), log «Сбербанк отключён»:

```typescript
  void logIntegrationEvent({ integration: 'sber', event_type: 'config_changed', summary: 'Сбербанк подключён' });
  // disconnect:
  void logIntegrationEvent({ integration: 'sber', event_type: 'config_changed', summary: 'Сбербанк отключён' });
```

- [ ] **Step 5: `src/api/routes/settings.ts` — `PATCH /analyzer`** Import the writer.
  Read the current flags BEFORE the update so you can detect a change, then after
  `updateAnalyzerConfig(...)`, log ONLY when an auto-send flag actually flipped:

```typescript
  const before = await invoiceRepo.getAnalyzerConfig();
  // ... existing update ...
  if (auto1c !== undefined && auto1c !== before.auto_send_1c) {
    void logIntegrationEvent({ integration: '1c', event_type: 'config_changed',
      summary: `Авто-отправка в 1С ${auto1c ? 'включена' : 'выключена'}` });
  }
  if (autoSber !== undefined && autoSber !== before.auto_send_sber) {
    void logIntegrationEvent({ integration: 'sber', event_type: 'config_changed',
      summary: `Авто-отправка в Сбербанк ${autoSber ? 'включена' : 'выключена'}` });
  }
```

  (Do NOT log OCR mode / key / llm-mapper changes — not integration actions.)

- [ ] **Step 6:** `npx tsc --noEmit` → PASS; `npm test` → 236/58. **Commit**

```bash
git add src/integration/webhook.ts src/api/routes/webhook.ts src/api/routes/nomenclature.ts src/api/routes/sber.ts src/api/routes/settings.ts
git commit -m "feat(integration): log webhook, catalog sync, Sber connect, auto-send flags"
```

---

## Task 5: API endpoint + mount + prune cron

**Files:** Create `src/api/routes/integrations.ts`; Modify `src/api/server.ts`, `src/index.ts`.

- [ ] **Step 1: Create `src/api/routes/integrations.ts`**

```typescript
import { Router, Request, Response } from 'express';
import { integrationEventRepo } from '../../database/repositories/integrationEventRepo';

const router = Router();

// GET /api/integrations/log?integration=1c|sber|webhook|nomenclature&limit=&offset=
router.get('/log', async (req: Request, res: Response) => {
  const integration = req.query.integration as string | undefined;
  const allowed = ['1c', 'sber', 'webhook', 'nomenclature'];
  const filter = integration && allowed.includes(integration) ? integration : undefined;
  const limit = parseInt(req.query.limit as string, 10);
  const offset = parseInt(req.query.offset as string, 10);
  const data = await integrationEventRepo.recent({
    integration: filter,
    limit: Number.isFinite(limit) ? limit : 100,
    offset: Number.isFinite(offset) ? offset : 0,
  });
  const onec_last_poll_at = await integrationEventRepo.last1cPollAt();
  res.json({ data, onec_last_poll_at });
});

export default router;
```

- [ ] **Step 2: Mount in `src/api/server.ts`** — add the import next to the other
  route imports (~line 26): `import integrationsRouter from './routes/integrations';`
  and mount after the `suppliers` line (~line 221):
  `app.use('/api/integrations', apiKeyAuth, integrationsRouter);`

- [ ] **Step 3: Prune cron in `src/index.ts`** — in the daily cleanup block (~line
  111-114 where `cleanupOldRequestLogs()` runs), add alongside it:

```typescript
  const { integrationEventRepo } = await import('./database/repositories/integrationEventRepo');
  integrationEventRepo.prune(90)
    .then(n => { if (n > 0) logger.info('Pruned old integration_events', { deleted: n }); })
    .catch(err => logger.error('integration_events prune failed', { error: (err as Error).message }));
```

  (Match the exact style of the adjacent `cleanupOldRequestLogs()` call — if it's a
  top-level import + `.then/.catch`, mirror that instead of the dynamic import.)

- [ ] **Step 4:** `npx tsc --noEmit` → PASS; `npm test` → 236/58. **Commit**

```bash
git add src/api/routes/integrations.ts src/api/server.ts src/index.ts
git commit -m "feat(integration): GET /api/integrations/log + 90-day prune cron"
```

---

## Task 6: Frontend — «Журнал» page + nav + webhook note

**Files:** Modify `public/app.html`, `public/js/app.js`; Create `public/js/integrations-log.js`.

- [ ] **Step 1: Nav item** In `public/app.html` Интеграции `nav-menu` (the block with
  Сбербанк + Webhook 1C, ~lines 52-55), add a third link:

```html
            <a href="#/integrations-log" data-tab="integrations-log" role="menuitem">Журнал</a>
```

  and extend the group trigger's `data-tab` (line 47) to
  `data-tab="sber,webhook,integrations-log"` so the group stays highlighted.

- [ ] **Step 2: Section markup** In `public/app.html`, add a new section near the
  other integration views (search for `id="view-webhook"` and add after its
  closing `</section>`):

```html
    <section id="view-integrations-log" style="display:none">
      <div class="section-header"><h1 class="section-h1">Журнал интеграций</h1></div>
      <div id="intlog-onec-status" class="card" style="margin-bottom:12px"></div>
      <div class="filters" id="intlog-filters"></div>
      <div class="table-wrap">
        <table class="invoices-table">
          <thead><tr>
            <th>Время</th><th>Интеграция</th><th>Событие</th><th>Описание</th>
          </tr></thead>
          <tbody id="intlog-tbody"></tbody>
        </table>
      </div>
    </section>
```

- [ ] **Step 3: Script include** In `public/app.html`, next to the other
  `<script src="js/...">` includes, add `<script src="js/integrations-log.js"></script>`.

- [ ] **Step 4: Routing** In `public/js/app.js` `navigate()` (the `else if
  (hash === '#/webhook')` chain, ~line 169), add:

```javascript
    } else if (hash === '#/integrations-log') {
      document.getElementById('view-integrations-log').style.display = 'block';
      IntegrationsLog.load();
```

  (Match the surrounding pattern: hide-all-views then show this one. Inspect how
  `#/webhook` toggles views and mirror it exactly, including any
  `IntegrationsLog` global declared in the `/* global ... */` header.)

- [ ] **Step 5: Create `public/js/integrations-log.js`**

```javascript
/* global App, IntegrationsLog */
const IntegrationsLog = {
  filter: '',

  _LABELS: { '1c': '1С', sber: 'Сбербанк', webhook: 'Webhook', nomenclature: 'Справочник 1С' },
  _COLORS: { '1c': '#2563eb', sber: '#16a34a', webhook: '#7c3aed', nomenclature: '#0891b2' },

  async load() {
    this._renderFilters();
    const tbody = document.getElementById('intlog-tbody');
    tbody.innerHTML = '';
    try {
      const url = '/integrations/log?limit=100' + (this.filter ? `&integration=${this.filter}` : '');
      const { data, onec_last_poll_at } = await App.apiJson(url);
      this._renderOnecStatus(onec_last_poll_at);
      if (!data || data.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state">Событий пока нет</div></td></tr>`;
        return;
      }
      tbody.innerHTML = data.map(ev => {
        const label = this._LABELS[ev.integration] || App.esc(ev.integration);
        const color = this._COLORS[ev.integration] || '#64748b';
        const badge = `<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:${color}1a;color:${color};font-weight:600;font-size:12px">${label}</span>`;
        const err = ev.status === 'error' ? ' style="color:#dc2626"' : '';
        const link = ev.invoice_id ? ` <a href="#/invoices/${ev.invoice_id}">№${ev.invoice_id}</a>` : '';
        return `<tr${err}>
          <td style="white-space:nowrap">${App.formatDateTime(ev.ts)}</td>
          <td>${badge}</td>
          <td>${App.esc(ev.event_type)}</td>
          <td>${App.esc(ev.summary)}${link}</td>
        </tr>`;
      }).join('');
    } catch (e) {
      console.error('Failed to load integration log', e);
      App.notify('Ошибка загрузки журнала', 'error');
    }
  },

  _renderOnecStatus(pollAt) {
    const el = document.getElementById('intlog-onec-status');
    if (!el) return;
    if (pollAt) {
      el.innerHTML = `<strong style="color:#16a34a">✓ 1С на связи</strong> — последний запрос: ${App.formatDateTime(pollAt)}
        <div class="muted" style="font-size:12px;margin-top:2px">1С сама забирает одобренные накладные (опрос). Webhook — отдельная необязательная интеграция.</div>`;
    } else {
      el.innerHTML = `<strong style="color:#b45309">1С пока не обращалась к серверу</strong>
        <div class="muted" style="font-size:12px;margin-top:2px">За последние 7 дней опросов не было. Это нормально, если в 1С ещё не запускали обработку загрузки.</div>`;
    }
  },

  _renderFilters() {
    const el = document.getElementById('intlog-filters');
    if (!el) return;
    const opts = [ ['', 'Все'], ['1c', '1С'], ['sber', 'Сбербанк'], ['webhook', 'Webhook'] ];
    el.innerHTML = opts.map(([k, lbl]) =>
      `<button class="filter-btn ${this.filter === k ? 'active' : ''}" onclick="IntegrationsLog.setFilter('${k}')">${lbl}</button>`
    ).join('');
  },

  setFilter(k) { this.filter = k; this.load(); },
};
```

  (`App.formatDateTime` already exists — added with the История tab.)

- [ ] **Step 6: Webhook page note** In `public/app.html` `view-webhook` section, add
  a muted explanatory card near the top:

```html
      <div class="card" style="background:#f8fafc;border-color:#e2e8f0;margin-bottom:12px">
        <p class="muted" style="margin:0">Это <strong>необязательный</strong> устаревший вебхук. Основная интеграция с 1С работает по опросу — 1С сама забирает одобренные накладные. Реальный статус 1С и журнал действий — на странице <a href="#/integrations-log">«Журнал»</a>.</p>
      </div>
```

- [ ] **Step 7: Validate** `node --check public/js/integrations-log.js` → exit 0;
  `node --check public/js/app.js` → exit 0. **Commit**

```bash
git add public/app.html public/js/app.js public/js/integrations-log.js
git commit -m "feat(ui): «Журнал интеграций» page + 1C status + webhook clarifying note"
```

---

## Task 7: End-to-end verification

- [ ] **Step 1:** `npx tsc --noEmit` (clean) + `npm test` (236/58).
- [ ] **Step 2 (manual/live, after deploy):** open «Интеграции → Журнал».
  Expect the 1С-status banner (green if 1С polled recently, amber otherwise) and an
  events table (or empty state). Perform: approve an invoice for 1С → row
  `1С / approved`; reset it → `1С / reset`; (if Sber connected) send to Sber →
  `Сбербанк / payment_created` or a red `payment_failed` row. Confirm the «Webhook
  1C» page now shows the clarifying note.
- [ ] **Step 3:** SQL sanity (read-only) — `SELECT integration, event_type, status,
  invoice_id, LEFT(summary,60) FROM integration_events ORDER BY id DESC LIMIT 10;`
  shows the new rows.

---

## Self-review notes (author)

- **Spec coverage:** table (T1), writer+repo (T2), 1C+Sber instrumentation (T3),
  webhook/nomenclature/sber-config/auto-send (T4), endpoint+mount+prune (T5),
  page+nav+1C-status+webhook-note (T6), verification (T7). All spec sections map.
- **Type consistency:** `logIntegrationEvent` / `IntegrationEventInput` /
  `IntegrationName` used identically across T2–T4; `integrationEventRepo.recent/
  last1cPollAt/prune` defined in T2 and consumed in T5; `IntegrationEvent` fields
  (`ts, integration, event_type, status, invoice_id, summary, detail`) match the
  T1 columns and the T6 render. `App.formatDateTime` exists (История tab).
- **Safety:** writer never throws + clamps (STRICT mode); `invoice_id` no FK;
  endpoint validates the `integration` filter against an allow-list; LIMIT inlined
  after clamp (no positional-LIMIT bind issue); all rendered text via `App.esc`.
