# Sber Business Payments — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Кнопка «Отправить в Сбербанк» на странице деталей накладной создаёт черновик платёжного поручения в СберБизнес. Реквизиты получателя берутся из локального справочника `suppliers` (lazy-create на первой отправке + ручная страница CRUD + опциональный DaData-lookup). Подключение к Сберу — manual seed-token + OAuth fallback. Шаблон назначения платежа кастомизируется в настройках, дефолт — простой со ссылкой на номер/дату накладной и НДС.

**Architecture:** Новый модуль `src/sber/` (mTLS клиент + OAuth + payments + purpose template + redact). Три новые таблицы (`sber_tokens`, `suppliers`, `sber_payments`) в одной миграции 20, плюс две колонки в `invoices` (`supplier_kpp`) и `users` (`sber_purpose_template`). Два новых API-префикса `/api/sber/*` и `/api/suppliers/*`, один новый action `POST /api/invoices/:id/send-sber`. Frontend — две новых страницы (`/#/sber`, `/#/suppliers`) и новая секция в `/#/invoices/:id`.

**Tech Stack:** Node 25 + TypeScript strict, Express 5, better-sqlite3, vitest+supertest. Новые dep'ы: `jose` (JWT для OAuth state). Sber API — `node:https` напрямую (PFX/passphrase mTLS), без undici (mTLS+pfx через undici Agent неудобен). DaData — fetch через прокси-функцию.

**Spec:** [`docs/superpowers/specs/2026-05-06-sber-business-payments-design.md`](../specs/2026-05-06-sber-business-payments-design.md)

**Baseline:** 11 test files / 167 tests passing on `feature/sber-business-payments` branch (commit `bd583ac`).

---

## File Structure

**Создаются (new files):**

Backend:
- `src/sber/sberClient.ts` — mTLS HTTPS wrapper (`sberFetch(url, opts)`), читает PFX через fs+passphrase
- `src/sber/oauth.ts` — `createOAuthState/verifyOAuthState/exchangeCodeForToken/refreshAccessToken/getValidToken/buildAuthUrl`
- `src/sber/payments.ts` — `createPaymentOrder(token, payload)` + типы `PaymentOrderPayload/PaymentOrderResponse`
- `src/sber/purposeTemplate.ts` — `renderPurpose(template, ctx)` с плейсхолдерами + `sanitizePurpose` + `formatVatClause`
- `src/sber/dadata.ts` — `lookupPartyByInn(inn)`
- `src/sber/redact.ts` — `redact(obj, keys)` для логов/persistence
- `src/sber/clientInfo.ts` — `fetchClientInfo(token)` для подтягивания org_name + account из Sber
- `src/database/repositories/sberTokenRepo.ts`
- `src/database/repositories/supplierRepo.ts`
- `src/database/repositories/sberPaymentRepo.ts`
- `src/api/routes/sber.ts`
- `src/api/routes/suppliers.ts`

Tests:
- `tests/sber/redact.test.ts`
- `tests/sber/sberClient.test.ts`
- `tests/sber/oauth.test.ts`
- `tests/sber/payments.test.ts`
- `tests/sber/purposeTemplate.test.ts`
- `tests/sber/dadata.test.ts`
- `tests/sber/clientInfo.test.ts`
- `tests/database/sberTokenRepo.test.ts`
- `tests/database/supplierRepo.test.ts`
- `tests/database/sberPaymentRepo.test.ts`
- `tests/api/sber.test.ts`
- `tests/api/suppliers.test.ts`
- `tests/api/invoices.send-sber.test.ts`

Frontend:
- `public/js/sber.js` — модуль страницы `/#/sber` (подключение/отключение, форма seed-token)
- `public/js/suppliers.js` — модуль страницы `/#/suppliers` (CRUD)
- `public/js/sber-modal.js` — общий компонент модалки подтверждения реквизитов поставщика (используется из `invoices.js`)

Config:
- `certs/` — папка для `.p12` и `.pem` (gitignored, создаётся пустой с `.gitkeep`)

**Изменяются (modified files):**

