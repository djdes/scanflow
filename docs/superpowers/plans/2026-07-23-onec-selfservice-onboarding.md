# Self-service 1C onboarding (pairing code) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a client (role `user`) self-connect their 1C base to their own ScanFlow account with a short one-time pairing code instead of copying a long token.

**Architecture:** A thin pairing-code layer over the existing `onec_connections` scoped-token infra. Client cabinet issues a short code (`POST /api/onec/pairing-code`); the 1C обработка exchanges it (`POST /api/onec/pair`, public) for a normal `onec_connections` token via the existing `onecConnectionRepo.create`. Exchange, isolation, revoke, list — all reused unchanged.

**Tech Stack:** Node 25 + TypeScript (strict), Express 5, MySQL via `getDb()` (mysql2), vitest + supertest, vanilla JS frontend, 1C BSL (manual).

## Global Constraints

- Все репозиторные методы `async` (Promise); транзакции — `await getDb().transaction(async (txn) => …)`.
- Миграции: новый объект в `src/database/migrations.ts` (никогда не редактировать прошлые), идемпотентные (`CREATE TABLE IF NOT EXISTS`, `hasColumn`/`hasTable` guard), с `detect()`. **Перепроверить актуальный max версии командой перед началом** (на момент дизайна = 55 → новая 56).
- Тесты с БД гейтятся `describe.runIf((process.env.DB_NAME || '').includes('test'))`; прогон: `DB_HOST=127.0.0.1 DB_NAME=scanflow_test DB_USER=scanflow DB_PASSWORD=Xzi9M9Dt3O0V9zGSa1BdOuEOiVwu npx vitest run <path>`. Проверка типов: `npx tsc --noEmit`.
- Route-тесты: `supertest` + `createServer` из `src/api/server` (см. `tests/api/auth.magicLink.test.ts`). Аутентификация — заголовок `X-API-Key` = `users.api_key`.
- Не менять `onec_connections`, `onecConnectionRepo`, `onecExchangeRouter`, изоляцию по `owner_user_id`.

---

### Task 1: Таблица `onec_pairing_codes` + репозиторий `onecPairingRepo`

**Files:**
- Modify: `src/database/migrations.ts` (добавить новый объект миграции в конец массива `MIGRATIONS`)
- Create: `src/database/repositories/onecPairingRepo.ts`
- Test: `tests/database/onecPairing.test.ts`

**Interfaces:**
- Produces:
  - `onecPairingRepo.create(ownerUserId: number, baseName: string): Promise<{ code: string; expiresAt: string }>`
  - `onecPairingRepo.redeem(code: string): Promise<{ ownerUserId: number; baseName: string } | null>`

- [ ] **Step 1: Проверить актуальный max версии миграции**

Run: `grep -oE "version: [0-9]+" src/database/migrations.ts | grep -oE "[0-9]+" | sort -n | tail -1`
Expected: печатает число (на момент дизайна `55`). Дальше в шаге 3 использовать `<max>+1` (ниже пример для `56`).

- [ ] **Step 2: Написать падающий тест репозитория**

Create `tests/database/onecPairing.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { onecPairingRepo } from '../../src/database/repositories/onecPairingRepo';

describe.runIf((process.env.DB_NAME || '').includes('test'))('onecPairingRepo', () => {
  let owner = 0;
  beforeEach(async () => {
    await resetDb();
    const r = await getDb().prepare(
      `INSERT INTO users (username, password_hash, api_key, role, notify_events) VALUES ('o','x','k-o','user','[]')`
    ).run();
    owner = Number(r.lastInsertRowid);
  });
  afterAll(async () => { await closeTestDb(); });

  it('create returns a short code and redeem yields the owner once', async () => {
    const { code } = await onecPairingRepo.create(owner, 'База клиента');
    expect(code).toMatch(/^1C-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    const first = await onecPairingRepo.redeem(code);
    expect(first).toEqual({ ownerUserId: owner, baseName: 'База клиента' });

    // second redeem of the same code fails (one-time)
    expect(await onecPairingRepo.redeem(code)).toBeNull();
  });

  it('redeem returns null for unknown or expired codes', async () => {
    expect(await onecPairingRepo.redeem('1C-XXXX-YYYY')).toBeNull();

    const { code } = await onecPairingRepo.create(owner, 'X');
    await getDb().prepare(
      `UPDATE onec_pairing_codes SET expires_at = (NOW() - INTERVAL 1 MINUTE) WHERE code = ?`
    ).run(code);
    expect(await onecPairingRepo.redeem(code)).toBeNull();
  });

  it('creating a new code invalidates the previous unused code for that user', async () => {
    const a = await onecPairingRepo.create(owner, 'A');
    await onecPairingRepo.create(owner, 'B');
    expect(await onecPairingRepo.redeem(a.code)).toBeNull();
  });
});
```