- `src/database/migrations.ts` — миграция 20 (одна, с тремя таблицами + двумя ALTER'ами)
- `src/database/repositories/invoiceRepo.ts` — добавить `supplier_kpp` в Invoice interface, в SELECT, в create
- `src/database/repositories/userRepo.ts` — добавить `getPurposeTemplate(id)/setPurposeTemplate(id, tpl)` и поле в `User`
- `src/api/routes/invoices.ts` — добавить `POST /:id/send-sber`, `GET /:id/sber-status`
- `src/api/server.ts` — mount `sberRouter`, `suppliersRouter`
- `src/ocr/claudeApiAnalyzer.ts` — добавить инструкцию извлекать `supplier_kpp` в промпт + поле в результат
- `src/ocr/types.ts` — `supplier_kpp?: string` в `AnalyzedInvoice`
- `public/app.html` — добавить пункты nav «Поставщики» и «Сбер», секции `view-suppliers` / `view-sber`, секция Сбербанка в `view-invoice-detail`
- `public/js/invoices.js` — обновить рендер деталей: добавить вызов `Sber.renderInvoiceSection(data)`
- `public/js/app.js` (router) — зарегистрировать новые роуты `/suppliers` и `/sber`
- `.env.example` — секция Sber и DaData переменных
- `.gitignore` — `certs/` и `DocsApiSber/`
- `CLAUDE.md` — секция «Sber интеграция» + добавить файлы в директории
- `package.json` — `jose@^5` в dependencies

**Не трогаем:** старые тесты, миграции 1-19, любые pre-existing changes в WIP-файлах (.env.example уже частично изменён, аккуратно мержим).

---

## Task 0: Setup — спрятать чужие правки и подготовить окружение

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Verify baseline tests pass**

```powershell
npx vitest run
```

Expected: `Test Files 11 passed (11) | Tests 167 passed (167)`. Если не — расследовать прежде чем стартовать.

- [ ] **Step 2: Спрятать чужие незакоммиченные правки в stash**

В git status есть 6+ модифицированных файлов с правками от прошлых сессий, не относящихся к Sber-фиче. Прячем чтобы не мешали.

```powershell
git stash push -m "WIP: pre-existing changes (May 6 session — sber start)" -- src/config.ts src/index.ts src/watcher/fileWatcher.ts .env.example src/ocr/claudeApiAnalyzer.ts src/scripts/test-pipeline.ts public/css/landing.css public/index.html
git status --short
```

Expected: `Modified` строк нет; могут быть untracked типа `Certs/`, `DocsApiSber/` — оставляем.

- [ ] **Step 3: Установить `jose`**

```powershell
npm install jose
```

Expected: добавляет в `package.json`. Версия пятая или новее.

- [ ] **Step 4: Создать пустую папку `certs/`**

```powershell
New-Item -ItemType Directory -Force -Path certs
New-Item -ItemType File -Force -Path certs\.gitkeep
```

- [ ] **Step 5: Обновить `.gitignore`**

В `.gitignore` после строки `google-credentials.json` (строка 12) добавить:

```
# Sber TLS certificates (server-only)
certs/*
!certs/.gitkeep
DocsApiSber/
```

- [ ] **Step 6: Verify build still passes**

```powershell
npx tsc --noEmit
```

Expected: 0 ошибок.

- [ ] **Step 7: Commit**

```powershell
git add package.json package-lock.json .gitignore certs/.gitkeep
git commit -m "chore(sber): install jose, add certs/ to gitignore"
```

---

## Task 1: Миграция 20 — БД-схема

**Files:**
- Modify: `src/database/migrations.ts` (добавить новый объект в массив `MIGRATIONS`)
- Test: `tests/database/migration-20.test.ts`

- [ ] **Step 1: Failing test — миграция создаёт все нужные сущности**

Создать `tests/database/migration-20.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/database/migrations';

describe('migration 20 — Sber schema', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => db.close());

  it('creates sber_tokens with id=1 constraint', () => {
    const cols = db.prepare(`PRAGMA table_info(sber_tokens)`).all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    expect(names).toEqual(expect.arrayContaining([
      'id', 'access_token', 'refresh_token', 'expires_at',
      'account_number', 'org_name', 'payer_inn', 'payer_kpp',
      'payer_bank_bic', 'payer_bank_corr_account',
      'created_at', 'updated_at',
    ]));
    // CHECK (id = 1) — second insert with id=2 must fail
    db.prepare('INSERT INTO sber_tokens (id, access_token, refresh_token, expires_at) VALUES (1, ?, ?, ?)').run('a', 'r', '2099-01-01');
    expect(() => {
      db.prepare('INSERT INTO sber_tokens (id, access_token, refresh_token, expires_at) VALUES (2, ?, ?, ?)').run('a', 'r', '2099-01-01');
    }).toThrow();
  });

  it('creates suppliers with INN as PK', () => {
    const cols = db.prepare(`PRAGMA table_info(suppliers)`).all() as Array<{ name: string; pk: number }>;
    const names = cols.map(c => c.name);
    expect(names).toEqual(expect.arrayContaining([
      'inn', 'name', 'kpp', 'account', 'bank_bic', 'bank_corr_account',
      'bank_name', 'address', 'verified', 'source', 'notes',
      'created_at', 'updated_at', 'last_used_at',
    ]));
    expect(cols.find(c => c.name === 'inn')?.pk).toBe(1);
  });

  it('creates sber_payments with UNIQUE invoice_id', () => {
    db.prepare(`
      INSERT INTO invoices (file_name, file_path, total_sum, status)
      VALUES ('a.jpg', '/a.jpg', 100, 'processed')
    `).run();
    const invoiceId = (db.prepare('SELECT last_insert_rowid() as id').get() as { id: number }).id;

    db.prepare(`
      INSERT INTO sber_payments (invoice_id, external_id, status, payment_purpose, amount, payer_account, payee_inn)
      VALUES (?, 'uuid1', 'created', 'p', 100, '40702', '5012')
    `).run(invoiceId);

    expect(() => {
      db.prepare(`
        INSERT INTO sber_payments (invoice_id, external_id, status, payment_purpose, amount, payer_account, payee_inn)
        VALUES (?, 'uuid2', 'created', 'p', 100, '40702', '5012')
      `).run(invoiceId);
    }).toThrow(/UNIQUE/);
  });

  it('adds invoices.supplier_kpp column', () => {
    const cols = db.prepare(`PRAGMA table_info(invoices)`).all() as Array<{ name: string }>;
    expect(cols.map(c => c.name)).toContain('supplier_kpp');
  });

  it('adds users.sber_purpose_template column with default', () => {
    const cols = db.prepare(`PRAGMA table_info(users)`).all() as Array<{ name: string; dflt_value: string | null }>;
    const col = cols.find(c => c.name === 'sber_purpose_template');
    expect(col).toBeDefined();
    expect(col?.dflt_value).toContain('{invoice_number}');
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```powershell
npx vitest run tests/database/migration-20.test.ts
```

Expected: FAIL — таблицы не существуют.

- [ ] **Step 3: Add migration 20 в `src/database/migrations.ts`**

В конец массива `MIGRATIONS` (после миграции 19) добавить:

```typescript
{
  version: 20,
  name: 'Sber Business payments',
  detect: (db) =>
    hasTable(db, 'sber_tokens') &&
    hasTable(db, 'suppliers') &&
    hasTable(db, 'sber_payments') &&
    hasColumn(db, 'invoices', 'supplier_kpp') &&
    hasColumn(db, 'users', 'sber_purpose_template'),
  run: (db) => {
    if (!hasTable(db, 'sber_tokens')) {
      db.exec(`
        CREATE TABLE sber_tokens (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          access_token TEXT NOT NULL,
          refresh_token TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          account_number TEXT,
          org_name TEXT,
          payer_inn TEXT,
          payer_kpp TEXT,
          payer_bank_bic TEXT,
          payer_bank_corr_account TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    }
    if (!hasTable(db, 'suppliers')) {
      db.exec(`
        CREATE TABLE suppliers (
          inn TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          kpp TEXT,
          account TEXT,
          bank_bic TEXT NOT NULL,
          bank_corr_account TEXT,
          bank_name TEXT,
          address TEXT,
          verified INTEGER NOT NULL DEFAULT 0,
          source TEXT,
          notes TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_used_at TEXT
        );
        CREATE INDEX idx_suppliers_name ON suppliers(name COLLATE NOCASE);
      `);
    }
    if (!hasTable(db, 'sber_payments')) {
      db.exec(`
        CREATE TABLE sber_payments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          invoice_id INTEGER NOT NULL UNIQUE,
          external_id TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL,
          payment_purpose TEXT NOT NULL,
          amount REAL NOT NULL,
          payer_account TEXT NOT NULL,
          payee_inn TEXT NOT NULL,
          request_payload TEXT,
          response_body TEXT,
          sber_payment_number TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_sber_payments_invoice_id ON sber_payments(invoice_id);
      `);
    }
    if (!hasColumn(db, 'invoices', 'supplier_kpp')) {
      db.exec(`ALTER TABLE invoices ADD COLUMN supplier_kpp TEXT`);
    }
    if (!hasColumn(db, 'users', 'sber_purpose_template')) {
      db.exec(`
        ALTER TABLE users ADD COLUMN sber_purpose_template TEXT
          DEFAULT 'Оплата по накладной № {invoice_number} от {invoice_date_dot}, {vat_clause}'
      `);
    }
  },
},
```

- [ ] **Step 4: Run test — verify it passes**

```powershell
npx vitest run tests/database/migration-20.test.ts
```

Expected: PASS, 5/5.

- [ ] **Step 5: Run full test suite — verify nothing broke**

```powershell
npx vitest run
```

Expected: 12 test files / 172 tests pass (был 167, +5).

- [ ] **Step 6: Commit**

```powershell
git add src/database/migrations.ts tests/database/migration-20.test.ts
git commit -m "feat(db): migration 20 — sber_tokens, suppliers, sber_payments tables"
```

---

## Task 2a: `redact` utility

**Files:**
- Create: `src/sber/redact.ts`
- Test: `tests/sber/redact.test.ts`

- [ ] **Step 1: Failing test**

`tests/sber/redact.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { redact } from '../../src/sber/redact';

describe('redact', () => {
  it('masks secret keys in flat object', () => {
    const out = redact({ access_token: 'abc', client_id: '40285' });
    expect(out).toEqual({ access_token: '***', client_id: '40285' });
  });

  it('masks secret keys recursively', () => {
    const out = redact({
      data: { refresh_token: 'r', payer: { name: 'X', payerAccount: '4070' } },
    });
    expect(out).toEqual({
      data: { refresh_token: '***', payer: { name: 'X', payerAccount: '***' } },
    });
  });

  it('returns null/undefined as-is', () => {
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
  });

  it('handles arrays', () => {
    const out = redact([{ access_token: 'a' }, { name: 'b' }]);
    expect(out).toEqual([{ access_token: '***' }, { name: 'b' }]);
  });

  it('does not mutate input', () => {
    const input = { access_token: 'abc' };
    redact(input);
    expect(input.access_token).toBe('abc');
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

```powershell
npx vitest run tests/sber/redact.test.ts
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement `src/sber/redact.ts`**

```typescript
const SECRET_KEYS = new Set([
  'access_token',
  'refresh_token',
  'client_secret',
  'api_key',
  'password',
  'pfx_password',
  'payerAccount',
  'payeeAccount',
  'payer_account',
  'payee_account',
]);

export function redact<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((v) => redact(v)) as unknown as T;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.has(k) ? '***' : redact(v);
    }
    return out as unknown as T;
  }
  return value;
}
```

- [ ] **Step 4: Run — verify PASS**

```powershell
npx vitest run tests/sber/redact.test.ts
```

Expected: PASS, 5/5.

- [ ] **Step 5: Commit**

```powershell
git add src/sber/redact.ts tests/sber/redact.test.ts
git commit -m "feat(sber): redact utility for masking secrets in logs"
```

---

## Task 2b: `sberTokenRepo`

**Files:**
- Create: `src/database/repositories/sberTokenRepo.ts`
- Test: `tests/database/sberTokenRepo.test.ts`

- [ ] **Step 1: Failing test**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../helpers/db';
import { sberTokenRepo } from '../../src/database/repositories/sberTokenRepo';

describe('sberTokenRepo', () => {
  beforeEach(() => resetDb());

  it('returns null when no row exists', () => {
    expect(sberTokenRepo.get()).toBeNull();
  });

  it('upsert creates row id=1', () => {
    sberTokenRepo.upsert({
      access_token: 'a',
      refresh_token: 'r',
      expires_at: '2099-01-01T00:00:00.000Z',
      account_number: '40702810940000099835',
      org_name: 'ООО Тест',
      payer_inn: '7707083893',
      payer_kpp: '770701001',
      payer_bank_bic: '044525225',
      payer_bank_corr_account: '30101810400000000225',
    });
    const row = sberTokenRepo.get()!;
    expect(row.access_token).toBe('a');
    expect(row.account_number).toBe('40702810940000099835');
  });

  it('upsert overwrites existing row', () => {
    sberTokenRepo.upsert({ access_token: 'a', refresh_token: 'r', expires_at: '2099-01-01T00:00:00.000Z' });
    sberTokenRepo.upsert({ access_token: 'b', refresh_token: 'r2', expires_at: '2099-01-02T00:00:00.000Z' });
    expect(sberTokenRepo.get()!.access_token).toBe('b');
  });

  it('updateTokens updates only token fields', () => {
    sberTokenRepo.upsert({
      access_token: 'a', refresh_token: 'r', expires_at: '2099-01-01T00:00:00.000Z',
      account_number: '40702',
    });
    sberTokenRepo.updateTokens({ access_token: 'new-a', refresh_token: 'new-r', expires_at: '2099-02-01T00:00:00.000Z' });
    const row = sberTokenRepo.get()!;
    expect(row.access_token).toBe('new-a');
    expect(row.account_number).toBe('40702'); // unchanged
  });

  it('updatePayerDetails updates only payer fields', () => {
    sberTokenRepo.upsert({ access_token: 'a', refresh_token: 'r', expires_at: '2099-01-01T00:00:00.000Z' });
    sberTokenRepo.updatePayerDetails({ payer_inn: '7707083893', payer_bank_bic: '044525225' });
    const row = sberTokenRepo.get()!;
    expect(row.payer_inn).toBe('7707083893');
    expect(row.payer_bank_bic).toBe('044525225');
    expect(row.access_token).toBe('a');
  });

  it('clear removes the row', () => {
    sberTokenRepo.upsert({ access_token: 'a', refresh_token: 'r', expires_at: '2099-01-01T00:00:00.000Z' });
    sberTokenRepo.clear();
    expect(sberTokenRepo.get()).toBeNull();
  });
});
```

Helper `tests/helpers/db.ts` уже существует (используется в других тестах). Проверь — если не существует, создай:

```typescript
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/database/migrations';
import { setDb } from '../../src/database/db';

let testDb: Database.Database | null = null;

export function resetDb(): Database.Database {
  if (testDb) testDb.close();
  testDb = new Database(':memory:');
  runMigrations(testDb);
  setDb(testDb);
  return testDb;
}
```

(Если файл уже есть с такой же сигнатурой — пропусти эту часть; если другой — используй существующую функцию.)

- [ ] **Step 2: Run — verify FAIL**

```powershell
npx vitest run tests/database/sberTokenRepo.test.ts
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement `src/database/repositories/sberTokenRepo.ts`**

```typescript
import { getDb } from '../db';

export interface SberToken {
  id: number;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  account_number: string | null;
  org_name: string | null;
  payer_inn: string | null;
  payer_kpp: string | null;
  payer_bank_bic: string | null;
  payer_bank_corr_account: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertSberTokenInput {
  access_token: string;
  refresh_token: string;
  expires_at: string;
  account_number?: string | null;
  org_name?: string | null;
  payer_inn?: string | null;
  payer_kpp?: string | null;
  payer_bank_bic?: string | null;
  payer_bank_corr_account?: string | null;
}

export const sberTokenRepo = {
  get(): SberToken | null {
    const row = getDb().prepare('SELECT * FROM sber_tokens WHERE id = 1').get() as SberToken | undefined;
    return row ?? null;
  },

  upsert(input: UpsertSberTokenInput): void {
    getDb().prepare(`
      INSERT INTO sber_tokens (
        id, access_token, refresh_token, expires_at,
        account_number, org_name, payer_inn, payer_kpp,
        payer_bank_bic, payer_bank_corr_account, updated_at
      ) VALUES (
        1, @access_token, @refresh_token, @expires_at,
        @account_number, @org_name, @payer_inn, @payer_kpp,
        @payer_bank_bic, @payer_bank_corr_account, datetime('now')
      )
      ON CONFLICT(id) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at,
        account_number = COALESCE(excluded.account_number, sber_tokens.account_number),
        org_name = COALESCE(excluded.org_name, sber_tokens.org_name),
        payer_inn = COALESCE(excluded.payer_inn, sber_tokens.payer_inn),
        payer_kpp = COALESCE(excluded.payer_kpp, sber_tokens.payer_kpp),
        payer_bank_bic = COALESCE(excluded.payer_bank_bic, sber_tokens.payer_bank_bic),
        payer_bank_corr_account = COALESCE(excluded.payer_bank_corr_account, sber_tokens.payer_bank_corr_account),
        updated_at = datetime('now')
    `).run({
      access_token: input.access_token,
      refresh_token: input.refresh_token,
      expires_at: input.expires_at,
      account_number: input.account_number ?? null,
      org_name: input.org_name ?? null,
      payer_inn: input.payer_inn ?? null,
      payer_kpp: input.payer_kpp ?? null,
      payer_bank_bic: input.payer_bank_bic ?? null,
      payer_bank_corr_account: input.payer_bank_corr_account ?? null,
    });
  },

  updateTokens(input: { access_token: string; refresh_token: string; expires_at: string }): void {
    getDb().prepare(`
      UPDATE sber_tokens
         SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = datetime('now')
       WHERE id = 1
    `).run(input.access_token, input.refresh_token, input.expires_at);
  },

  updatePayerDetails(input: {
    account_number?: string | null;
    org_name?: string | null;
    payer_inn?: string | null;
    payer_kpp?: string | null;
    payer_bank_bic?: string | null;
    payer_bank_corr_account?: string | null;
  }): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push(`updated_at = datetime('now')`);
    getDb().prepare(`UPDATE sber_tokens SET ${sets.join(', ')} WHERE id = 1`).run(...vals);
  },

  clear(): void {
    getDb().prepare('DELETE FROM sber_tokens WHERE id = 1').run();
  },
};
```

- [ ] **Step 4: Run — verify PASS**

```powershell
npx vitest run tests/database/sberTokenRepo.test.ts
```

Expected: PASS, 6/6.

- [ ] **Step 5: Commit**

```powershell
git add src/database/repositories/sberTokenRepo.ts tests/database/sberTokenRepo.test.ts tests/helpers/db.ts
git commit -m "feat(db): sberTokenRepo with upsert/updateTokens/updatePayerDetails/clear"
```

---

## Task 2c: `supplierRepo`

**Files:**
- Create: `src/database/repositories/supplierRepo.ts`
- Test: `tests/database/supplierRepo.test.ts`

- [ ] **Step 1: Failing test**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../helpers/db';
import { supplierRepo } from '../../src/database/repositories/supplierRepo';

describe('supplierRepo', () => {
  beforeEach(() => resetDb());

  const sample = {
    inn: '5012089824',
    name: 'ООО "Свит лайф фудсервис"',
    kpp: '501201001',
    account: '40702810000000000001',
    bank_bic: '044525225',
    bank_corr_account: '30101810400000000225',
    bank_name: 'ПАО Сбербанк',
    address: 'г. Москва',
    verified: 1,
    source: 'manual',
    notes: null,
  };

  it('create + findByInn roundtrip', () => {
    supplierRepo.create(sample);
    const found = supplierRepo.findByInn('5012089824');
    expect(found?.name).toBe(sample.name);
    expect(found?.verified).toBe(1);
  });

  it('findByInn returns null when not found', () => {
    expect(supplierRepo.findByInn('9999999999')).toBeNull();
  });

  it('upsert creates new', () => {
    supplierRepo.upsert(sample);
    expect(supplierRepo.findByInn('5012089824')?.name).toBe(sample.name);
  });

  it('upsert overwrites existing fields', () => {
    supplierRepo.create(sample);
    supplierRepo.upsert({ ...sample, name: 'Новое имя', verified: 1 });
    expect(supplierRepo.findByInn('5012089824')?.name).toBe('Новое имя');
  });

  it('list paginates and searches', () => {
    supplierRepo.create({ ...sample, inn: '1111111111', name: 'Альфа' });
    supplierRepo.create({ ...sample, inn: '2222222222', name: 'Бета' });
    supplierRepo.create({ ...sample, inn: '3333333333', name: 'Гамма' });
    expect(supplierRepo.list({ limit: 10, offset: 0 }).length).toBe(3);
    expect(supplierRepo.list({ q: 'Бет', limit: 10, offset: 0 }).length).toBe(1);
    expect(supplierRepo.list({ q: '3333', limit: 10, offset: 0 }).length).toBe(1);
    expect(supplierRepo.list({ verified: 1, limit: 10, offset: 0 }).length).toBe(3);
  });

  it('update marks updated_at', () => {
    supplierRepo.create(sample);
    const before = supplierRepo.findByInn('5012089824')!.updated_at;
    // sleep 5ms to ensure datetime diff
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    supplierRepo.update('5012089824', { name: 'X' });
    const after = supplierRepo.findByInn('5012089824')!.updated_at;
    expect(after >= before).toBe(true);
  });

  it('touchLastUsed updates last_used_at', () => {
    supplierRepo.create(sample);
    supplierRepo.touchLastUsed('5012089824');
    expect(supplierRepo.findByInn('5012089824')?.last_used_at).not.toBeNull();
  });

  it('delete removes row', () => {
    supplierRepo.create(sample);
    supplierRepo.delete('5012089824');
    expect(supplierRepo.findByInn('5012089824')).toBeNull();
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

```powershell
npx vitest run tests/database/supplierRepo.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `src/database/repositories/supplierRepo.ts`**

```typescript
import { getDb } from '../db';

export interface Supplier {
  inn: string;
  name: string;
  kpp: string | null;
  account: string | null;
  bank_bic: string;
  bank_corr_account: string | null;
  bank_name: string | null;
  address: string | null;
  verified: number;
  source: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

export interface CreateSupplierInput {
  inn: string;
  name: string;
  kpp?: string | null;
  account?: string | null;
  bank_bic: string;
  bank_corr_account?: string | null;
  bank_name?: string | null;
  address?: string | null;
  verified?: number;
  source?: string | null;
  notes?: string | null;
}

export interface ListOptions {
  q?: string;
  verified?: number;
  limit: number;
  offset: number;
}

export const supplierRepo = {
  findByInn(inn: string): Supplier | null {
    const row = getDb().prepare('SELECT * FROM suppliers WHERE inn = ?').get(inn) as Supplier | undefined;
    return row ?? null;
  },

  create(input: CreateSupplierInput): Supplier {
    getDb().prepare(`
      INSERT INTO suppliers (inn, name, kpp, account, bank_bic, bank_corr_account, bank_name, address, verified, source, notes)
      VALUES (@inn, @name, @kpp, @account, @bank_bic, @bank_corr_account, @bank_name, @address, @verified, @source, @notes)
    `).run({
      inn: input.inn,
      name: input.name,
      kpp: input.kpp ?? null,
      account: input.account ?? null,
      bank_bic: input.bank_bic,
      bank_corr_account: input.bank_corr_account ?? null,
      bank_name: input.bank_name ?? null,
      address: input.address ?? null,
      verified: input.verified ?? 0,
      source: input.source ?? null,
      notes: input.notes ?? null,
    });
    return this.findByInn(input.inn)!;
  },

  upsert(input: CreateSupplierInput): Supplier {
    const existing = this.findByInn(input.inn);
    if (existing) {
      this.update(input.inn, input);
    } else {
      this.create(input);
    }
    return this.findByInn(input.inn)!;
  },

  update(inn: string, patch: Partial<CreateSupplierInput>): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'inn' || v === undefined) continue;
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push(`updated_at = datetime('now')`);
    vals.push(inn);
    getDb().prepare(`UPDATE suppliers SET ${sets.join(', ')} WHERE inn = ?`).run(...vals);
  },

  touchLastUsed(inn: string): void {
    getDb().prepare(`UPDATE suppliers SET last_used_at = datetime('now') WHERE inn = ?`).run(inn);
  },

  delete(inn: string): void {
    getDb().prepare('DELETE FROM suppliers WHERE inn = ?').run(inn);
  },

  list(opts: ListOptions): Supplier[] {
    const wheres: string[] = [];
    const params: unknown[] = [];
    if (opts.q) {
      wheres.push('(name LIKE ? COLLATE NOCASE OR inn LIKE ?)');
      params.push(`%${opts.q}%`, `%${opts.q}%`);
    }
    if (opts.verified !== undefined) {
      wheres.push('verified = ?');
      params.push(opts.verified);
    }
    const sql = `
      SELECT * FROM suppliers
      ${wheres.length > 0 ? 'WHERE ' + wheres.join(' AND ') : ''}
      ORDER BY last_used_at DESC NULLS LAST, name COLLATE NOCASE
      LIMIT ? OFFSET ?
    `;
    params.push(opts.limit, opts.offset);
    return getDb().prepare(sql).all(...params) as Supplier[];
  },
};
```

- [ ] **Step 4: Run — verify PASS**

```powershell
npx vitest run tests/database/supplierRepo.test.ts
```

Expected: PASS, 8/8.

- [ ] **Step 5: Commit**

```powershell
git add src/database/repositories/supplierRepo.ts tests/database/supplierRepo.test.ts
git commit -m "feat(db): supplierRepo with create/upsert/list/update/touchLastUsed/delete"
```

---

## Task 2d: `sberPaymentRepo`

**Files:**
- Create: `src/database/repositories/sberPaymentRepo.ts`
- Test: `tests/database/sberPaymentRepo.test.ts`

- [ ] **Step 1: Failing test**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../helpers/db';
import { sberPaymentRepo } from '../../src/database/repositories/sberPaymentRepo';
import { getDb } from '../../src/database/db';

describe('sberPaymentRepo', () => {
  beforeEach(() => {
    resetDb();
    getDb().prepare(`INSERT INTO invoices (id, file_name, file_path, total_sum, status) VALUES (1, 'a.jpg', '/a.jpg', 100, 'processed')`).run();
  });

  it('create + findByInvoiceId roundtrip', () => {
    sberPaymentRepo.create({
      invoice_id: 1,
      external_id: 'uuid-1',
      status: 'pending',
      payment_purpose: 'Test',
      amount: 100,
      payer_account: '40702',
      payee_inn: '5012',
    });
    const row = sberPaymentRepo.findByInvoiceId(1)!;
    expect(row.external_id).toBe('uuid-1');
    expect(row.status).toBe('pending');
  });

  it('findByInvoiceId returns null when none', () => {
    expect(sberPaymentRepo.findByInvoiceId(999)).toBeNull();
  });

  it('UNIQUE invoice_id rejects duplicates', () => {
    sberPaymentRepo.create({ invoice_id: 1, external_id: 'a', status: 'pending', payment_purpose: 'p', amount: 1, payer_account: '1', payee_inn: '1' });
    expect(() => {
      sberPaymentRepo.create({ invoice_id: 1, external_id: 'b', status: 'pending', payment_purpose: 'p', amount: 1, payer_account: '1', payee_inn: '1' });
    }).toThrow(/UNIQUE/);
  });

  it('updateStatus flips fields', () => {
    sberPaymentRepo.create({ invoice_id: 1, external_id: 'a', status: 'pending', payment_purpose: 'p', amount: 1, payer_account: '1', payee_inn: '1' });
    sberPaymentRepo.updateStatus(1, {
      status: 'created',
      sber_payment_number: '123',
      response_body: '{"ok":true}',
    });
    const row = sberPaymentRepo.findByInvoiceId(1)!;
    expect(row.status).toBe('created');
    expect(row.sber_payment_number).toBe('123');
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

```powershell
npx vitest run tests/database/sberPaymentRepo.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `src/database/repositories/sberPaymentRepo.ts`**

```typescript
import { getDb } from '../db';

export interface SberPayment {
  id: number;
  invoice_id: number;
  external_id: string;
  status: string;
  payment_purpose: string;
  amount: number;
  payer_account: string;
  payee_inn: string;
  request_payload: string | null;
  response_body: string | null;
  sber_payment_number: string | null;
  error_message: string | null;
  created_at: string;
}

export interface CreateSberPaymentInput {
  invoice_id: number;
  external_id: string;
  status: string;
  payment_purpose: string;
  amount: number;
  payer_account: string;
  payee_inn: string;
  request_payload?: string | null;
}

export const sberPaymentRepo = {
  findByInvoiceId(invoiceId: number): SberPayment | null {
    const row = getDb().prepare('SELECT * FROM sber_payments WHERE invoice_id = ?').get(invoiceId) as SberPayment | undefined;
    return row ?? null;
  },

  create(input: CreateSberPaymentInput): SberPayment {
    getDb().prepare(`
      INSERT INTO sber_payments (invoice_id, external_id, status, payment_purpose, amount, payer_account, payee_inn, request_payload)
      VALUES (@invoice_id, @external_id, @status, @payment_purpose, @amount, @payer_account, @payee_inn, @request_payload)
    `).run({
      ...input,
      request_payload: input.request_payload ?? null,
    });
    return this.findByInvoiceId(input.invoice_id)!;
  },

  updateStatus(invoiceId: number, patch: { status: string; sber_payment_number?: string | null; response_body?: string | null; error_message?: string | null }): void {
    const sets: string[] = ['status = ?'];
    const vals: unknown[] = [patch.status];
    if (patch.sber_payment_number !== undefined) { sets.push('sber_payment_number = ?'); vals.push(patch.sber_payment_number); }
    if (patch.response_body !== undefined) { sets.push('response_body = ?'); vals.push(patch.response_body); }
    if (patch.error_message !== undefined) { sets.push('error_message = ?'); vals.push(patch.error_message); }
    vals.push(invoiceId);
    getDb().prepare(`UPDATE sber_payments SET ${sets.join(', ')} WHERE invoice_id = ?`).run(...vals);
  },

  listRecent(limit = 50): SberPayment[] {
    return getDb().prepare('SELECT * FROM sber_payments ORDER BY created_at DESC LIMIT ?').all(limit) as SberPayment[];
  },
};
```

- [ ] **Step 4: Run — verify PASS**

```powershell
npx vitest run tests/database/sberPaymentRepo.test.ts
```

Expected: PASS, 4/4.

- [ ] **Step 5: Commit**

```powershell
git add src/database/repositories/sberPaymentRepo.ts tests/database/sberPaymentRepo.test.ts
git commit -m "feat(db): sberPaymentRepo with create/findByInvoiceId/updateStatus/listRecent"
```

---

## Task 3a: `purposeTemplate`

**Files:**
- Create: `src/sber/purposeTemplate.ts`
- Test: `tests/sber/purposeTemplate.test.ts`

- [ ] **Step 1: Failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { renderPurpose, sanitizePurpose } from '../../src/sber/purposeTemplate';

describe('renderPurpose', () => {
  const ctx = {
    invoice_number: 'НФНФ-000085',
    invoice_date: '2026-05-06',
    total_sum: 66714.11,
    vat_sum: 11119.02,
    vat_rate: 20,
    supplier: 'ООО "Свит лайф"',
  };

  it('renders default template with VAT', () => {
    const out = renderPurpose(
      'Оплата по накладной № {invoice_number} от {invoice_date_dot}, {vat_clause}',
      ctx,
    );
    expect(out).toBe('Оплата по накладной № НФНФ-000085 от 06.05.2026, в т.ч. НДС 20% — 11119.02 руб.');
  });

  it('renders "Без НДС" when vat_sum is null', () => {
    const out = renderPurpose('{vat_clause}', { ...ctx, vat_sum: null });
    expect(out).toBe('Без НДС');
  });

  it('renders "Без НДС" when vat_sum is 0', () => {
    const out = renderPurpose('{vat_clause}', { ...ctx, vat_sum: 0 });
    expect(out).toBe('Без НДС');
  });

  it('substitutes all placeholders', () => {
    const out = renderPurpose(
      '{invoice_number}|{invoice_date_dot}|{invoice_date_iso}|{total}|{vat_amount}|{vat_rate}|{supplier}',
      ctx,
    );
    expect(out).toBe('НФНФ-000085|06.05.2026|2026-05-06|66714.11|11119.02|20|ООО "Свит лайф"');
  });

  it('truncates >210 chars with ellipsis', () => {
    const longTemplate = 'X'.repeat(220);
    const out = renderPurpose(longTemplate, ctx);
    expect(out.length).toBe(210);
    expect(out.endsWith('...')).toBe(true);
  });

  it('handles missing invoice_number gracefully', () => {
    const out = renderPurpose('№ {invoice_number}', { ...ctx, invoice_number: null });
    expect(out).toBe('№ б/н');
  });

  it('handles missing invoice_date', () => {
    const out = renderPurpose('от {invoice_date_dot}', { ...ctx, invoice_date: null });
    expect(out).toBe('от б/д');
  });
});

describe('sanitizePurpose', () => {
  it('replaces ёлочки and curly quotes with straight quotes', () => {
    expect(sanitizePurpose('ООО «Тест» "Hello"')).toBe('ООО "Тест" "Hello"');
  });

  it('replaces non-breaking space with regular space', () => {
    expect(sanitizePurpose('A B')).toBe('A B');
  });

  it('replaces em-dash and en-dash with hyphen', () => {
    expect(sanitizePurpose('A — B – C')).toBe('A - B - C');
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

```powershell
npx vitest run tests/sber/purposeTemplate.test.ts
```

- [ ] **Step 3: Implement `src/sber/purposeTemplate.ts`**

```typescript
export interface PurposeContext {
  invoice_number: string | null;
  invoice_date: string | null; // ISO YYYY-MM-DD
  total_sum: number | null;
  vat_sum: number | null;
  vat_rate: number | null;
  supplier: string | null;
}

const MAX_PURPOSE = 210;

function formatVatClause(ctx: PurposeContext): string {
  if (ctx.vat_sum === null || ctx.vat_sum <= 0) return 'Без НДС';
  const rate = ctx.vat_rate ?? 20;
  const amt = ctx.vat_sum.toFixed(2);
  return `в т.ч. НДС ${rate}% — ${amt} руб.`;
}

function formatDateDot(iso: string | null): string {
  if (!iso) return 'б/д';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

export function renderPurpose(template: string, ctx: PurposeContext): string {
  const subs: Record<string, string> = {
    invoice_number: ctx.invoice_number ?? 'б/н',
    invoice_date_dot: formatDateDot(ctx.invoice_date),
    invoice_date_iso: ctx.invoice_date ?? 'б/д',
    total: ctx.total_sum?.toFixed(2) ?? '0.00',
    vat_amount: ctx.vat_sum?.toFixed(2) ?? '0.00',
    vat_rate: ctx.vat_rate?.toString() ?? '0',
    supplier: ctx.supplier ?? '',
    vat_clause: formatVatClause(ctx),
  };
  let out = template.replace(/\{(\w+)\}/g, (_m, key) =>
    Object.prototype.hasOwnProperty.call(subs, key) ? subs[key] : `{${key}}`,
  );
  out = sanitizePurpose(out);
  if (out.length > MAX_PURPOSE) {
    out = out.slice(0, MAX_PURPOSE - 3) + '...';
  }
  return out;
}

export function sanitizePurpose(s: string): string {
  return s
    .replace(/[«»“”„]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/ /g, ' ')
    .replace(/[—–]/g, '-');
}
```

- [ ] **Step 4: Run — verify PASS**

```powershell
npx vitest run tests/sber/purposeTemplate.test.ts
```

Expected: PASS, 10/10.

- [ ] **Step 5: Commit**

```powershell
git add src/sber/purposeTemplate.ts tests/sber/purposeTemplate.test.ts
git commit -m "feat(sber): purpose template renderer with VAT clause and 210-char limit"
```

---

## Task 3b: `sberClient` — mTLS HTTPS обёртка

**Files:**
- Create: `src/sber/sberClient.ts`
- Test: `tests/sber/sberClient.test.ts`

- [ ] **Step 1: Failing test (использует моки `node:https`)**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('node:https', () => {
  const request = vi.fn();
  return { default: { request }, request };
});
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, default: { ...actual, readFileSync: vi.fn().mockReturnValue(Buffer.from('PFX-CONTENT')) } };
});

import https from 'node:https';
import { sberFetch } from '../../src/sber/sberClient';

function fakeResponse(status: number, body: string) {
  const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: object };
  res.statusCode = status;
  res.headers = {};
  process.nextTick(() => {
    res.emit('data', Buffer.from(body));
    res.emit('end');
  });
  return res;
}

describe('sberFetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SBER_TLS_PFX = './certs/test.p12';
    process.env.SBER_TLS_PFX_PASSWORD = 'pwd';
    process.env.SBER_CA_CERT = './certs/ca.pem';
  });

  it('passes pfx + passphrase to https.request', async () => {
    const req = new EventEmitter() as EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
    req.write = vi.fn(); req.end = vi.fn(); req.destroy = vi.fn();
    (https.request as unknown as ReturnType<typeof vi.fn>).mockImplementation((_opts: object, cb: (r: unknown) => void) => {
      cb(fakeResponse(201, '{"ok":true}'));
      return req;
    });

    const out = await sberFetch('https://fintech.sberbank.ru:9443/fintech/api/v1/payments', {
      method: 'POST',
      headers: { Authorization: 'token' },
      body: '{}',
    });

    expect(out.status).toBe(201);
    expect(out.body).toBe('{"ok":true}');
    const opts = (https.request as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(opts.pfx).toBeInstanceOf(Buffer);
    expect(opts.passphrase).toBe('pwd');
    expect(opts.hostname).toBe('fintech.sberbank.ru');
    expect(opts.port).toBe(9443);
    expect(opts.path).toBe('/fintech/api/v1/payments');
    expect(opts.method).toBe('POST');
  });

  it('writes body when provided', async () => {
    const req = new EventEmitter() as EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
    req.write = vi.fn(); req.end = vi.fn(); req.destroy = vi.fn();
    (https.request as unknown as ReturnType<typeof vi.fn>).mockImplementation((_opts: object, cb: (r: unknown) => void) => {
      cb(fakeResponse(200, ''));
      return req;
    });

    await sberFetch('https://fintech.sberbank.ru:9443/test', { method: 'POST', body: 'hello' });
    expect(req.write).toHaveBeenCalledWith('hello');
    expect(req.end).toHaveBeenCalled();
  });

  it('rejects on request error', async () => {
    const req = new EventEmitter() as EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
    req.write = vi.fn(); req.end = vi.fn(); req.destroy = vi.fn();
    (https.request as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      process.nextTick(() => req.emit('error', new Error('ECONNREFUSED')));
      return req;
    });

    await expect(sberFetch('https://x.test/y')).rejects.toThrow(/ECONNREFUSED/);
  });

  it('rejects on timeout', async () => {
    const req = new EventEmitter() as EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
    req.write = vi.fn(); req.end = vi.fn(); req.destroy = vi.fn();
    (https.request as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      process.nextTick(() => req.emit('timeout'));
      return req;
    });

    await expect(sberFetch('https://x.test/y')).rejects.toThrow(/timed out/i);
    expect(req.destroy).toHaveBeenCalled();
  });

  it('throws when SBER_TLS_PFX not set', async () => {
    delete process.env.SBER_TLS_PFX;
    await expect(sberFetch('https://x.test/y')).rejects.toThrow(/SBER_TLS_PFX/);
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

```powershell
npx vitest run tests/sber/sberClient.test.ts
```

- [ ] **Step 3: Implement `src/sber/sberClient.ts`**

```typescript
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

export interface SberFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface SberResponse {
  status: number;
  ok: boolean;
  body: string;
  json<T = unknown>(): T;
}

interface TlsBundle {
  pfx: Buffer;
  passphrase: string;
  ca?: Buffer;
}

let cachedTls: TlsBundle | null = null;

function loadTls(): TlsBundle {
  if (cachedTls) return cachedTls;
  const pfxPath = process.env.SBER_TLS_PFX;
  const passphrase = process.env.SBER_TLS_PFX_PASSWORD;
  if (!pfxPath || !passphrase) {
    throw new Error('SBER_TLS_PFX or SBER_TLS_PFX_PASSWORD not configured');
  }
  const resolved = path.resolve(process.cwd(), pfxPath);
  const pfx = fs.readFileSync(resolved);
  let ca: Buffer | undefined;
  const caPath = process.env.SBER_CA_CERT;
  if (caPath) {
    try {
      ca = fs.readFileSync(path.resolve(process.cwd(), caPath));
    } catch {
      // Sber CA file optional locally
    }
  }
  cachedTls = { pfx, passphrase, ca };
  return cachedTls;
}

// For tests
export function _resetTlsCache(): void {
  cachedTls = null;
}

export async function sberFetch(url: string, options: SberFetchOptions = {}): Promise<SberResponse> {
  const tls = loadTls();
  const parsed = new URL(url);
  return new Promise<SberResponse>((resolve, reject) => {
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : 9443,
        path: parsed.pathname + parsed.search,
        method: options.method || 'GET',
        headers: options.headers || {},
        pfx: tls.pfx,
        passphrase: tls.passphrase,
        ca: tls.ca,
        rejectUnauthorized: tls.ca ? true : false,
        timeout: options.timeoutMs ?? 30_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          const status = res.statusCode || 0;
          resolve({
            status,
            ok: status >= 200 && status < 300,
            body,
            json<T>() { return JSON.parse(body) as T; },
          });
        });
      },
    );
    req.on('error', (err) => reject(new Error(`Sber request failed: ${err.message}`)));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Sber request timed out (30s)'));
    });
    if (options.body) req.write(options.body);
    req.end();
  });
}
```

Note: `_resetTlsCache` экспортируется только для тестов. В тесте перед каждым кейсом надо его звать, чтобы изменения env подхватывались. Добавить в `beforeEach`:

```typescript
import { _resetTlsCache } from '../../src/sber/sberClient';
// ...
beforeEach(() => { _resetTlsCache(); /* остальное */ });
```

- [ ] **Step 4: Run — verify PASS**

```powershell
npx vitest run tests/sber/sberClient.test.ts
```

Expected: PASS, 5/5.

- [ ] **Step 5: Commit**

```powershell
git add src/sber/sberClient.ts tests/sber/sberClient.test.ts
git commit -m "feat(sber): sberFetch — mTLS HTTPS wrapper with PFX/passphrase"
```

---

## Task 3c: OAuth — state JWT + token exchange/refresh

**Files:**
- Create: `src/sber/oauth.ts`
- Test: `tests/sber/oauth.test.ts`

- [ ] **Step 1: Failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/sber/sberClient', () => ({
  sberFetch: vi.fn(),
}));

import { sberFetch } from '../../src/sber/sberClient';
import {
  createOAuthState,
  verifyOAuthState,
  buildAuthUrl,
  exchangeCodeForToken,
  refreshAccessToken,
} from '../../src/sber/oauth';

describe('OAuth state JWT', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret-must-be-at-least-32-chars-long';
  });

  it('createOAuthState + verifyOAuthState roundtrip', async () => {
    const state = await createOAuthState({ purpose: 'connect' });
    const payload = await verifyOAuthState(state);
    expect(payload).toMatchObject({ purpose: 'connect' });
  });

  it('verifyOAuthState returns null for invalid state', async () => {
    expect(await verifyOAuthState('not-a-jwt')).toBeNull();
  });

  it('verifyOAuthState rejects expired tokens', async () => {
    process.env.JWT_SECRET = 'test-secret-must-be-at-least-32-chars-long';
    const { SignJWT } = await import('jose');
    const secret = new TextEncoder().encode(process.env.JWT_SECRET);
    const expired = await new SignJWT({ purpose: 'connect' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(secret);
    expect(await verifyOAuthState(expired)).toBeNull();
  });
});

describe('buildAuthUrl', () => {
  beforeEach(() => {
    process.env.SBER_CLIENT_ID = '40285';
    process.env.SBER_REDIRECT_URI = 'https://scanflow.ru/api/sber/callback';
  });

  it('includes required params', () => {
    const url = buildAuthUrl('STATE-X');
    expect(url).toMatch(/^https:\/\/sbi\.sberbank\.ru:9443\/v2\/oauth\/authorize\?/);
    expect(url).toContain('client_id=40285');
    expect(url).toContain(`state=STATE-X`);
    expect(url).toContain('scope=openid+GET_CLIENT_ACCOUNTS+PAY_DOC_RU');
    expect(url).toContain('response_type=code');
    expect(url).toContain('redirect_uri=' + encodeURIComponent('https://scanflow.ru/api/sber/callback'));
  });
});

describe('exchangeCodeForToken', () => {
  beforeEach(() => {
    vi.mocked(sberFetch).mockReset();
    process.env.SBER_CLIENT_ID = '40285';
    process.env.SBER_CLIENT_SECRET = 'secret';
    process.env.SBER_REDIRECT_URI = 'https://scanflow.ru/api/sber/callback';
  });

  it('posts to token endpoint with form body', async () => {
    vi.mocked(sberFetch).mockResolvedValue({
      status: 200, ok: true,
      body: '{"access_token":"a","refresh_token":"r","expires_in":3600}',
      json<T>() { return JSON.parse(this.body) as T; },
    });
    const out = await exchangeCodeForToken('CODE');
    expect(out).toEqual({ accessToken: 'a', refreshToken: 'r', expiresIn: 3600 });
    expect(sberFetch).toHaveBeenCalledWith(
      'https://fintech.sberbank.ru:9443/v2/oauth/token',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: expect.stringContaining('grant_type=authorization_code'),
      }),
    );
  });

  it('throws on non-2xx', async () => {
    vi.mocked(sberFetch).mockResolvedValue({
      status: 400, ok: false, body: '{"error":"invalid_grant"}',
      json<T>() { return JSON.parse(this.body) as T; },
    });
    await expect(exchangeCodeForToken('BAD')).rejects.toThrow(/Sber token exchange/);
  });
});

describe('refreshAccessToken', () => {
  beforeEach(() => {
    vi.mocked(sberFetch).mockReset();
    process.env.SBER_CLIENT_ID = '40285';
    process.env.SBER_CLIENT_SECRET = 'secret';
  });

  it('posts grant_type=refresh_token', async () => {
    vi.mocked(sberFetch).mockResolvedValue({
      status: 200, ok: true,
      body: '{"access_token":"new","refresh_token":"newr","expires_in":7200}',
      json<T>() { return JSON.parse(this.body) as T; },
    });
    const out = await refreshAccessToken('OLD-REFRESH');
    expect(out.accessToken).toBe('new');
    const call = vi.mocked(sberFetch).mock.calls[0][1] as { body: string };
    expect(call.body).toContain('grant_type=refresh_token');
    expect(call.body).toContain('refresh_token=OLD-REFRESH');
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

```powershell
npx vitest run tests/sber/oauth.test.ts
```

- [ ] **Step 3: Implement `src/sber/oauth.ts`**

```typescript
import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';
import { sberFetch } from './sberClient';
import { sberTokenRepo } from '../database/repositories/sberTokenRepo';

const SBER_AUTH_URL = 'https://sbi.sberbank.ru:9443/v2/oauth/authorize';
const SBER_TOKEN_URL = 'https://fintech.sberbank.ru:9443/v2/oauth/token';
const SBER_SCOPE = 'openid GET_CLIENT_ACCOUNTS PAY_DOC_RU';

export interface TokenData {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

function getJwtSecret(): Uint8Array {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) {
    throw new Error('JWT_SECRET must be set and at least 32 characters');
  }
  return new TextEncoder().encode(s);
}

export async function createOAuthState(payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(getJwtSecret());
}

export async function verifyOAuthState(state: string): Promise<Record<string, unknown> | null> {
  try {
    const { payload } = await jwtVerify(state, getJwtSecret());
    return payload;
  } catch {
    return null;
  }
}

export function buildAuthUrl(state: string): string {
  const clientId = process.env.SBER_CLIENT_ID;
  const redirectUri = process.env.SBER_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    throw new Error('SBER_CLIENT_ID or SBER_REDIRECT_URI not configured');
  }
  const params = new URLSearchParams({
    scope: SBER_SCOPE,
    response_type: 'code',
    client_id: clientId,
    state,
    nonce: randomUUID(),
    redirect_uri: redirectUri,
  });
  return `${SBER_AUTH_URL}?${params.toString()}`;
}

export async function exchangeCodeForToken(code: string): Promise<TokenData> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: process.env.SBER_CLIENT_ID!,
    client_secret: process.env.SBER_CLIENT_SECRET!,
    redirect_uri: process.env.SBER_REDIRECT_URI!,
  });
  const res = await sberFetch(SBER_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`Sber token exchange failed: ${res.status} ${res.body}`);
  }
  const data = res.json<{ access_token: string; refresh_token: string; expires_in: number }>();
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: data.expires_in };
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenData> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: process.env.SBER_CLIENT_ID!,
    client_secret: process.env.SBER_CLIENT_SECRET!,
  });
  const res = await sberFetch(SBER_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`Sber token refresh failed: ${res.status} ${res.body}`);
  }
  const data = res.json<{ access_token: string; refresh_token: string; expires_in: number }>();
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: data.expires_in };
}

export async function getValidAccessToken(): Promise<string> {
  const row = sberTokenRepo.get();
  if (!row) throw new Error('Sber not connected');
  const buffer = 5 * 60 * 1000;
  const expiresAt = new Date(row.expires_at).getTime();
  if (expiresAt > Date.now() + buffer) return row.access_token;
  const fresh = await refreshAccessToken(row.refresh_token);
  const newExpiresAt = new Date(Date.now() + fresh.expiresIn * 1000).toISOString();
  sberTokenRepo.updateTokens({
    access_token: fresh.accessToken,
    refresh_token: fresh.refreshToken,
    expires_at: newExpiresAt,
  });
  return fresh.accessToken;
}
```

- [ ] **Step 4: Run — verify PASS**

```powershell
npx vitest run tests/sber/oauth.test.ts
```

Expected: PASS, 7/7.

- [ ] **Step 5: Commit**

```powershell
git add src/sber/oauth.ts tests/sber/oauth.test.ts
git commit -m "feat(sber): OAuth state JWT + code/refresh token exchange + getValidAccessToken"
```

---

## Task 3d: `clientInfo` — fetch org name + accounts из Sber

**Files:**
- Create: `src/sber/clientInfo.ts`
- Test: `tests/sber/clientInfo.test.ts`

- [ ] **Step 1: Failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/sber/sberClient', () => ({ sberFetch: vi.fn() }));

import { sberFetch } from '../../src/sber/sberClient';
import { fetchClientInfo } from '../../src/sber/clientInfo';

describe('fetchClientInfo', () => {
  it('parses org name and RUB account', async () => {
    vi.mocked(sberFetch).mockResolvedValue({
      status: 200, ok: true,
      body: JSON.stringify({
        orgName: 'ООО Тест',
        accounts: [
          { number: '40702810940000099835', currency: 'RUB' },
          { number: '40702840940000099836', currency: 'USD' },
        ],
      }),
      json<T>() { return JSON.parse(this.body) as T; },
    });
    const out = await fetchClientInfo('TOKEN');
    expect(out).toEqual({ orgName: 'ООО Тест', accountNumber: '40702810940000099835' });
  });

  it('falls back to first account when no RUB', async () => {
    vi.mocked(sberFetch).mockResolvedValue({
      status: 200, ok: true,
      body: JSON.stringify({ accounts: [{ number: '40702840940000099836', currency: 'USD' }] }),
      json<T>() { return JSON.parse(this.body) as T; },
    });
    const out = await fetchClientInfo('TOKEN');
    expect(out.accountNumber).toBe('40702840940000099836');
  });

  it('returns null fields gracefully on empty response', async () => {
    vi.mocked(sberFetch).mockResolvedValue({
      status: 200, ok: true, body: '{}', json<T>() { return JSON.parse(this.body) as T; },
    });
    const out = await fetchClientInfo('TOKEN');
    expect(out).toEqual({ orgName: null, accountNumber: null });
  });

  it('throws on non-2xx', async () => {
    vi.mocked(sberFetch).mockResolvedValue({
      status: 401, ok: false, body: 'unauth', json<T>() { return JSON.parse(this.body) as T; },
    });
    await expect(fetchClientInfo('TOKEN')).rejects.toThrow(/client-info/);
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

```powershell
npx vitest run tests/sber/clientInfo.test.ts
```

- [ ] **Step 3: Implement `src/sber/clientInfo.ts`**

```typescript
import { sberFetch } from './sberClient';

const CLIENT_INFO_URL = 'https://fintech.sberbank.ru:9443/fintech/api/v2/client-info';

export interface ClientInfo {
  orgName: string | null;
  accountNumber: string | null;
}

export async function fetchClientInfo(accessToken: string): Promise<ClientInfo> {
  const res = await sberFetch(CLIENT_INFO_URL, {
    headers: { Authorization: accessToken, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Sber client-info failed: ${res.status} ${res.body}`);
  }
  const data = res.json<{ orgName?: string; organizationName?: string; name?: string; accounts?: Array<{ number?: string; accountNumber?: string; currency?: string }> }>();
  const orgName = data.orgName ?? data.organizationName ?? data.name ?? null;
  const accounts = data.accounts ?? [];
  let accountNumber: string | null = null;
  if (accounts.length > 0) {
    const rub = accounts.find((a) => a.currency === 'RUB');
    accountNumber = (rub ?? accounts[0])?.number ?? (rub ?? accounts[0])?.accountNumber ?? null;
  }
  return { orgName, accountNumber };
}
```

- [ ] **Step 4: Run — verify PASS**

```powershell
npx vitest run tests/sber/clientInfo.test.ts
```

Expected: PASS, 4/4.

- [ ] **Step 5: Commit**

```powershell
git add src/sber/clientInfo.ts tests/sber/clientInfo.test.ts
git commit -m "feat(sber): fetchClientInfo — get org_name and account_number from Sber"
```

---

## Task 3e: `payments` — `createPaymentOrder`

**Files:**
- Create: `src/sber/payments.ts`
- Test: `tests/sber/payments.test.ts`

- [ ] **Step 1: Failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/sber/sberClient', () => ({ sberFetch: vi.fn() }));

import { sberFetch } from '../../src/sber/sberClient';
import { createPaymentOrder, type PaymentOrderPayload } from '../../src/sber/payments';

describe('createPaymentOrder', () => {
  const valid: PaymentOrderPayload = {
    date: '2026-05-06',
    externalId: '11111111-2222-3333-4444-555555555555',
    amount: 1234.56,
    purpose: 'Оплата по накладной',
    payerName: 'ООО БФС',
    payerInn: '7707083893',
    payerKpp: '770701001',
    payerAccount: '40702810940000099835',
    payerBankBic: '044525225',
    payerBankCorrAccount: '30101810400000000225',
    payeeName: 'ООО Свит лайф',
    payeeInn: '5012089824',
    payeeKpp: '501201001',
    payeeAccount: '40702810000000000001',
    payeeBankBic: '044525225',
    payeeBankCorrAccount: '30101810400000000225',
  };

  it('POSTs to /v1/payments with operationCode=01 and priority=5', async () => {
    vi.mocked(sberFetch).mockResolvedValue({
      status: 201, ok: true,
      body: JSON.stringify({ externalId: valid.externalId, number: '12345', status: 'ACCEPTED' }),
      json<T>() { return JSON.parse(this.body) as T; },
    });
    const out = await createPaymentOrder('TOKEN', valid);
    expect(out).toEqual({ externalId: valid.externalId, number: '12345', status: 'ACCEPTED' });
    const [url, opts] = vi.mocked(sberFetch).mock.calls[0];
    expect(url).toBe('https://fintech.sberbank.ru:9443/fintech/api/v1/payments');
    expect((opts as { method?: string }).method).toBe('POST');
    expect((opts as { headers?: Record<string,string> }).headers!.Authorization).toBe('TOKEN');
    expect((opts as { headers?: Record<string,string> }).headers!['Content-Type']).toBe('application/json');
    const body = JSON.parse((opts as { body: string }).body);
    expect(body.operationCode).toBe('01');
    expect(body.priority).toBe('5');
    expect(body.amount).toBe(1234.56);
    expect(body.payerAccount).toBe('40702810940000099835');
  });

  it('throws on 400 with sber error', async () => {
    vi.mocked(sberFetch).mockResolvedValue({
      status: 400, ok: false, body: '{"errors":[{"description":"Invalid BIC"}]}',
      json<T>() { return JSON.parse(this.body) as T; },
    });
    await expect(createPaymentOrder('T', valid)).rejects.toMatchObject({
      message: expect.stringContaining('400'),
      status: 400,
      body: expect.stringContaining('Invalid BIC'),
    });
  });

  it('validates payerAccount is 20 digits before sending', async () => {
    await expect(createPaymentOrder('T', { ...valid, payerAccount: '407' })).rejects.toThrow(/payerAccount/);
    expect(sberFetch).not.toHaveBeenCalled();
  });

  it('validates BIC is 9 digits', async () => {
    await expect(createPaymentOrder('T', { ...valid, payeeBankBic: '12' })).rejects.toThrow(/payeeBankBic/);
  });

  it('validates purpose ≤ 210 chars', async () => {
    await expect(createPaymentOrder('T', { ...valid, purpose: 'X'.repeat(211) })).rejects.toThrow(/purpose/);
  });

  it('omits empty optional fields', async () => {
    vi.mocked(sberFetch).mockResolvedValue({
      status: 201, ok: true, body: '{}', json<T>() { return JSON.parse(this.body) as T; },
    });
    const minimal: PaymentOrderPayload = { ...valid };
    delete (minimal as Partial<PaymentOrderPayload>).payeeKpp;
    delete (minimal as Partial<PaymentOrderPayload>).payeeAccount;
    delete (minimal as Partial<PaymentOrderPayload>).payeeBankCorrAccount;
    delete (minimal as Partial<PaymentOrderPayload>).payerKpp;
    await createPaymentOrder('TOKEN', minimal);
    const body = JSON.parse((vi.mocked(sberFetch).mock.calls[0][1] as { body: string }).body);
    expect(body.payeeKpp).toBeUndefined();
    expect(body.payeeAccount).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

```powershell
npx vitest run tests/sber/payments.test.ts
```

- [ ] **Step 3: Implement `src/sber/payments.ts`**

```typescript
import { sberFetch } from './sberClient';

const PAYMENTS_URL = 'https://fintech.sberbank.ru:9443/fintech/api/v1/payments';

export interface PaymentOrderPayload {
  date: string;                    // YYYY-MM-DD
  externalId: string;              // UUID
  amount: number;                  // > 0
  purpose: string;                 // ≤ 210 chars
  number?: string;
  payerName: string;
  payerInn: string;
  payerKpp?: string;
  payerAccount: string;            // 20 digits
  payerBankBic: string;            // 9 digits
  payerBankCorrAccount: string;    // 20 digits
  payeeName: string;
  payeeInn?: string;
  payeeKpp?: string;
  payeeAccount?: string;
  payeeBankBic: string;            // 9 digits
  payeeBankCorrAccount?: string;
}

export interface PaymentOrderResponse {
  externalId: string;
  number?: string;
  status?: string;
}

export class SberApiError extends Error {
  constructor(public status: number, public body: string, public requestId?: string) {
    super(`Sber API error ${status}: ${body}`);
    this.name = 'SberApiError';
  }
}

function validatePayload(p: PaymentOrderPayload): void {
  const checks: Array<[string, RegExp | ((v: unknown) => boolean), unknown]> = [
    ['date', /^\d{4}-\d{2}-\d{2}$/, p.date],
    ['externalId', /^.{1,36}$/, p.externalId],
    ['amount', (v) => typeof v === 'number' && v >= 0.01, p.amount],
    ['purpose', (v) => typeof v === 'string' && v.length > 0 && v.length <= 210, p.purpose],
    ['payerAccount', /^[0-9]{20}$/, p.payerAccount],
    ['payerBankBic', /^[0-9]{9}$/, p.payerBankBic],
    ['payerBankCorrAccount', /^[0-9]{20}$/, p.payerBankCorrAccount],
    ['payeeBankBic', /^[0-9]{9}$/, p.payeeBankBic],
  ];
  for (const [field, rule, val] of checks) {
    const ok = rule instanceof RegExp ? typeof val === 'string' && rule.test(val) : (rule as (v: unknown) => boolean)(val);
    if (!ok) throw new Error(`Invalid payment payload: field "${field}" failed validation (got ${JSON.stringify(val)})`);
  }
  if (p.payeeAccount !== undefined && !/^[0-9]{20}$/.test(p.payeeAccount)) {
    throw new Error('Invalid payment payload: field "payeeAccount" must be 20 digits');
  }
}

export async function createPaymentOrder(
  accessToken: string,
  payload: PaymentOrderPayload,
): Promise<PaymentOrderResponse> {
  validatePayload(payload);
  const body: Record<string, unknown> = {
    date: payload.date,
    externalId: payload.externalId,
    amount: payload.amount,
    operationCode: '01',
    priority: '5',
    purpose: payload.purpose,
    payerName: payload.payerName,
    payerInn: payload.payerInn,
    payerAccount: payload.payerAccount,
    payerBankBic: payload.payerBankBic,
    payerBankCorrAccount: payload.payerBankCorrAccount,
    payeeName: payload.payeeName,
    payeeBankBic: payload.payeeBankBic,
  };
  // Optional fields — only set if defined
  for (const opt of ['number', 'payerKpp', 'payeeInn', 'payeeKpp', 'payeeAccount', 'payeeBankCorrAccount'] as const) {
    if (payload[opt] !== undefined) body[opt] = payload[opt];
  }
  const res = await sberFetch(PAYMENTS_URL, {
    method: 'POST',
    headers: {
      Authorization: accessToken,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new SberApiError(res.status, res.body);
  }
  const data = res.json<{ externalId?: string; number?: string; status?: string }>();
  return {
    externalId: data.externalId ?? payload.externalId,
    number: data.number,
    status: data.status,
  };
}
```

- [ ] **Step 4: Run — verify PASS**

```powershell
npx vitest run tests/sber/payments.test.ts
```

Expected: PASS, 6/6.

- [ ] **Step 5: Commit**

```powershell
git add src/sber/payments.ts tests/sber/payments.test.ts
git commit -m "feat(sber): createPaymentOrder with payload validation and SberApiError"
```

---

## Task 3f: `dadata` lookup

**Files:**
- Create: `src/sber/dadata.ts`
- Test: `tests/sber/dadata.test.ts`

- [ ] **Step 1: Failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { lookupPartyByInn, DadataNotConfiguredError } from '../../src/sber/dadata';

describe('lookupPartyByInn', () => {
  beforeEach(() => {
    process.env.DADATA_API_KEY = 'test-key';
    global.fetch = vi.fn();
  });

  it('throws DadataNotConfiguredError when key absent', async () => {
    delete process.env.DADATA_API_KEY;
    await expect(lookupPartyByInn('5012089824')).rejects.toBeInstanceOf(DadataNotConfiguredError);
  });

  it('returns null when no suggestions', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ suggestions: [] }),
    });
    expect(await lookupPartyByInn('9999999999')).toBeNull();
  });

  it('parses first suggestion', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        suggestions: [{
          value: 'ООО "Свит лайф"',
          data: {
            inn: '5012089824',
            kpp: '501201001',
            name: { full: 'ООО "Свит лайф"' },
            address: { value: 'Москва' },
          },
        }],
      }),
    });
    const out = await lookupPartyByInn('5012089824');
    expect(out).toEqual({
      name: 'ООО "Свит лайф"',
      inn: '5012089824',
      kpp: '501201001',
      address: 'Москва',
    });
  });

  it('throws on non-200', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 401, text: async () => 'unauth' });
    await expect(lookupPartyByInn('5012089824')).rejects.toThrow(/DaData/);
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

```powershell
npx vitest run tests/sber/dadata.test.ts
```

- [ ] **Step 3: Implement `src/sber/dadata.ts`**

```typescript
const DADATA_URL = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party';

export class DadataNotConfiguredError extends Error {
  constructor() {
    super('DADATA_API_KEY not configured');
    this.name = 'DadataNotConfiguredError';
  }
}

export interface DadataParty {
  name: string | null;
  inn: string;
  kpp: string | null;
  address: string | null;
}

interface DadataResponse {
  suggestions?: Array<{
    value?: string;
    data?: {
      inn?: string;
      kpp?: string;
      name?: { full?: string; short?: string };
      address?: { value?: string };
    };
  }>;
}

export async function lookupPartyByInn(inn: string): Promise<DadataParty | null> {
  const apiKey = process.env.DADATA_API_KEY;
  if (!apiKey) throw new DadataNotConfiguredError();
  const res = await fetch(DADATA_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Token ${apiKey}`,
      Accept: 'application/json',
    },
    body: JSON.stringify({ query: inn }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DaData lookup failed: ${res.status} ${text}`);
  }
  const data = await res.json() as DadataResponse;
  const first = data.suggestions?.[0];
  if (!first) return null;
  return {
    name: first.data?.name?.full ?? first.value ?? null,
    inn: first.data?.inn ?? inn,
    kpp: first.data?.kpp ?? null,
    address: first.data?.address?.value ?? null,
  };
}
```

- [ ] **Step 4: Run — verify PASS**

```powershell
npx vitest run tests/sber/dadata.test.ts
```

Expected: PASS, 4/4.

- [ ] **Step 5: Commit**

```powershell
git add src/sber/dadata.ts tests/sber/dadata.test.ts
git commit -m "feat(sber): DaData lookup by INN with DadataNotConfiguredError"
```

---

## Task 4a: `userRepo` — purpose template helpers

**Files:**
- Modify: `src/database/repositories/userRepo.ts`
- Test: `tests/database/userRepo.purposeTemplate.test.ts`

- [ ] **Step 1: Failing test**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../helpers/db';
import { userRepo } from '../../src/database/repositories/userRepo';
import { getDb } from '../../src/database/db';

describe('userRepo — sber_purpose_template', () => {
  beforeEach(() => {
    resetDb();
    getDb().prepare(`INSERT INTO users (username, password_hash, api_key) VALUES ('admin','h','k')`).run();
  });

  it('default template is set on user creation', () => {
    const tpl = userRepo.getPurposeTemplate(1);
    expect(tpl).toContain('{invoice_number}');
    expect(tpl).toContain('{vat_clause}');
  });

  it('setPurposeTemplate persists', () => {
    userRepo.setPurposeTemplate(1, 'CUSTOM {invoice_number}');
    expect(userRepo.getPurposeTemplate(1)).toBe('CUSTOM {invoice_number}');
  });

  it('getPurposeTemplate returns null for unknown id', () => {
    expect(userRepo.getPurposeTemplate(999)).toBeNull();
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

```powershell
npx vitest run tests/database/userRepo.purposeTemplate.test.ts
```

- [ ] **Step 3: Add methods to `src/database/repositories/userRepo.ts`**

В `User` interface добавить (после `telegram_bot_token`):

```typescript
sber_purpose_template: string;
```

В `userRepo` объект добавить методы (после `setTelegramConfig`):

```typescript
getPurposeTemplate(id: number): string | null {
  const row = getDb()
    .prepare('SELECT sber_purpose_template FROM users WHERE id = ?')
    .get(id) as { sber_purpose_template: string } | undefined;
  return row?.sber_purpose_template ?? null;
},

setPurposeTemplate(id: number, template: string): void {
  getDb()
    .prepare('UPDATE users SET sber_purpose_template = ? WHERE id = ?')
    .run(template, id);
},
```

- [ ] **Step 4: Run — verify PASS**

```powershell
npx vitest run tests/database/userRepo.purposeTemplate.test.ts
```

Expected: PASS, 3/3.

- [ ] **Step 5: Commit**

```powershell
git add src/database/repositories/userRepo.ts tests/database/userRepo.purposeTemplate.test.ts
git commit -m "feat(db): userRepo.getPurposeTemplate/setPurposeTemplate"
```

---

## Task 4b: `invoiceRepo` — supplier_kpp поле

**Files:**
- Modify: `src/database/repositories/invoiceRepo.ts`
- Test: `tests/database/invoiceRepo.supplier-kpp.test.ts`

- [ ] **Step 1: Failing test**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../helpers/db';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';

describe('invoiceRepo — supplier_kpp', () => {
  beforeEach(() => resetDb());

  it('persists and reads supplier_kpp', () => {
    const inv = invoiceRepo.create({
      file_name: 'a.jpg',
      file_path: '/a.jpg',
      supplier: 'Test',
      supplier_inn: '7707083893',
      supplier_kpp: '770701001',
    });
    expect(inv.supplier_kpp).toBe('770701001');
    const reloaded = invoiceRepo.getById(inv.id)!;
    expect(reloaded.supplier_kpp).toBe('770701001');
  });

  it('null when not provided', () => {
    const inv = invoiceRepo.create({ file_name: 'a.jpg', file_path: '/a.jpg' });
    expect(inv.supplier_kpp).toBeNull();
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

```powershell
npx vitest run tests/database/invoiceRepo.supplier-kpp.test.ts
```

- [ ] **Step 3: Modify `src/database/repositories/invoiceRepo.ts`**

В `Invoice` interface добавить (после `supplier_address`):

```typescript
supplier_kpp: string | null;
```

В `CreateInvoiceData` добавить:

```typescript
supplier_kpp?: string;
```

В `create` метод обновить INSERT statement и параметры — заменить:

```sql
INSERT INTO invoices (file_name, file_path, invoice_number, invoice_date, supplier, invoice_type, supplier_inn, supplier_bik, supplier_account, supplier_corr_account, supplier_address, total_sum, vat_sum, raw_text, ocr_engine, file_hash)
VALUES (@file_name, @file_path, @invoice_number, @invoice_date, @supplier, @invoice_type, @supplier_inn, @supplier_bik, @supplier_account, @supplier_corr_account, @supplier_address, @total_sum, @vat_sum, @raw_text, @ocr_engine, @file_hash)
```

на:

```sql
INSERT INTO invoices (file_name, file_path, invoice_number, invoice_date, supplier, invoice_type, supplier_inn, supplier_kpp, supplier_bik, supplier_account, supplier_corr_account, supplier_address, total_sum, vat_sum, raw_text, ocr_engine, file_hash)
VALUES (@file_name, @file_path, @invoice_number, @invoice_date, @supplier, @invoice_type, @supplier_inn, @supplier_kpp, @supplier_bik, @supplier_account, @supplier_corr_account, @supplier_address, @total_sum, @vat_sum, @raw_text, @ocr_engine, @file_hash)
```

И добавить в `stmt.run({...})` параметр:

```typescript
supplier_kpp: data.supplier_kpp ?? null,
```

- [ ] **Step 4: Run — verify PASS**

```powershell
npx vitest run tests/database/invoiceRepo.supplier-kpp.test.ts
```

- [ ] **Step 5: Run full repo tests — ничего не сломалось**

```powershell
npx vitest run tests/database
```

Expected: все тесты репозиториев passing.

- [ ] **Step 6: Commit**

```powershell
git add src/database/repositories/invoiceRepo.ts tests/database/invoiceRepo.supplier-kpp.test.ts
git commit -m "feat(db): invoiceRepo persists supplier_kpp"
```

---

## Task 5a: API роуты `/api/sber/*`

**Files:**
- Create: `src/api/routes/sber.ts`
- Test: `tests/api/sber.test.ts`

- [ ] **Step 1: Failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { resetDb } from '../helpers/db';
import { sberTokenRepo } from '../../src/database/repositories/sberTokenRepo';

vi.mock('../../src/sber/oauth', async () => {
  const actual = await vi.importActual<typeof import('../../src/sber/oauth')>('../../src/sber/oauth');
  return {
    ...actual,
    exchangeCodeForToken: vi.fn(),
    buildAuthUrl: vi.fn(() => 'https://sbi.sberbank.ru:9443/oauth?state=X'),
    createOAuthState: vi.fn().mockResolvedValue('STATE-JWT'),
    verifyOAuthState: vi.fn().mockResolvedValue({ purpose: 'connect' }),
  };
});
vi.mock('../../src/sber/clientInfo', () => ({
  fetchClientInfo: vi.fn().mockResolvedValue({ orgName: 'ООО Тест', accountNumber: '40702810940000099835' }),
}));

import sberRouter from '../../src/api/routes/sber';
import { exchangeCodeForToken } from '../../src/sber/oauth';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sber', sberRouter);
  return app;
}

describe('sber routes', () => {
  beforeEach(() => {
    resetDb();
    vi.mocked(exchangeCodeForToken).mockReset();
  });

  describe('GET /api/sber/authorize', () => {
    it('redirects to Sber OAuth url', async () => {
      const res = await request(makeApp()).get('/api/sber/authorize');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('sbi.sberbank.ru');
    });
  });

  describe('GET /api/sber/callback', () => {
    it('exchanges code, saves token, redirects with success', async () => {
      vi.mocked(exchangeCodeForToken).mockResolvedValue({ accessToken: 'a', refreshToken: 'r', expiresIn: 3600 });
      const res = await request(makeApp()).get('/api/sber/callback?code=CODE&state=STATE-JWT');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('sber=connected');
      expect(sberTokenRepo.get()?.access_token).toBe('a');
    });

    it('redirects with error on missing params', async () => {
      const res = await request(makeApp()).get('/api/sber/callback');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('sber=error');
    });
  });

  describe('POST /api/sber/seed-token', () => {
    it('saves token and reqs', async () => {
      const res = await request(makeApp())
        .post('/api/sber/seed-token')
        .send({
          access_token: 'a', refresh_token: 'r',
          account_number: '40702810940000099835',
          org_name: 'ООО Т',
          payer_inn: '7707083893',
          payer_kpp: '770701001',
          payer_bank_bic: '044525225',
          payer_bank_corr_account: '30101810400000000225',
        });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(sberTokenRepo.get()?.org_name).toBe('ООО Т');
    });

    it('rejects 20-digit account validation failure', async () => {
      const res = await request(makeApp())
        .post('/api/sber/seed-token')
        .send({ access_token: 'a', refresh_token: 'r', account_number: '407' });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/sber/status', () => {
    it('returns connected=false when no token', async () => {
      const res = await request(makeApp()).get('/api/sber/status');
      expect(res.body.connected).toBe(false);
    });

    it('returns connected=true with details', async () => {
      sberTokenRepo.upsert({
        access_token: 'a', refresh_token: 'r',
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
        account_number: '40702810940000099835',
        org_name: 'ООО Т',
        payer_inn: '7707083893',
        payer_kpp: '770701001',
        payer_bank_bic: '044525225',
        payer_bank_corr_account: '30101810400000000225',
      });
      const res = await request(makeApp()).get('/api/sber/status');
      expect(res.body).toMatchObject({
        connected: true,
        account_number: '40702810940000099835',
        org_name: 'ООО Т',
        token_expired: false,
        payer_complete: true,
      });
    });

    it('payer_complete=false when fields missing', async () => {
      sberTokenRepo.upsert({
        access_token: 'a', refresh_token: 'r',
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      });
      const res = await request(makeApp()).get('/api/sber/status');
      expect(res.body.payer_complete).toBe(false);
    });
  });

  describe('POST /api/sber/disconnect', () => {
    it('removes token', async () => {
      sberTokenRepo.upsert({ access_token: 'a', refresh_token: 'r', expires_at: '2099-01-01T00:00:00.000Z' });
      const res = await request(makeApp()).post('/api/sber/disconnect');
      expect(res.status).toBe(200);
      expect(sberTokenRepo.get()).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

```powershell
npx vitest run tests/api/sber.test.ts
```

- [ ] **Step 3: Implement `src/api/routes/sber.ts`**

```typescript
import { Router, Request, Response } from 'express';
import { logger } from '../../utils/logger';
import { sberTokenRepo } from '../../database/repositories/sberTokenRepo';
import {
  buildAuthUrl, createOAuthState, verifyOAuthState,
  exchangeCodeForToken,
} from '../../sber/oauth';
import { fetchClientInfo } from '../../sber/clientInfo';

const router = Router();

const ACC_RE = /^[0-9]{20}$/;
const BIC_RE = /^[0-9]{9}$/;
const INN_RE = /^[0-9]{10}|[0-9]{12}$/;

router.get('/authorize', async (_req: Request, res: Response) => {
  try {
    const state = await createOAuthState({ purpose: 'connect' });
    const url = buildAuthUrl(state);
    return res.redirect(url);
  } catch (err) {
    logger.error('[sber] authorize failed', { err: (err as Error).message });
    return res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  const error = req.query.error as string | undefined;

  const fail = (reason: string) => {
    const url = new URL('/#/sber', `${req.protocol}://${req.get('host')}`);
    url.searchParams.set('sber', 'error');
    url.searchParams.set('sber_error', reason);
    return res.redirect(url.pathname + url.search + url.hash);
  };

  if (error) return fail(error);
  if (!code || !state) return fail('missing_params');

  const stateData = await verifyOAuthState(state);
  if (!stateData) return fail('invalid_state');

  try {
    const token = await exchangeCodeForToken(code);
    const expiresAt = new Date(Date.now() + token.expiresIn * 1000).toISOString();
    sberTokenRepo.upsert({
      access_token: token.accessToken,
      refresh_token: token.refreshToken,
      expires_at: expiresAt,
    });
    // Опционально подтянуть client-info
    try {
      const info = await fetchClientInfo(token.accessToken);
      sberTokenRepo.updatePayerDetails({
        org_name: info.orgName,
        account_number: info.accountNumber,
      });
    } catch (infoErr) {
      logger.warn('[sber] client-info fetch failed (non-fatal)', { err: (infoErr as Error).message });
    }
    return res.redirect('/#/sber?sber=connected');
  } catch (err) {
    logger.error('[sber] callback failed', { err: (err as Error).message });
    return fail((err as Error).message);
  }
});

router.post('/seed-token', (req: Request, res: Response) => {
  const {
    access_token, refresh_token, expires_at, account_number, org_name,
    payer_inn, payer_kpp, payer_bank_bic, payer_bank_corr_account,
  } = req.body as Record<string, string | undefined>;
  if (!access_token || !refresh_token) {
    return res.status(400).json({ error: 'access_token and refresh_token are required' });
  }
  if (account_number && !ACC_RE.test(account_number)) {
    return res.status(400).json({ error: 'account_number must be 20 digits' });
  }
  if (payer_bank_bic && !BIC_RE.test(payer_bank_bic)) {
    return res.status(400).json({ error: 'payer_bank_bic must be 9 digits' });
  }
  if (payer_bank_corr_account && !ACC_RE.test(payer_bank_corr_account)) {
    return res.status(400).json({ error: 'payer_bank_corr_account must be 20 digits' });
  }
  if (payer_inn && !INN_RE.test(payer_inn)) {
    return res.status(400).json({ error: 'payer_inn must be 10 or 12 digits' });
  }
  const expiresAt = expires_at
    ? new Date(expires_at).toISOString()
    : new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  sberTokenRepo.upsert({
    access_token, refresh_token, expires_at: expiresAt,
    account_number: account_number ?? null,
    org_name: org_name ?? null,
    payer_inn: payer_inn ?? null,
    payer_kpp: payer_kpp ?? null,
    payer_bank_bic: payer_bank_bic ?? null,
    payer_bank_corr_account: payer_bank_corr_account ?? null,
  });
  return res.json({ success: true });
});

router.patch('/payer', (req: Request, res: Response) => {
  const t = sberTokenRepo.get();
  if (!t) return res.status(404).json({ error: 'Sber not connected' });
  const { payer_inn, payer_kpp, payer_bank_bic, payer_bank_corr_account, account_number, org_name } = req.body as Record<string, string | undefined>;
  if (payer_bank_bic && !BIC_RE.test(payer_bank_bic)) {
    return res.status(400).json({ error: 'payer_bank_bic must be 9 digits' });
  }
  if (payer_bank_corr_account && !ACC_RE.test(payer_bank_corr_account)) {
    return res.status(400).json({ error: 'payer_bank_corr_account must be 20 digits' });
  }
  if (account_number && !ACC_RE.test(account_number)) {
    return res.status(400).json({ error: 'account_number must be 20 digits' });
  }
  sberTokenRepo.updatePayerDetails({
    payer_inn, payer_kpp, payer_bank_bic, payer_bank_corr_account,
    account_number, org_name,
  });
  return res.json({ success: true });
});

router.get('/status', (_req: Request, res: Response) => {
  const t = sberTokenRepo.get();
  if (!t) return res.json({ connected: false });
  const tokenExpired = new Date(t.expires_at).getTime() < Date.now();
  const payerComplete = !!(t.account_number && t.payer_inn && t.payer_bank_bic && t.payer_bank_corr_account);
  return res.json({
    connected: true,
    account_number: t.account_number,
    org_name: t.org_name,
    payer_inn: t.payer_inn,
    payer_kpp: t.payer_kpp,
    payer_bank_bic: t.payer_bank_bic,
    payer_bank_corr_account: t.payer_bank_corr_account,
    token_expired: tokenExpired,
    payer_complete: payerComplete,
  });
});

router.post('/disconnect', (_req: Request, res: Response) => {
  sberTokenRepo.clear();
  return res.json({ success: true });
});

export default router;
```

- [ ] **Step 4: Run — verify PASS**

```powershell
npx vitest run tests/api/sber.test.ts
```

Expected: PASS, 8/8.

- [ ] **Step 5: Commit**

```powershell
git add src/api/routes/sber.ts tests/api/sber.test.ts
git commit -m "feat(api): /api/sber/* routes (authorize/callback/seed-token/payer/status/disconnect)"
```

---

## Task 5b: API роуты `/api/suppliers/*`

**Files:**
- Create: `src/api/routes/suppliers.ts`
- Test: `tests/api/suppliers.test.ts`

- [ ] **Step 1: Failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { resetDb } from '../helpers/db';
import { supplierRepo } from '../../src/database/repositories/supplierRepo';

vi.mock('../../src/sber/dadata', () => ({
  lookupPartyByInn: vi.fn(),
  DadataNotConfiguredError: class extends Error {
    constructor() { super('DADATA_API_KEY not configured'); }
  },
}));

import suppliersRouter from '../../src/api/routes/suppliers';
import { lookupPartyByInn, DadataNotConfiguredError } from '../../src/sber/dadata';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/suppliers', suppliersRouter);
  return app;
}

describe('suppliers routes', () => {
  beforeEach(() => {
    resetDb();
    vi.mocked(lookupPartyByInn).mockReset();
  });

  it('POST creates supplier', async () => {
    const res = await request(makeApp())
      .post('/api/suppliers')
      .send({
        inn: '5012089824', name: 'ООО Тест', kpp: '501201001',
        bank_bic: '044525225', account: '40702810000000000001',
        bank_corr_account: '30101810400000000225',
      });
    expect(res.status).toBe(201);
    expect(supplierRepo.findByInn('5012089824')?.verified).toBe(1);
  });

  it('POST rejects invalid INN', async () => {
    const res = await request(makeApp()).post('/api/suppliers').send({ inn: '123', name: 'X', bank_bic: '044525225' });
    expect(res.status).toBe(400);
  });

  it('GET lists suppliers', async () => {
    supplierRepo.create({ inn: '5012089824', name: 'A', bank_bic: '044525225' });
    supplierRepo.create({ inn: '7707083893', name: 'B', bank_bic: '044525225' });
    const res = await request(makeApp()).get('/api/suppliers');
    expect(res.body.suppliers.length).toBe(2);
  });

  it('GET /:inn returns one', async () => {
    supplierRepo.create({ inn: '5012089824', name: 'A', bank_bic: '044525225' });
    const res = await request(makeApp()).get('/api/suppliers/5012089824');
    expect(res.body.supplier.name).toBe('A');
  });

  it('GET /:inn 404 when missing', async () => {
    const res = await request(makeApp()).get('/api/suppliers/9999999999');
    expect(res.status).toBe(404);
  });

  it('PATCH updates fields', async () => {
    supplierRepo.create({ inn: '5012089824', name: 'A', bank_bic: '044525225' });
    const res = await request(makeApp()).patch('/api/suppliers/5012089824').send({ name: 'B' });
    expect(res.status).toBe(200);
    expect(supplierRepo.findByInn('5012089824')?.name).toBe('B');
  });

  it('DELETE removes', async () => {
    supplierRepo.create({ inn: '5012089824', name: 'A', bank_bic: '044525225' });
    const res = await request(makeApp()).delete('/api/suppliers/5012089824');
    expect(res.status).toBe(200);
    expect(supplierRepo.findByInn('5012089824')).toBeNull();
  });

  it('POST /lookup-dadata happy path', async () => {
    vi.mocked(lookupPartyByInn).mockResolvedValue({
      name: 'ООО X', inn: '5012089824', kpp: '501201001', address: 'Москва',
    });
    const res = await request(makeApp()).post('/api/suppliers/lookup-dadata').send({ inn: '5012089824' });
    expect(res.body.party.name).toBe('ООО X');
  });

  it('POST /lookup-dadata 503 when not configured', async () => {
    vi.mocked(lookupPartyByInn).mockRejectedValue(new DadataNotConfiguredError());
    const res = await request(makeApp()).post('/api/suppliers/lookup-dadata').send({ inn: '5012089824' });
    expect(res.status).toBe(503);
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

```powershell
npx vitest run tests/api/suppliers.test.ts
```

- [ ] **Step 3: Implement `src/api/routes/suppliers.ts`**

```typescript
import { Router, Request, Response } from 'express';
import { supplierRepo } from '../../database/repositories/supplierRepo';
import { lookupPartyByInn, DadataNotConfiguredError } from '../../sber/dadata';

const router = Router();

const INN_RE = /^([0-9]{10}|[0-9]{12})$/;
const BIC_RE = /^[0-9]{9}$/;
const ACC_RE = /^[0-9]{20}$/;

interface SupplierBody {
  inn?: string; name?: string; kpp?: string; account?: string;
  bank_bic?: string; bank_corr_account?: string; bank_name?: string;
  address?: string; verified?: number; source?: string; notes?: string;
}

function validateSupplier(body: SupplierBody): string | null {
  if (!body.inn || !INN_RE.test(body.inn)) return 'inn must be 10 or 12 digits';
  if (!body.name || body.name.length === 0) return 'name is required';
  if (!body.bank_bic || !BIC_RE.test(body.bank_bic)) return 'bank_bic must be 9 digits';
  if (body.account && !ACC_RE.test(body.account)) return 'account must be 20 digits';
  if (body.bank_corr_account && !ACC_RE.test(body.bank_corr_account)) return 'bank_corr_account must be 20 digits';
  return null;
}

router.get('/', (req: Request, res: Response) => {
  const q = (req.query.q as string | undefined) || undefined;
  const verified = req.query.verified !== undefined ? Number(req.query.verified) : undefined;
  const limit = Math.min(parseInt((req.query.limit as string) || '100', 10), 500);
  const offset = parseInt((req.query.offset as string) || '0', 10);
  const suppliers = supplierRepo.list({ q, verified, limit, offset });
  return res.json({ suppliers });
});

router.get('/:inn', (req: Request, res: Response) => {
  const supplier = supplierRepo.findByInn(req.params.inn);
  if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
  return res.json({ supplier });
});

router.post('/', (req: Request, res: Response) => {
  const err = validateSupplier(req.body as SupplierBody);
  if (err) return res.status(400).json({ error: err });
  const body = req.body as Required<Pick<SupplierBody, 'inn' | 'name' | 'bank_bic'>> & SupplierBody;
  if (supplierRepo.findByInn(body.inn)) {
    return res.status(409).json({ error: 'Supplier with this INN already exists' });
  }
  const supplier = supplierRepo.create({
    inn: body.inn, name: body.name, bank_bic: body.bank_bic,
    kpp: body.kpp ?? null, account: body.account ?? null,
    bank_corr_account: body.bank_corr_account ?? null,
    bank_name: body.bank_name ?? null, address: body.address ?? null,
    verified: 1, // ручное создание = подтверждено
    source: body.source ?? 'manual',
    notes: body.notes ?? null,
  });
  return res.status(201).json({ supplier });
});

router.patch('/:inn', (req: Request, res: Response) => {
  const existing = supplierRepo.findByInn(req.params.inn);
  if (!existing) return res.status(404).json({ error: 'Supplier not found' });
  const body = req.body as SupplierBody;
  if (body.bank_bic && !BIC_RE.test(body.bank_bic)) return res.status(400).json({ error: 'bank_bic must be 9 digits' });
  if (body.account && !ACC_RE.test(body.account)) return res.status(400).json({ error: 'account must be 20 digits' });
  supplierRepo.update(req.params.inn, body);
  return res.json({ supplier: supplierRepo.findByInn(req.params.inn) });
});

router.delete('/:inn', (req: Request, res: Response) => {
  supplierRepo.delete(req.params.inn);
  return res.json({ success: true });
});

router.post('/lookup-dadata', async (req: Request, res: Response) => {
  const inn = (req.body as { inn?: string }).inn;
  if (!inn || !INN_RE.test(inn)) return res.status(400).json({ error: 'inn must be 10 or 12 digits' });
  try {
    const party = await lookupPartyByInn(inn);
    if (!party) return res.json({ party: null });
    return res.json({ party });
  } catch (err) {
    if (err instanceof DadataNotConfiguredError) {
      return res.status(503).json({ error: 'DaData not configured' });
    }
    return res.status(502).json({ error: (err as Error).message });
  }
});

export default router;
```

- [ ] **Step 4: Run — verify PASS**

```powershell
npx vitest run tests/api/suppliers.test.ts
```

Expected: PASS, 9/9.

- [ ] **Step 5: Commit**

```powershell
git add src/api/routes/suppliers.ts tests/api/suppliers.test.ts
git commit -m "feat(api): /api/suppliers/* CRUD + DaData lookup"
```

---

## Task 5c: `POST /api/invoices/:id/send-sber`

**Files:**
- Modify: `src/api/routes/invoices.ts`
- Test: `tests/api/invoices.send-sber.test.ts`

- [ ] **Step 1: Failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { resetDb } from '../helpers/db';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';
import { supplierRepo } from '../../src/database/repositories/supplierRepo';
import { sberTokenRepo } from '../../src/database/repositories/sberTokenRepo';
import { sberPaymentRepo } from '../../src/database/repositories/sberPaymentRepo';

vi.mock('../../src/sber/oauth', () => ({
  getValidAccessToken: vi.fn().mockResolvedValue('TOKEN'),
}));
vi.mock('../../src/sber/payments', async () => {
  const actual = await vi.importActual<typeof import('../../src/sber/payments')>('../../src/sber/payments');
  return { ...actual, createPaymentOrder: vi.fn() };
});

import invoicesRouter from '../../src/api/routes/invoices';
import { createPaymentOrder, SberApiError } from '../../src/sber/payments';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/invoices', invoicesRouter);
  return app;
}

function seedConnectedSber() {
  sberTokenRepo.upsert({
    access_token: 'a', refresh_token: 'r',
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    account_number: '40702810940000099835',
    org_name: 'ООО БФС',
    payer_inn: '7707083893',
    payer_kpp: '770701001',
    payer_bank_bic: '044525225',
    payer_bank_corr_account: '30101810400000000225',
  });
}

function seedInvoice() {
  return invoiceRepo.create({
    file_name: 'a.jpg', file_path: '/a.jpg',
    invoice_number: 'НФНФ-001', invoice_date: '2026-05-06',
    supplier: 'ООО Свит', supplier_inn: '5012089824',
    total_sum: 1234.56, vat_sum: 205.76,
  });
}

function seedSupplier() {
  supplierRepo.create({
    inn: '5012089824', name: 'ООО Свит', kpp: '501201001',
    account: '40702810000000000001', bank_bic: '044525225',
    bank_corr_account: '30101810400000000225',
    verified: 1, source: 'manual',
  });
}

describe('POST /api/invoices/:id/send-sber', () => {
  beforeEach(() => {
    resetDb();
    vi.mocked(createPaymentOrder).mockReset();
  });

  it('happy path — supplier verified → 201 from Sber → row persisted', async () => {
    seedConnectedSber();
    const inv = seedInvoice();
    seedSupplier();
    vi.mocked(createPaymentOrder).mockResolvedValue({ externalId: 'X', number: '999', status: 'ACCEPTED' });
    const res = await request(makeApp()).post(`/api/invoices/${inv.id}/send-sber`).send({});
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.payment_number).toBe('999');
    const stored = sberPaymentRepo.findByInvoiceId(inv.id)!;
    expect(stored.status).toBe('created');
  });

  it('returns 409 needs_supplier_confirmation when supplier not in DB', async () => {
    seedConnectedSber();
    const inv = invoiceRepo.create({
      file_name: 'a.jpg', file_path: '/a.jpg',
      supplier: 'ООО Новый', supplier_inn: '7777777777',
      supplier_bik: '044525225',
      total_sum: 1000,
    });
    const res = await request(makeApp()).post(`/api/invoices/${inv.id}/send-sber`).send({});
    expect(res.status).toBe(409);
    expect(res.body.needs_supplier_confirmation).toBe(true);
    expect(res.body.prefilled).toMatchObject({ inn: '7777777777', bank_bic: '044525225' });
  });

  it('upserts supplier from supplier_overrides and proceeds', async () => {
    seedConnectedSber();
    const inv = seedInvoice();
    vi.mocked(createPaymentOrder).mockResolvedValue({ externalId: 'X', number: '999' });
    const res = await request(makeApp()).post(`/api/invoices/${inv.id}/send-sber`).send({
      supplier_overrides: {
        inn: '5012089824', name: 'ООО Свит', kpp: '501201001',
        bank_bic: '044525225', account: '40702810000000000001',
        bank_corr_account: '30101810400000000225',
      },
    });
    expect(res.status).toBe(200);
    expect(supplierRepo.findByInn('5012089824')?.verified).toBe(1);
  });

  it('returns 409 on duplicate send (UNIQUE invoice_id)', async () => {
    seedConnectedSber();
    const inv = seedInvoice();
    seedSupplier();
    vi.mocked(createPaymentOrder).mockResolvedValue({ externalId: 'X', number: '999' });
    await request(makeApp()).post(`/api/invoices/${inv.id}/send-sber`).send({});
    const res = await request(makeApp()).post(`/api/invoices/${inv.id}/send-sber`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already/i);
  });

  it('returns 502 on Sber 400 and persists failure', async () => {
    seedConnectedSber();
    const inv = seedInvoice();
    seedSupplier();
    vi.mocked(createPaymentOrder).mockRejectedValue(new SberApiError(400, '{"errors":[]}'));
    const res = await request(makeApp()).post(`/api/invoices/${inv.id}/send-sber`).send({});
    expect(res.status).toBe(502);
    expect(sberPaymentRepo.findByInvoiceId(inv.id)?.status).toBe('failed');
  });

  it('returns 400 when Sber not connected', async () => {
    const inv = seedInvoice();
    seedSupplier();
    const res = await request(makeApp()).post(`/api/invoices/${inv.id}/send-sber`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Sber not connected|payer/i);
  });

  it('returns 400 when invoice has no INN', async () => {
    seedConnectedSber();
    const inv = invoiceRepo.create({ file_name: 'a.jpg', file_path: '/a.jpg', total_sum: 100 });
    const res = await request(makeApp()).post(`/api/invoices/${inv.id}/send-sber`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/supplier_inn/);
  });
});

describe('GET /api/invoices/:id/sber-status', () => {
  beforeEach(() => resetDb());

  it('returns null when no payment', async () => {
    const inv = invoiceRepo.create({ file_name: 'a.jpg', file_path: '/a.jpg', total_sum: 100 });
    const res = await request(makeApp()).get(`/api/invoices/${inv.id}/sber-status`);
    expect(res.body.payment).toBeNull();
  });

  it('returns row when exists', async () => {
    const inv = invoiceRepo.create({ file_name: 'a.jpg', file_path: '/a.jpg', total_sum: 100 });
    sberPaymentRepo.create({
      invoice_id: inv.id, external_id: 'X', status: 'created',
      payment_purpose: 'p', amount: 100, payer_account: '40702', payee_inn: '5012',
    });
    const res = await request(makeApp()).get(`/api/invoices/${inv.id}/sber-status`);
    expect(res.body.payment.status).toBe('created');
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

```powershell
npx vitest run tests/api/invoices.send-sber.test.ts
```

- [ ] **Step 3: Add handlers в `src/api/routes/invoices.ts`**

В начале файла (после существующих imports) добавить:

```typescript
import { randomUUID } from 'node:crypto';
import { sberTokenRepo } from '../../database/repositories/sberTokenRepo';
import { supplierRepo } from '../../database/repositories/supplierRepo';
import { sberPaymentRepo } from '../../database/repositories/sberPaymentRepo';
import { userRepo } from '../../database/repositories/userRepo';
import { getValidAccessToken } from '../../sber/oauth';
import { createPaymentOrder, SberApiError } from '../../sber/payments';
import { renderPurpose } from '../../sber/purposeTemplate';
import { redact } from '../../sber/redact';
```

Перед `export default router;` (или в конце маршрутов) добавить:

```typescript
// GET /api/invoices/:id/sber-status — текущее состояние платежа в Сбере
router.get('/:id/sber-status', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
  const payment = sberPaymentRepo.findByInvoiceId(id);
  return res.json({ payment });
});

// POST /api/invoices/:id/send-sber — создать черновик платежа в СберБизнес
router.post('/:id/send-sber', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
  const invoice = invoiceRepo.getById(id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

  if (sberPaymentRepo.findByInvoiceId(id)) {
    return res.status(409).json({ error: 'Payment already created for this invoice' });
  }
  if (!invoice.total_sum || invoice.total_sum <= 0) {
    return res.status(400).json({ error: 'invoice has no total_sum' });
  }
  if (!invoice.supplier_inn) {
    return res.status(400).json({ error: 'invoice has no supplier_inn' });
  }

  const tokenRow = sberTokenRepo.get();
  if (!tokenRow) return res.status(400).json({ error: 'Sber not connected' });
  if (!tokenRow.account_number || !tokenRow.org_name || !tokenRow.payer_inn ||
      !tokenRow.payer_bank_bic || !tokenRow.payer_bank_corr_account) {
    return res.status(400).json({ error: 'payer details incomplete (settings → Сбербанк)' });
  }

  // Resolve supplier
  const overrides = (req.body as { supplier_overrides?: Record<string, unknown> }).supplier_overrides;
  let supplier = supplierRepo.findByInn(invoice.supplier_inn);
  if (overrides) {
    const o = overrides as {
      inn?: string; name?: string; kpp?: string;
      account?: string; bank_bic?: string; bank_corr_account?: string;
      bank_name?: string; address?: string;
    };
    if (!o.inn || !o.name || !o.bank_bic) {
      return res.status(400).json({ error: 'supplier_overrides missing required fields' });
    }
    supplier = supplierRepo.upsert({
      inn: o.inn, name: o.name, kpp: o.kpp ?? null,
      account: o.account ?? null, bank_bic: o.bank_bic,
      bank_corr_account: o.bank_corr_account ?? null,
      bank_name: o.bank_name ?? null, address: o.address ?? null,
      verified: 1, source: 'invoice',
    });
  }
  if (!supplier || !supplier.verified) {
    return res.status(409).json({
      needs_supplier_confirmation: true,
      prefilled: {
        inn: invoice.supplier_inn,
        name: invoice.supplier ?? '',
        kpp: invoice.supplier_kpp ?? null,
        bank_bic: invoice.supplier_bik ?? null,
        account: invoice.supplier_account ?? null,
        bank_corr_account: invoice.supplier_corr_account ?? null,
        address: invoice.supplier_address ?? null,
      },
    });
  }

  // Get token (auto-refresh)
  let accessToken: string;
  try {
    accessToken = await getValidAccessToken();
  } catch (err) {
    return res.status(401).json({ error: `Sber auth failed: ${(err as Error).message}` });
  }

  // Render purpose
  const purposeOverride = (req.body as { purpose_override?: string }).purpose_override;
  const userId = userRepo.firstUserId() ?? 1;
  const tpl = purposeOverride ?? userRepo.getPurposeTemplate(userId) ?? 'Оплата по накладной № {invoice_number} от {invoice_date_dot}, {vat_clause}';
  // Get vat_rate from first item (fallback 20)
  const itemsResult = invoiceRepo.getItems(id);
  const firstVatRate = itemsResult[0]?.vat_rate ?? null;
  const purpose = renderPurpose(tpl, {
    invoice_number: invoice.invoice_number,
    invoice_date: invoice.invoice_date,
    total_sum: invoice.total_sum,
    vat_sum: invoice.vat_sum,
    vat_rate: firstVatRate,
    supplier: supplier.name,
  });

  const externalId = randomUUID();
  const today = new Date().toISOString().slice(0, 10);

  // INSERT pending row first — UNIQUE on invoice_id защитит от двойного клика
  let paymentRow;
  try {
    paymentRow = sberPaymentRepo.create({
      invoice_id: id,
      external_id: externalId,
      status: 'pending',
      payment_purpose: purpose,
      amount: invoice.total_sum,
      payer_account: tokenRow.account_number,
      payee_inn: invoice.supplier_inn,
    });
  } catch (err) {
    if ((err as Error).message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Payment already created for this invoice' });
    }
    throw err;
  }

  // Build payload
  const payload = {
    date: today,
    externalId,
    amount: invoice.total_sum,
    purpose,
    payerName: tokenRow.org_name,
    payerInn: tokenRow.payer_inn,
    payerKpp: tokenRow.payer_kpp ?? undefined,
    payerAccount: tokenRow.account_number,
    payerBankBic: tokenRow.payer_bank_bic,
    payerBankCorrAccount: tokenRow.payer_bank_corr_account,
    payeeName: supplier.name,
    payeeInn: supplier.inn,
    payeeKpp: supplier.kpp ?? undefined,
    payeeAccount: supplier.account ?? undefined,
    payeeBankBic: supplier.bank_bic,
    payeeBankCorrAccount: supplier.bank_corr_account ?? undefined,
  };
  // Persist redacted request payload
  sberPaymentRepo.updateStatus(id, {
    status: 'pending',
    response_body: JSON.stringify(redact(payload)),
  });

  try {
    const result = await createPaymentOrder(accessToken, payload);
    sberPaymentRepo.updateStatus(id, {
      status: 'created',
      sber_payment_number: result.number ?? null,
      response_body: JSON.stringify(redact(result)),
    });
    supplierRepo.touchLastUsed(supplier.inn);
    logger.info('[sber] payment created', { invoice_id: id, number: result.number, externalId });
    return res.json({
      success: true,
      payment_number: result.number,
      external_id: externalId,
    });
  } catch (err) {
    if (err instanceof SberApiError) {
      sberPaymentRepo.updateStatus(id, {
        status: 'failed',
        response_body: err.body,
        error_message: `${err.status}: ${err.body.slice(0, 500)}`,
      });
      logger.error('[sber] payment failed', { invoice_id: id, status: err.status });
      return res.status(502).json({ error: 'Sber API error', sber_status: err.status, sber_body: err.body });
    }
    sberPaymentRepo.updateStatus(id, {
      status: 'failed',
      error_message: (err as Error).message.slice(0, 500),
    });
    logger.error('[sber] payment send error', { invoice_id: id, err: (err as Error).message });
    return res.status(500).json({ error: (err as Error).message });
  }
});
```

Также проверить, есть ли в `invoiceRepo` метод `getItems(id)`. Если нет — добавь там же:

```typescript
getItems(invoiceId: number): InvoiceItem[] {
  return getDb().prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id').all(invoiceId) as InvoiceItem[];
},
```

(Скорее всего метод уже существует — проверь grep'ом.)

- [ ] **Step 4: Run — verify PASS**

```powershell
npx vitest run tests/api/invoices.send-sber.test.ts
```

Expected: PASS, 9/9.

- [ ] **Step 5: Run full test suite — ничего не сломалось**

```powershell
npx vitest run
```

Expected: все тесты passing, +новые ~50.

- [ ] **Step 6: Commit**

```powershell
git add src/api/routes/invoices.ts src/database/repositories/invoiceRepo.ts tests/api/invoices.send-sber.test.ts
git commit -m "feat(api): POST /api/invoices/:id/send-sber + GET /:id/sber-status"
```

---

## Task 6: Wire up `server.ts` + .env.example

**Files:**
- Modify: `src/api/server.ts`
- Modify: `.env.example`

- [ ] **Step 1: Mount routers in `src/api/server.ts`**

Добавить imports после существующих (после `import profileRouter`):

```typescript
import sberRouter from './routes/sber';
import suppliersRouter from './routes/suppliers';
```

И добавить mounts (после `app.use('/api/profile', ...)`):

```typescript
app.use('/api/sber', apiKeyAuth, sberRouter);
app.use('/api/suppliers', apiKeyAuth, suppliersRouter);
```

- [ ] **Step 2: Verify TypeScript builds**

```powershell
npx tsc --noEmit
```

Expected: 0 ошибок.

- [ ] **Step 3: Update `.env.example`**

В конец файла добавить:

```bash
# =============================================================================
# Sber Business API
# =============================================================================
# Регистрация на developers.sber.ru → сервис B2BSaaS. Для production использовать
# scope: openid GET_CLIENT_ACCOUNTS PAY_DOC_RU.
# Сертификаты (.p12 + sber-ca.pem) кладутся в ./certs/ (не в git).
SBER_CLIENT_ID=
SBER_CLIENT_SECRET=
SBER_REDIRECT_URI=https://scanflow.ru/api/sber/callback
SBER_TLS_PFX=./certs/sber.p12
SBER_TLS_PFX_PASSWORD=
SBER_CA_CERT=./certs/sber-ca.pem

# JWT-секрет для подписи OAuth state. Должно быть ≥32 символов.
JWT_SECRET=

# DaData (опционально). Без этого ключа кнопка "Заполнить по ИНН" в UI скрыта.
DADATA_API_KEY=
```

- [ ] **Step 4: Run all tests + integration smoke**

```powershell
npx vitest run
npx tsc --noEmit
```

Expected: все тесты passing.

- [ ] **Step 5: Commit**

```powershell
git add src/api/server.ts .env.example
git commit -m "feat(api): wire /api/sber and /api/suppliers routers + env example"
```

---

## Task 7: Claude prompt — supplier_kpp extraction

**Files:**
- Modify: `src/ocr/claudeApiAnalyzer.ts`
- Modify: `src/ocr/types.ts`
- Test: `tests/ocr/claudeApiAnalyzer.kpp.test.ts`

- [ ] **Step 1: Failing test (unit) — парсер должен возвращать supplier_kpp**

(Если в существующем `claudeApiAnalyzer` есть pure-функция парсинга JSON-ответа — тестируем её. Если нет — пропускаем unit-тест и проверяем только что type extended.)

```typescript
import { describe, it, expect } from 'vitest';
import type { AnalyzedInvoice } from '../../src/ocr/types';

describe('AnalyzedInvoice type', () => {
  it('includes supplier_kpp field', () => {
    const sample: AnalyzedInvoice = {
      invoice_number: '1',
      invoice_date: '2026-05-06',
      supplier: 'X',
      supplier_inn: '7707083893',
      supplier_kpp: '770701001',
      total_sum: 100,
      items: [],
    };
    expect(sample.supplier_kpp).toBe('770701001');
  });
});
```

- [ ] **Step 2: Modify `src/ocr/types.ts`**

В интерфейс `AnalyzedInvoice` (строка 23-24, рядом с `supplier_inn`) добавить:

```typescript
supplier_kpp?: string;
```

- [ ] **Step 3: Modify `src/ocr/claudeApiAnalyzer.ts` — обновить промпт**

Найти строку (около 130):

```
   • "ИНН/КПП продавца", "ИНН поставщика" → supplier_inn (первые 10 или 12 цифр до "/")
```

Заменить на:

```
   • "ИНН/КПП продавца", "ИНН поставщика" → supplier_inn (первые 10 или 12 цифр до "/")
   • После "/" в "ИНН/КПП продавца" → supplier_kpp (9 цифр; у ИП КПП отсутствует — оставь null)
```

В JSON-структуре ответа (около строки 200, поиск по `supplier_inn`) добавить поле `supplier_kpp` рядом с `supplier_inn`.

В разделе многостраничного объединения (около строки 332) — обновить:

```
2. invoice_number/invoice_date/supplier/supplier_inn/supplier_kpp — бери из той страницы, где они не null (обычно первая).
```

- [ ] **Step 4: Modify caller — пробросить supplier_kpp в invoiceRepo.create()**

Найти место, где вызывается `invoiceRepo.create({...})` (скорее всего в `src/watcher/fileWatcher.ts` или в `src/api/routes/upload.ts`). Добавить в передаваемый объект:

```typescript
supplier_kpp: analyzed.supplier_kpp,
```

(Точное место найти grep'ом по `invoiceRepo.create(`.)

- [ ] **Step 5: Run TS-check + tests**

```powershell
npx tsc --noEmit
npx vitest run
```

Expected: всё passing.

- [ ] **Step 6: Commit**

```powershell
git add src/ocr/types.ts src/ocr/claudeApiAnalyzer.ts src/watcher/fileWatcher.ts tests/ocr/claudeApiAnalyzer.kpp.test.ts
git commit -m "feat(ocr): extract supplier_kpp from invoice via Claude prompt"
```

(если правился `src/api/routes/upload.ts` вместо `fileWatcher.ts` — скорректируй путь в `git add`)

---

## Task 8: Frontend — навигация и страница «Сбер»

**Files:**
- Modify: `public/app.html`
- Create: `public/js/sber.js`

- [ ] **Step 1: Update `public/app.html` — добавить пункты nav**

В секции `<nav>` (около строки 79, рядом с пунктом «Webhook») добавить два новых пункта:

```html
<a href="#/suppliers" data-tab="suppliers">
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M4 8h8M3 12h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
  Поставщики
</a>
<a href="#/sber" data-tab="sber">
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><path d="M5 8l2 2 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
  Сбербанк
</a>
```

В конец `<main>` (где находятся другие views, перед `</main>`) добавить:

```html
<!-- View: Sber -->
<div id="view-sber" class="view" hidden>
  <h2>Сбербанк Бизнес</h2>
  <div id="sber-status-card" class="card"><p>Загрузка...</p></div>
  <div id="sber-actions"></div>
</div>

<!-- View: Suppliers -->
<div id="view-suppliers" class="view" hidden>
  <h2>Поставщики</h2>
  <div class="actions-bar">
    <input type="search" id="suppliers-search" placeholder="Поиск по ИНН или названию">
    <button class="btn btn-primary" id="supplier-add-btn">+ Добавить поставщика</button>
  </div>
  <div id="suppliers-table-wrap"></div>
</div>
```

В секции деталей накладной `view-invoice-detail` (поищи `<div id="view-invoice-detail"`) перед блоком actions добавить контейнер для Сбер-секции:

```html
<div id="invoice-sber-section" class="card sber-section" hidden></div>
```

- [ ] **Step 2: Create `public/js/sber.js`**

```javascript
const Sber = {
  state: { status: null },

  async load() {
    const res = await App.fetch('/api/sber/status');
    this.state.status = await res.json();
    this.renderConnectPage();
  },

  renderConnectPage() {
    const card = document.getElementById('sber-status-card');
    const actions = document.getElementById('sber-actions');
    const s = this.state.status;
    if (!s.connected) {
      card.innerHTML = '<p><span class="status-dot status-error"></span>Не подключено</p>';
      actions.innerHTML = `
        <button class="btn btn-primary" onclick="window.location.href='/api/sber/authorize?key='+encodeURIComponent(App.apiKey)">Подключить через OAuth</button>
        <button class="btn btn-outline" onclick="Sber.toggleSeedForm()">Ввести токены вручную</button>
        <div id="sber-seed-form" hidden></div>
      `;
      return;
    }
    const expiredText = s.token_expired ? 'просрочен (надо обновить)' : 'активен';
    const dotClass = s.token_expired ? 'status-warn' : 'status-ok';
    card.innerHTML = `
      <p><span class="status-dot ${dotClass}"></span>Подключено: ${App.escape(s.org_name || '?')}</p>
      <p class="muted">Расчётный счёт: ${App.escape(s.account_number || '?')}</p>
      <p class="muted">Токен: ${expiredText}</p>
      <p class="muted">Реквизиты плательщика: ${s.payer_complete ? 'заполнены' : 'НЕПОЛНЫЕ — заполните ниже'}</p>
    `;
    actions.innerHTML = `
      <h3>Реквизиты плательщика</h3>
      <form id="sber-payer-form" class="form-grid">
        <label>ИНН<input name="payer_inn" value="${App.escape(s.payer_inn || '')}" pattern="[0-9]{10,12}" required></label>
        <label>КПП<input name="payer_kpp" value="${App.escape(s.payer_kpp || '')}" pattern="[0-9]{9}"></label>
        <label>БИК банка<input name="payer_bank_bic" value="${App.escape(s.payer_bank_bic || '')}" pattern="[0-9]{9}" required></label>
        <label>Корсчёт банка<input name="payer_bank_corr_account" value="${App.escape(s.payer_bank_corr_account || '')}" pattern="[0-9]{20}" required></label>
        <button class="btn btn-primary" type="submit">Сохранить реквизиты</button>
      </form>
      <button class="btn btn-danger" onclick="Sber.disconnect()">Отключить</button>
    `;
    document.getElementById('sber-payer-form').addEventListener('submit', (e) => Sber.savePayer(e));
  },

  toggleSeedForm() {
    const wrap = document.getElementById('sber-seed-form');
    if (wrap.hidden) {
      wrap.innerHTML = `
        <h3>Manual seed-token</h3>
        <form id="seed-form" class="form-grid">
          <label>Access Token<input name="access_token" required></label>
          <label>Refresh Token<input name="refresh_token" required></label>
          <label>Номер расчётного счёта (20 цифр)<input name="account_number" pattern="[0-9]{20}"></label>
          <label>Наименование организации<input name="org_name"></label>
          <label>ИНН<input name="payer_inn" pattern="[0-9]{10,12}"></label>
          <label>КПП<input name="payer_kpp" pattern="[0-9]{9}"></label>
          <label>БИК банка<input name="payer_bank_bic" pattern="[0-9]{9}"></label>
          <label>Корсчёт банка<input name="payer_bank_corr_account" pattern="[0-9]{20}"></label>
          <button class="btn btn-primary" type="submit">Сохранить</button>
        </form>
      `;
      wrap.hidden = false;
      document.getElementById('seed-form').addEventListener('submit', (e) => Sber.saveSeed(e));
    } else {
      wrap.hidden = true;
    }
  },

  async saveSeed(e) {
    e.preventDefault();
    const form = e.target;
    const data = Object.fromEntries(new FormData(form).entries());
    const res = await App.fetch('/api/sber/seed-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json();
      App.notify(err.error || 'Ошибка', 'error');
      return;
    }
    App.notify('Токены сохранены', 'success');
    this.load();
  },

  async savePayer(e) {
    e.preventDefault();
    const form = e.target;
    const data = Object.fromEntries(new FormData(form).entries());
    const res = await App.fetch('/api/sber/payer', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json();
      App.notify(err.error || 'Ошибка', 'error');
      return;
    }
    App.notify('Реквизиты сохранены', 'success');
    this.load();
  },

  async disconnect() {
    if (!confirm('Точно отключить Сбербанк?')) return;
    await App.fetch('/api/sber/disconnect', { method: 'POST' });
    this.load();
  },

  // ===== Section на странице деталей накладной =====
  async renderInvoiceSection(invoice) {
    const wrap = document.getElementById('invoice-sber-section');
    if (!wrap) return;
    wrap.hidden = false;
    const status = this.state.status || (await (await App.fetch('/api/sber/status')).json());
    this.state.status = status;
    if (!status.connected || !status.payer_complete) {
      wrap.innerHTML = `
        <h3>Сбербанк</h3>
        <p class="muted">Сбербанк не подключён. <a href="#/sber">Подключить</a></p>
      `;
      return;
    }
    const stRes = await App.fetch(`/api/invoices/${invoice.id}/sber-status`);
    const { payment } = await stRes.json();
    if (payment && payment.status === 'created') {
      wrap.innerHTML = `
        <h3>Сбербанк</h3>
        <div class="badge badge-sent">✓ Платёж создан в Сбере (черновик № ${App.escape(payment.sber_payment_number || '?')}). Подпишите в Сбер.Бизнес.</div>
      `;
      return;
    }
    if (payment && payment.status === 'failed') {
      wrap.innerHTML = `
        <h3>Сбербанк</h3>
        <p class="error-text">Ошибка отправки: ${App.escape(payment.error_message || 'unknown')}</p>
        <button class="btn btn-primary" onclick="Sber.sendToSber(${invoice.id})">Попробовать снова</button>
      `;
      return;
    }
    wrap.innerHTML = `
      <h3>Сбербанк</h3>
      <button class="btn btn-primary" id="sber-send-btn" onclick="Sber.sendToSber(${invoice.id})">Отправить в Сбербанк →</button>
    `;
  },

  async sendToSber(invoiceId, supplierOverrides) {
    const btn = document.getElementById('sber-send-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Создание платежа...'; }
    const body = supplierOverrides ? { supplier_overrides: supplierOverrides } : {};
    const res = await App.fetch(`/api/invoices/${invoiceId}/send-sber`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 409 && (await res.clone().json()).needs_supplier_confirmation) {
      const data = await res.json();
      SberModal.open(data.prefilled, async (overrides) => {
        await Sber.sendToSber(invoiceId, overrides);
      });
      if (btn) { btn.disabled = false; btn.textContent = 'Отправить в Сбербанк →'; }
      return;
    }
    if (!res.ok) {
      const err = await res.json();
      App.notify(err.error || `Ошибка ${res.status}`, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Отправить в Сбербанк →'; }
      return;
    }
    const ok = await res.json();
    App.notify(`Черновик создан в Сбере (№ ${ok.payment_number || '?'}). Подпишите в Сбер.Бизнес.`, 'success');
    Invoices.loadDetails(invoiceId); // перерендерим
  },
};

window.Sber = Sber;
```

- [ ] **Step 3: Wire up nav handler в `public/js/app.js`**

Найди функцию роутинга (поиск по `data-tab` или `view-` prefix). Добавить два новых case'а:

```javascript
// в switch, рядом с 'webhook':
case 'sber': Sber.load(); break;
case 'suppliers': Suppliers.load(); break;
```

Убедись что `<script src="/js/sber.js"></script>` подключается в `app.html`.

- [ ] **Step 4: Manual smoke**

```powershell
npm run dev
```

В браузере: http://localhost:8899 → Login → перейти на `#/sber` → должна показываться страница «Не подключено». Через DevTools проверь что `GET /api/sber/status` отдаёт 200 с `{connected: false}`.

- [ ] **Step 5: Commit**

```powershell
git add public/app.html public/js/sber.js public/js/app.js
git commit -m "feat(ui): Sber connect page (/#/sber) + invoice section + seed-token form"
```

---

## Task 9: Frontend — страница «Поставщики» + модалка подтверждения

**Files:**
- Create: `public/js/suppliers.js`
- Create: `public/js/sber-modal.js`
- Modify: `public/app.html`

- [ ] **Step 1: Create `public/js/suppliers.js`**

```javascript
const Suppliers = {
  state: { items: [], q: '' },

  async load() {
    await this.refresh();
    this.bindUi();
  },

  bindUi() {
    const search = document.getElementById('suppliers-search');
    if (search) {
      search.value = this.state.q;
      search.oninput = App.debounce(() => {
        this.state.q = search.value;
        this.refresh();
      }, 250);
    }
    const addBtn = document.getElementById('supplier-add-btn');
    if (addBtn) addBtn.onclick = () => SberModal.open({}, async (data) => Suppliers.create(data));
  },

  async refresh() {
    const params = new URLSearchParams();
    if (this.state.q) params.set('q', this.state.q);
    const res = await App.fetch('/api/suppliers?' + params);
    const { suppliers } = await res.json();
    this.state.items = suppliers;
    this.render();
  },

  render() {
    const wrap = document.getElementById('suppliers-table-wrap');
    if (!wrap) return;
    if (this.state.items.length === 0) {
      wrap.innerHTML = '<p class="muted">Поставщики пока не добавлены.</p>';
      return;
    }
    const rows = this.state.items.map(s => `
      <tr>
        <td>${App.escape(s.inn)}</td>
        <td>${App.escape(s.name)}</td>
        <td>${App.escape(s.kpp || '')}</td>
        <td>${App.escape(s.bank_bic)}</td>
        <td>${App.escape(s.account || '')}</td>
        <td>${s.verified ? '<span class="badge badge-ok">✓</span>' : '<span class="badge badge-warn">!</span>'}</td>
        <td>${s.last_used_at || ''}</td>
        <td>
          <button class="btn-icon" onclick="Suppliers.edit('${App.escape(s.inn)}')">✎</button>
          <button class="btn-icon-danger" onclick="Suppliers.remove('${App.escape(s.inn)}')">🗑</button>
        </td>
      </tr>
    `).join('');
    wrap.innerHTML = `
      <table class="data-table">
        <thead><tr><th>ИНН</th><th>Название</th><th>КПП</th><th>БИК</th><th>Счёт</th><th>Verified</th><th>Last used</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  },

  async edit(inn) {
    const res = await App.fetch('/api/suppliers/' + encodeURIComponent(inn));
    const { supplier } = await res.json();
    SberModal.open(supplier, async (data) => Suppliers.update(inn, data));
  },

  async create(data) {
    const res = await App.fetch('/api/suppliers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      App.notify((await res.json()).error || 'Ошибка', 'error');
      return false;
    }
    App.notify('Поставщик добавлен', 'success');
    this.refresh();
    return true;
  },

  async update(inn, data) {
    const res = await App.fetch('/api/suppliers/' + encodeURIComponent(inn), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      App.notify((await res.json()).error || 'Ошибка', 'error');
      return false;
    }
    App.notify('Изменения сохранены', 'success');
    this.refresh();
    return true;
  },

  async remove(inn) {
    if (!confirm(`Удалить поставщика ${inn}?`)) return;
    await App.fetch('/api/suppliers/' + encodeURIComponent(inn), { method: 'DELETE' });
    this.refresh();
  },
};

window.Suppliers = Suppliers;
```

- [ ] **Step 2: Create `public/js/sber-modal.js`**

```javascript
const SberModal = {
  _onSave: null,

  open(prefilled, onSave) {
    this._onSave = onSave;
    let modal = document.getElementById('sber-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'sber-modal';
      modal.className = 'modal-backdrop';
      modal.innerHTML = `
        <div class="modal-card">
          <h3>Реквизиты поставщика</h3>
          <form id="sber-modal-form" class="form-grid">
            <label>ИНН *<input name="inn" required pattern="[0-9]{10,12}"></label>
            <label>Название *<input name="name" required></label>
            <label>КПП<input name="kpp" pattern="[0-9]{9}"></label>
            <label>БИК банка *<input name="bank_bic" required pattern="[0-9]{9}"></label>
            <label>Счёт<input name="account" pattern="[0-9]{20}"></label>
            <label>Корсчёт банка<input name="bank_corr_account" pattern="[0-9]{20}"></label>
            <label>Название банка<input name="bank_name"></label>
            <label>Адрес<input name="address"></label>
            <div class="form-actions">
              <button type="button" class="btn btn-outline" id="sber-modal-dadata">Заполнить по ИНН (DaData)</button>
              <button type="button" class="btn btn-ghost" id="sber-modal-cancel">Отмена</button>
              <button type="submit" class="btn btn-primary">Сохранить и продолжить</button>
            </div>
          </form>
        </div>
      `;
      document.body.appendChild(modal);
    }
    const form = modal.querySelector('#sber-modal-form');
    form.reset();
    for (const [k, v] of Object.entries(prefilled || {})) {
      const inp = form.querySelector(`[name="${k}"]`);
      if (inp && v != null) inp.value = v;
    }
    modal.style.display = 'flex';
    modal.querySelector('#sber-modal-cancel').onclick = () => SberModal.close();
    modal.querySelector('#sber-modal-dadata').onclick = () => SberModal.fillByInn();
    form.onsubmit = (e) => SberModal.submit(e);
  },

  close() {
    const m = document.getElementById('sber-modal');
    if (m) m.style.display = 'none';
  },

  async fillByInn() {
    const form = document.getElementById('sber-modal-form');
    const inn = form.querySelector('[name="inn"]').value;
    if (!/^[0-9]{10,12}$/.test(inn)) {
      App.notify('Сначала введите ИНН', 'error');
      return;
    }
    const res = await App.fetch('/api/suppliers/lookup-dadata', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inn }),
    });
    if (res.status === 503) {
      App.notify('DaData не сконфигурирован. Заполните вручную.', 'error');
      return;
    }
    if (!res.ok) {
      App.notify('DaData недоступен', 'error');
      return;
    }
    const { party } = await res.json();
    if (!party) {
      App.notify('Контрагент с таким ИНН не найден в DaData', 'warn');
      return;
    }
    if (party.name) form.querySelector('[name="name"]').value = party.name;
    if (party.kpp) form.querySelector('[name="kpp"]').value = party.kpp;
    if (party.address) form.querySelector('[name="address"]').value = party.address;
  },

  async submit(e) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target).entries());
    const ok = await SberModal._onSave?.(data);
    if (ok !== false) SberModal.close();
  },
};

window.SberModal = SberModal;
```

- [ ] **Step 3: Подключить в `public/app.html`**

В конце body, рядом с другими `<script>`-ами, добавить:

```html
<script src="/js/sber.js"></script>
<script src="/js/suppliers.js"></script>
<script src="/js/sber-modal.js"></script>
```

- [ ] **Step 4: Hook Sber section в invoice details**

Открой `public/js/invoices.js`. Найди метод, который рендерит детали накладной (поиск `renderDetails` или `loadDetails`). После того как блок actions отрисован (примерно строка 270, после `actionsHtml += button "Удалить накладную"`), добавь:

```javascript
if (window.Sber) Sber.renderInvoiceSection(data);
```

- [ ] **Step 5: Manual smoke**

```powershell
npm run dev
```

- Перейти на `#/suppliers` — пустая таблица.
- «+ Добавить» → модалка → ввести ИНН/имя/БИК → сохранить → таблица обновляется.
- На детали накладной — секция Сбербанк появляется (если подключено).

- [ ] **Step 6: Commit**

```powershell
git add public/js/suppliers.js public/js/sber-modal.js public/app.html public/js/invoices.js
git commit -m "feat(ui): suppliers page + supplier-confirmation modal + invoice sber section"
```

---

## Task 10: CLAUDE.md update

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Добавить в раздел «Pipeline» Sber-флоу**

После блока «Production:» добавить:

```markdown
## Sber Business integration

- Кнопка «Отправить в Сбербанк» на странице деталей накладной создаёт черновик платёжного поручения в СберБизнес через API `POST /fintech/api/v1/payments` (scope `PAY_DOC_RU`). ЭП не делаем — пользователь подписывает в банке руками.
- mTLS через PFX + passphrase (`./certs/sber.p12`, env `SBER_TLS_PFX_PASSWORD`). CA — `./certs/sber-ca.pem`.
- Подключение: либо OAuth (`/api/sber/authorize` → callback), либо manual seed-token на странице `/#/sber`.
- Поставщики хранятся в таблице `suppliers` (PK = ИНН). Auto-create при первой отправке (через подтверждение в модалке) + ручная страница `/#/suppliers` с DaData-lookup.
- Лог отправок — `sber_payments` (UNIQUE по `invoice_id` = один платёж на накладную). Дебаг: `SELECT * FROM sber_payments WHERE invoice_id = ?`.

Файлы:
- `src/sber/` — клиент, OAuth, payments, purpose template, DaData
- `src/api/routes/sber.ts` — `/api/sber/*`
- `src/api/routes/suppliers.ts` — `/api/suppliers/*`
- `src/api/routes/invoices.ts` — `POST /:id/send-sber`
- `public/js/sber.js`, `public/js/suppliers.js`, `public/js/sber-modal.js`
```

- [ ] **Step 2: Добавить в раздел «Database (high level)» новые таблицы**

Найти список «Main tables:» — обновить:

```markdown
Main tables: `invoices`, `invoice_items`, `nomenclature_mappings`, `onec_nomenclature`, `webhook_config`, `analyzer_config`, `users`, `notification_events`, `sber_tokens`, `suppliers`, `sber_payments`. См. `src/database/migrations.ts` для точных колонок.
```

- [ ] **Step 3: В раздел «Things future-Claude must not break» добавить пункт**

```markdown
12. **Sber payments — `Authorization` без `Bearer`.** В отличие от 99% OAuth-API, Sber `/v1/payments` ждёт голый токен (`Authorization: <token>`), а не `Bearer <token>`. См. OpenAPI и `src/sber/payments.ts`.
13. **Sber payments — `purpose` ≤ 210 символов.** Длиннее — сервер возвращает 400. `renderPurpose()` обрезает до 210, ёлочки/тире/неразрывные пробелы заменяет — это не косметика, это требование API.
```

- [ ] **Step 4: Commit**

```powershell
git add CLAUDE.md
git commit -m "docs: CLAUDE.md — Sber integration section + must-not-break items"
```

---

## Task 11: Final verification + manual smoke

- [ ] **Step 1: Run all tests**

```powershell
npx vitest run
```

Expected: ~210+ тестов passing (167 baseline + ~50 новых). 0 failed.

- [ ] **Step 2: TypeScript check**

```powershell
npx tsc --noEmit
```

Expected: 0 ошибок.

- [ ] **Step 3: Manual UI smoke (без реального Sber)**

```powershell
npm run dev
```

Чек-лист в браузере:

1. Login.
2. `#/sber` → отображается «Не подключено», кнопки видны.
3. «Ввести вручную» → форма открывается, валидация: ввести `account_number = 407` — должна ругаться на 20 цифр. Ввести валидный `40702810940000099835` + остальные поля → «Сохранить» → редирект, статус «Подключено».
4. `#/suppliers` → пустая таблица. «+ Добавить» → модалка → ввести `5012089824 / ООО Тест / 044525225` → сохранить → запись появляется.
5. Открыть любую накладную → видна секция «Сбербанк». Кнопка «Отправить в Сбербанк →» активна (т.к. подключено). Жмём — если supplier с ИНН накладной не verified, открывается модалка подтверждения. Подтверждаем → должна полететь mock'ом — тут пайплайн упадёт на реальном вызове Sber, но это OK для smoke. На деле в продакшне должно создаться черновик в СберБизнес.

- [ ] **Step 4: Restore stashed pre-existing changes**

```powershell
git stash pop
```

Resolve conflicts если есть. Проверить `git status` — должны вернуться WIP-файлы.

- [ ] **Step 5: Final commit (если что-то догадили на smoke)**

Если на smoke поправили что-то некритичное:

```powershell
git add -p
git commit -m "fix(sber): smoke fixes"
```

- [ ] **Step 6: Push branch (НЕ MERGE)**

```powershell
git push -u origin feature/sber-business-payments
```

**НЕ мержить в main** до того как:
1. Сертификаты выгружены на прод-сервер
2. `.env` на проде дополнен Sber-переменными
3. Пользователь готов к деплою (мерж в main = auto-deploy через GitHub Actions)

---

## Self-review checklist (run after writing the plan)

- [x] **Spec coverage:** все секции spec покрыты задачами:
  - Архитектура → Tasks 0-9
  - БД миграция 20 → Task 1
  - Sber API spec → Task 3e (payments) + Task 3b (sberClient)
  - Шаблон purpose → Task 3a
  - API роуты → Tasks 5a/5b/5c
  - Frontend → Tasks 8/9
  - DaData → Task 3f
  - Безопасность → redact (Task 2a) + .env.example (Task 6) + .gitignore (Task 0)
  - Логирование → встроено в API роуты (5a/5b/5c)
  - Тесты — каждая фича имеет TDD-цикл
  - Поток подключения → Task 11 manual smoke
- [x] **Placeholder scan:** ни одного TBD/TODO/«similar to». Все шаги имеют конкретный код.
- [x] **Type consistency:** `SberPayment.status`, `Supplier.verified`, `SberToken.expires_at` — везде string/number единообразно.
- [x] **Скрытые зависимости:** Task 5c использует `invoiceRepo.getItems(id)` — указано проверить grep'ом, дописать если не существует. `userRepo.firstUserId()` — уже есть.
- [x] **Test infrastructure:** `tests/helpers/db.ts` упомянут с реалистичной сигнатурой; если не существует — создаётся в Task 2b/Step 1.

Все претензии закрыты.

---

## Execution

После написания этого плана будет предложено:

1. **Subagent-Driven** (рекомендуется) — диспатч свежего сабагента на каждую задачу с двух-стадийным ревью.
2. **Inline** — выполнение в текущей сессии через `executing-plans` с чекпоинтами.

Опции — после явного подтверждения пользователя.