- [ ] **Step 3: Добавить миграцию** (в конец массива `MIGRATIONS`, до закрывающего `];`)

```typescript
  {
    version: 56, // ← заменить на (актуальный max из Step 1) + 1
    name: 'onec_pairing_codes — short one-time codes for self-service 1C onboarding',
    detect: (exec) => hasTable(exec, 'onec_pairing_codes'),
    run: async (exec) => {
      await exec.query(`
        CREATE TABLE IF NOT EXISTS onec_pairing_codes (
          id            INT AUTO_INCREMENT PRIMARY KEY,
          code          VARCHAR(20) NOT NULL,
          owner_user_id INT NOT NULL,
          base_name     VARCHAR(128) NOT NULL DEFAULT '',
          created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          expires_at    DATETIME NOT NULL,
          used_at       DATETIME NULL,
          UNIQUE KEY uq_onec_pairing_code (code),
          INDEX idx_onec_pairing_owner (owner_user_id),
          CONSTRAINT fk_onec_pairing_user FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    },
  },
```

Примечание: `hasTable` уже импортирован/используется в `migrations.ts` (см. миграцию `onec_connections`). Если рядом требуется `RowDataPacket` — он там тоже уже импортирован.

- [ ] **Step 4: Реализовать репозиторий**

Create `src/database/repositories/onecPairingRepo.ts`:
```typescript
import { randomBytes } from 'crypto';
import { getDb } from '../db';

// Короткий человеко-вводимый код: 8 символов из однозначного алфавита
// (без 0/O/1/I), формат 1C-XXXX-XXXX.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_TTL_MINUTES = 15;

function generatePairingCode(): string {
  const buf = randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
  return `1C-${s.slice(0, 4)}-${s.slice(4, 8)}`;
}

export const onecPairingRepo = {
  async create(ownerUserId: number, baseName: string): Promise<{ code: string; expiresAt: string }> {
    const db = getDb();
    // Инвалидируем прошлые неиспользованные коды этого пользователя.
    await db.prepare(
      `UPDATE onec_pairing_codes SET used_at = NOW() WHERE owner_user_id = ? AND used_at IS NULL`
    ).run(ownerUserId);

    // Генерим уникальный код (несколько попыток на случай коллизии).
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generatePairingCode();
      try {
        await db.prepare(
          `INSERT INTO onec_pairing_codes (code, owner_user_id, base_name, expires_at)
           VALUES (?, ?, ?, (NOW() + INTERVAL ${CODE_TTL_MINUTES} MINUTE))`
        ).run(code, ownerUserId, (baseName || '').trim().slice(0, 128));
        const row = await db.prepare(
          `SELECT expires_at FROM onec_pairing_codes WHERE code = ?`
        ).get<{ expires_at: string }>(code);
        return { code, expiresAt: String(row?.expires_at) };
      } catch (e) {
        if (attempt === 4) throw e; // исчерпали попытки — пробрасываем
      }
    }
    throw new Error('failed to generate a unique pairing code');
  },

  async redeem(code: string): Promise<{ ownerUserId: number; baseName: string } | null> {
    const db = getDb();
    const row = await db.prepare(
      `SELECT id, owner_user_id, base_name FROM onec_pairing_codes
        WHERE code = ? AND used_at IS NULL AND expires_at > NOW()`
    ).get<{ id: number; owner_user_id: number; base_name: string }>(code);
    if (!row) return null;
    const res = await db.prepare(
      `UPDATE onec_pairing_codes SET used_at = NOW() WHERE id = ? AND used_at IS NULL`
    ).run(row.id);
    // Гонка: если кто-то погасил код между SELECT и UPDATE — affectedRows = 0.
    if (Number((res as { affectedRows?: number }).affectedRows ?? 1) === 0) return null;
    return { ownerUserId: row.owner_user_id, baseName: row.base_name };
  },
};
```

- [ ] **Step 5: Прогнать тест — зелёный**

Run: `DB_HOST=127.0.0.1 DB_NAME=scanflow_test DB_USER=scanflow DB_PASSWORD=Xzi9M9Dt3O0V9zGSa1BdOuEOiVwu npx vitest run tests/database/onecPairing.test.ts`
Expected: 3 passed. Затем `npx tsc --noEmit` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/database/migrations.ts src/database/repositories/onecPairingRepo.ts tests/database/onecPairing.test.ts
git commit -m "feat(onec): onec_pairing_codes table + onecPairingRepo (create/redeem)"
```

---

### Task 2: `POST /api/onec/pairing-code` (доступен роли user)

**Files:**
- Modify: `src/api/routes/onec.ts` (добавить `onecUserRouter` с роутом `/pairing-code`)
- Modify: `src/api/server.ts` (примонтировать `onecUserRouter` под `apiKeyAuth` ДО admin-роутера)
- Test: `tests/api/onecPairing.routes.test.ts`

**Interfaces:**
- Consumes: `onecPairingRepo.create` (Task 1)
- Produces: `POST /api/onec/pairing-code` (X-API-Key) → `201 { data: { code, expires_at } }`. Экспорт `onecUserRouter` из `onec.ts`.

- [ ] **Step 1: Написать падающий route-тест**

Create `tests/api/onecPairing.routes.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { createServer } from '../../src/api/server';

const app = createServer();

async function mkUser(username: string, role: string, key: string): Promise<number> {
  const r = await getDb().prepare(
    `INSERT INTO users (username, password_hash, api_key, role, notify_events) VALUES (?, 'x', ?, ?, '[]')`
  ).run(username, key, role);
  return Number(r.lastInsertRowid);
}

describe.runIf((process.env.DB_NAME || '').includes('test'))('POST /api/onec/pairing-code', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  it('role=user can generate a pairing code (not admin-gated)', async () => {
    await mkUser('client', 'user', 'client-key');
    const res = await request(app)
      .post('/api/onec/pairing-code')
      .set('X-API-Key', 'client-key')
      .send({ base_name: 'База клиента' });
    expect(res.status).toBe(201);
    expect(res.body.data.code).toMatch(/^1C-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(res.body.data.expires_at).toBeTruthy();
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).post('/api/onec/pairing-code').send({});
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Прогнать — падает** (роут не существует → 404)

Run: `DB_HOST=127.0.0.1 DB_NAME=scanflow_test DB_USER=scanflow DB_PASSWORD=Xzi9M9Dt3O0V9zGSa1BdOuEOiVwu npx vitest run tests/api/onecPairing.routes.test.ts`
Expected: FAIL (ожидали 201, получили 404).

- [ ] **Step 3: Добавить `onecUserRouter` в `onec.ts`**

В `src/api/routes/onec.ts` рядом с `export const onecAdminRouter = Router();` добавить:
```typescript
export const onecUserRouter = Router();

// Доступен ЛЮБОМУ авторизованному пользователю (в т.ч. роль user) — self-service.
onecUserRouter.post('/pairing-code', async (req: Request, res: Response) => {
  const ownerUserId = req.user?.id;
  if (ownerUserId == null) return res.status(401).json({ error: 'Unauthorized' });
  const baseName = String(req.body?.base_name || '').trim();
  const { code, expiresAt } = await onecPairingRepo.create(ownerUserId, baseName);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(201).json({ data: { code, expires_at: expiresAt } });
});
```
Добавить импорт вверху файла: `import { onecPairingRepo } from '../../database/repositories/onecPairingRepo';`

- [ ] **Step 4: Примонтировать в `server.ts` ДО admin-роутера**

В `src/api/server.ts`: обновить импорт и монтирование onec.
Импорт (строка ~32): добавить `onecUserRouter`:
```typescript
import { onecAdminRouter, onecExchangeRouter, onecUserRouter, setOnecMapper } from './routes/onec';
```
Монтирование: **перед** строкой `app.use('/api/onec', apiKeyAuth, requireAdmin, onecAdminRouter);` вставить:
```typescript
  // Self-service: генерация кода подключения доступна любому пользователю.
  app.use('/api/onec', apiKeyAuth, onecUserRouter);
```
(Порядок важен: user-роутер обрабатывает только `/pairing-code` и вызывает `next()` для остального → падает в admin-роутер с `requireAdmin`.)

- [ ] **Step 5: Прогнать — зелёный**

Run: та же команда, что в Step 2.
Expected: 2 passed. Затем `npx tsc --noEmit` → 0.

- [ ] **Step 6: Commit**

```bash
git add src/api/routes/onec.ts src/api/server.ts tests/api/onecPairing.routes.test.ts
git commit -m "feat(onec): POST /api/onec/pairing-code — self-service code generation"
```

---

### Task 3: `POST /api/onec/pair` (публичный, обмен кода на токен)

**Files:**
- Modify: `src/api/routes/onec.ts` (добавить `onecPairRouter`)
- Modify: `src/api/server.ts` (примонтировать публично, с rate-limit, ДО `/api/onec` admin)
- Test: `tests/api/onecPair.routes.test.ts`

**Interfaces:**
- Consumes: `onecPairingRepo.redeem` (Task 1); `onecConnectionRepo.create` (существует).
- Produces: `POST /api/onec/pair` (public) → `201 { data: { token, exchange_url, header } }` | `400 { error: 'code_invalid_or_expired' }`.

- [ ] **Step 1: Написать падающий тест**

Create `tests/api/onecPair.routes.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { createServer } from '../../src/api/server';
import { onecPairingRepo } from '../../src/database/repositories/onecPairingRepo';

const app = createServer();

async function mkUser(): Promise<number> {
  const r = await getDb().prepare(
    `INSERT INTO users (username, password_hash, api_key, role, notify_events) VALUES ('c','x','ck','user','[]')`
  ).run();
  return Number(r.lastInsertRowid);
}

describe.runIf((process.env.DB_NAME || '').includes('test'))('POST /api/onec/pair', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  it('valid code → creates a connection token owned by the user', async () => {
    const owner = await mkUser();
    const { code } = await onecPairingRepo.create(owner, 'База');

    const res = await request(app).post('/api/onec/pair').send({ code });
    expect(res.status).toBe(201);
    expect(res.body.data.token).toMatch(/^sf1c_/);
    expect(res.body.data.header).toBe('X-1C-Token');
    expect(res.body.data.exchange_url).toContain('/api/onec/exchange');

    // токен привязан к владельцу кода
    const conn = await getDb().prepare(
      `SELECT owner_user_id FROM onec_connections WHERE token_prefix = ?`
    ).get<{ owner_user_id: number }>(res.body.data.token.slice(0, 12));
    expect(conn?.owner_user_id).toBe(owner);
  });

  it('invalid or already-used code → 400', async () => {
    const owner = await mkUser();
    const { code } = await onecPairingRepo.create(owner, 'X');
    await onecPairingRepo.redeem(code); // погасили

    expect((await request(app).post('/api/onec/pair').send({ code })).status).toBe(400);
    expect((await request(app).post('/api/onec/pair').send({ code: '1C-AAAA-BBBB' })).status).toBe(400);
  });
});
```

- [ ] **Step 2: Прогнать — падает** (404).

Run: `DB_HOST=127.0.0.1 DB_NAME=scanflow_test DB_USER=scanflow DB_PASSWORD=Xzi9M9Dt3O0V9zGSa1BdOuEOiVwu npx vitest run tests/api/onecPair.routes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Добавить `onecPairRouter` в `onec.ts`**

```typescript
export const onecPairRouter = Router();

// ПУБЛИЧНЫЙ: обменивает одноразовый код на scoped-токен подключения 1С.
onecPairRouter.post('/', async (req: Request, res: Response) => {
  const code = String(req.body?.code || '').trim();
  if (!code) return res.status(400).json({ error: 'code_invalid_or_expired' });
  const redeemed = await onecPairingRepo.redeem(code);
  if (!redeemed) return res.status(400).json({ error: 'code_invalid_or_expired' });
  const created = await onecConnectionRepo.create(
    redeemed.ownerUserId, redeemed.baseName || 'Подключение 1С',
  );
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.setHeader('Cache-Control', 'no-store');
  return res.status(201).json({
    data: {
      token: created.token,
      exchange_url: `${baseUrl}/api/onec/exchange`,
      header: 'X-1C-Token',
    },
  });
});
```
(`onecConnectionRepo` уже импортирован в `onec.ts`.)

- [ ] **Step 4: Примонтировать публично + rate-limit в `server.ts`**

Импорт: добавить `onecPairRouter` в существующий импорт из `./routes/onec`.
Монтирование: **до** `app.use('/api/onec', apiKeyAuth, onecUserRouter)`:
```typescript
  // Публичный обмен кода на токен — строгий rate-limit против перебора кодов.
  const onecPairLimiter = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false });
  app.use('/api/onec/pair', onecPairLimiter, onecPairRouter);
```
(`rateLimit` уже импортирован — см. `globalLimiter`/`loginLimiter`.)

- [ ] **Step 5: Прогнать — зелёный**

Run: та же команда, что в Step 2.
Expected: 2 passed. Затем `npx tsc --noEmit` → 0.

- [ ] **Step 6: Commit**

```bash
git add src/api/routes/onec.ts src/api/server.ts tests/api/onecPair.routes.test.ts
git commit -m "feat(onec): POST /api/onec/pair — exchange pairing code for scoped 1C token"
```

---

### Task 4: Клиентский виджет «Подключить 1С» в кабинете

**Files:**
- Modify: `public/js/operations.js` (добавить user-виджет генерации кода)
- Modify: `public/css/style.css` (стиль блока кода — по образцу `.onec-secret`)

**Interfaces:**
- Consumes: `POST /api/onec/pairing-code` (Task 2) через `App.apiJson`.

- [ ] **Step 1: Добавить метод генерации кода в `Operations`**

В `public/js/operations.js` добавить метод:
```javascript
  async generateOnecCode() {
    try {
      const { data } = await App.apiJson('/onec/pairing-code', { method: 'POST', body: { base_name: '' } });
      this.onecPairingCode = data.code;
      this.render();
      App.notify('Код создан — введите его в обработке 1С', 'success');
    } catch (e) {
      App.notify('Не удалось создать код: ' + e.message, 'error');
    }
  },
```

- [ ] **Step 2: Показать виджет в render() (для роли user)**

В методе рендера панели 1С (там, где сейчас `if (!this.data.permissions?.manage) return '<div class="empty-state">Подключения 1С настраивает администратор.</div>';`) заменить эту ветку на клиентский виджет:
```javascript
    if (!this.data.permissions?.manage) {
      const codeBlock = this.onecPairingCode
        ? `<div class="onec-pairing-code"><span>Код подключения (действует ~15 мин):</span><code>${App.esc(this.onecPairingCode)}</code></div>`
        : '';
      return `<article class="card operations-panel operations-panel--wide">
        <div class="operations-panel__head"><div><span class="operations-eyebrow">Подключение 1С</span><h3>Подключить свою базу</h3></div></div>
        <p>Нажмите «Получить код», затем в обработке 1С:УНФ вставьте его в поле «Код подключения» и нажмите «Подключить».</p>
        <button class="btn btn-primary btn-sm" onclick="Operations.generateOnecCode()">Получить код</button>
        ${codeBlock}
      </article>`;
    }
```

- [ ] **Step 3: Стиль блока кода**

В `public/css/style.css` добавить:
```css
.onec-pairing-code { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; }
.onec-pairing-code code { font-size: 22px; letter-spacing: 2px; font-weight: 700; background: var(--bg); padding: 8px 12px; border-radius: 8px; user-select: all; }
```

- [ ] **Step 4: Проверка синтаксиса JS**

Run: `node --check public/js/operations.js && echo OK`
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add public/js/operations.js public/css/style.css
git commit -m "feat(cabinet): self-service «Подключить 1С» pairing-code widget for role=user"
```

---

### Task 5: Обработка 1С — поле «Код подключения» + `ПодключитьПоКоду` (ручная сборка)

**Files:**
- Modify: `1c/КНД_ЗагрузкаНакладныхСканер/КНД_ЗагрузкаНакладныхСканер/Ext/ObjectModule.bsl`
- Modify: `1c/КНД_ЗагрузкаНакладныхСканер/КНД_ЗагрузкаНакладныхСканер/Forms/Форма/Ext/Form/Module.bsl`
- Modify: форма (`Forms/Форма/Ext/Form.xml`) — добавить реквизит `КодПодключения` + кнопку `ПодключитьПоКоду`

> ⚠️ 1С BSL автотестами не покрывается; проверка — вручную в 1С:УНФ после сборки `.epf`.

- [ ] **Step 1: Функция обмена кода на токен в `ObjectModule.bsl`**

Рядом с `СохранитьТокенПодключения` добавить (использует существующие `СоздатьHTTPСоединение`, `КОНСТ_АдресСервиса` и т.п.):
```bsl
Функция ПодключитьПоКоду(Код) Экспорт
    Соединение = СоздатьHTTPСоединение();
    Запрос = Новый HTTPЗапрос("/api/onec/pair");
    Запрос.Заголовки.Вставить("Content-Type", "application/json");
    Запрос.УстановитьТелоИзСтроки("{""code"": """ + СокрЛП(Код) + """}", КодировкаТекста.UTF8);
    Ответ = Соединение.ОтправитьДляОбработки(Запрос);
    Если Ответ.КодСостояния <> 201 Тогда
        Возврат "Код неверен или истёк. Сгенерируйте новый в кабинете ScanFlow.";
    КонецЕсли;
    Данные = ПрочитатьJSON(Ответ.ПолучитьТелоКакСтроку()); // → Структура data.token
    Токен = Данные["data"]["token"];
    СохранитьТокенПодключения(Токен);
    Возврат "";
КонецФункции
```
(Точные имена методов HTTP-соединения — как в соседних функциях `ObjectModule.bsl`; `ПрочитатьJSON` — обёртка, уже используемая в модуле для разбора ответов.)

- [ ] **Step 2: Реквизит + кнопка на форме**

- В `Form.xml` добавить строковый реквизит `КодПодключения` (по образцу `ТокенПодключения`) и команду/кнопку `ПодключитьПоКоду`.
- В `Forms/Форма/Ext/Form/Module.bsl` добавить обработчик:
```bsl
&НаКлиенте
Процедура ПодключитьПоКоду(Команда)
    Если ПустаяСтрока(КодПодключения) Тогда
        ПоказатьПредупреждение(, "Введите код подключения из кабинета ScanFlow.");
        Возврат;
    КонецЕсли;
    Ошибка = ПодключитьПоКодуНаСервере(КодПодключения);
    Если ПустаяСтрока(Ошибка) Тогда
        ПоказатьПредупреждение(, "База подключена к ScanFlow.");
    Иначе
        ПоказатьПредупреждение(, Ошибка);
    КонецЕсли;
КонецПроцедуры

&НаСервере
Функция ПодключитьПоКодуНаСервере(Код)
    Обработка = РеквизитФормыВЗначение("Объект"); // или ЭтотОбъект в модуле обработки
    Возврат Обработка.ПодключитьПоКоду(Код);
КонецФункции
```
(Оставить существующее поле «Токен подключения» + «Сохранить подключение» как ручной fallback.)

- [ ] **Step 3: Собрать `.epf` и проверить вручную**

- Собрать `.epf` в Конфигураторе/EDT из обновлённых исходников.
- В тестовой базе 1С:УНФ: в кабинете ScanFlow сгенерировать код → в обработке вставить в «Код подключения» → «Подключить» → «Проверить соединение» (существующая кнопка) → убедиться, что `/api/onec/exchange/status` отвечает.

- [ ] **Step 4: Commit исходников** (без `.epf` — он untracked)

```bash
git add "1c/КНД_ЗагрузкаНакладныхСканер/КНД_ЗагрузкаНакладныхСканер/Ext/ObjectModule.bsl" "1c/КНД_ЗагрузкаНакладныхСканер/КНД_ЗагрузкаНакладныхСканер/Forms/Форма/Ext/Form/Module.bsl" "1c/КНД_ЗагрузкаНакладныхСканер/КНД_ЗагрузкаНакладныхСканер/Forms/Форма/Ext/Form.xml"
git commit -m "feat(1c): «Код подключения» field + ПодключитьПоКоду (pairing-code onboarding)"
```

---

## Self-Review (пройден)

- **Покрытие спеки:** миграция+репо (Task 1), pairing-code роут user-доступ (Task 2), pair публичный+обмен+изоляция (Task 3), кабинет-виджет (Task 4), обработка (Task 5). Версия-эндпоинт — v2, вне плана (как в спеке).
- **Плейсхолдеры:** нет TBD; код приведён во всех шагах.
- **Согласованность типов:** `onecPairingRepo.create/redeem` совпадают между Task 1 (определение) и Task 2/3 (использование); `onecConnectionRepo.create(ownerUserId, name)` — по факту сигнатуры в репозитории.
