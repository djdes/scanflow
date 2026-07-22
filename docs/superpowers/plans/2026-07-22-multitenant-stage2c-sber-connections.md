# Мультитенантность, этап 2C: подключение к Сбербанку на компанию — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать каждой компании собственное подключение к СберБизнес, чтобы платёж по накладной уходил с её счёта, а не со счёта первой компании.

**Architecture:** `sber_tokens` — одна строка на всю установку (`CHECK (id = 1)`). Снять это ограничение нельзя без `DROP`, поэтому заводится новая таблица `sber_connections` с `UNIQUE (owner_user_id)`, существующее подключение копируется в неё под админской компанией, старая таблица остаётся нетронутой. Все методы репозитория и `getValidAccessToken()` получают владельца обязательным параметром.

**Tech Stack:** Node.js 25, TypeScript (strict), Express 5, MySQL 9 (`mysql2/promise`), vitest.

**Спека:** [`../specs/2026-07-22-multitenant-isolation-design.md`](../specs/2026-07-22-multitenant-isolation-design.md), раздел 7. Предшественник — [`2026-07-22-multitenant-stage2a-suppliers.md`](2026-07-22-multitenant-stage2a-suppliers.md) (реализован, выкачен).

## Порядок относительно 2B

**2C выкатывать раньше 2B.** Он меньше, независим от каталога и закрывает единственную оставшуюся дыру, связанную с деньгами: пока подключение одно на установку, включённый `auto_send_sber` оплачивал бы накладные любой компании со счёта первой. Сейчас это удерживается временной заглушкой в `src/services/autoSendSber.ts`, которую этот план снимает.

## Global Constraints

- **`DROP` на боевой базе запрещён полностью.** Никаких `DROP TABLE`, `DROP PRIMARY KEY`, `DROP COLUMN`, `DROP INDEX`. Только `CREATE TABLE IF NOT EXISTS` и `INSERT … SELECT … ON DUPLICATE KEY`. `ALTER` существующих таблиц тоже не применять.
- **На компилятор не полагаться как на единственную сеть безопасности.** `tsconfig.json` содержит `"include": ["src/**/*"]` — тесты не типизируются. Смена сигнатуры не подсветит вызывающих в `tests/`; их ловит только полный прогон. Проверено на этапе 2A: два дефекта прошли `tsc` и упали в рантайме.
- Тесты — только `127.0.0.1` и `DB_NAME` с подстрокой `test` (правило 17). Гард в `tests/helpers/db.ts` не отключать. **Новую таблицу обязательно добавить в список TRUNCATE** в этом же файле, иначе строки протекут между тестами (наступали на 2A).
- Полный прогон: `DB_NAME=scanflow_test npx vitest run <каталоги>` по каталогам, `vitest run` без аргументов подвисает. Ожидаемая база — 475 тестов зелёных.
- Максимальная версия миграции на момент написания — **48**. Новая — **49** (если 2B выкатится раньше, взять следующий свободный номер).
- Секреты: `sber_tokens` хранит access/refresh токены. В логи, дампы и коммиты они попадать не должны — при отладке использовать `src/sber/redact.ts`.

## File Structure

| Файл | Ответственность | Действие |
|---|---|---|
| `src/database/migrations.ts` | миграция 49 — `sber_connections` + копирование | дополнить |
| `src/database/repositories/sberTokenRepo.ts` | владелец обязателен во всех методах | изменить |
| `src/sber/oauth.ts` | `getValidAccessToken(ownerUserId)` + пер-владельческий `inflightRefresh` | изменить |
| `src/api/routes/sber.ts` | владелец из `req.user.id` (7 вызовов) | изменить |
| `src/api/routes/invoices.ts` | владелец из `invoice.owner_user_id` (1 вызов) | изменить |
| `src/services/autoSendSber.ts` | снять временное ограничение, читать владельца подключения из таблицы | изменить |
| `tests/database/sberConnections.tenant.test.ts` | изоляция подключений | **создать** |
| `tests/helpers/db.ts` | добавить `sber_connections` в TRUNCATE | изменить |

---

### Task 1: Миграция 49 — `sber_connections`

**Files:**
- Modify: `src/database/migrations.ts` (в конец массива `MIGRATIONS`)

**Interfaces:**
- Produces: таблица `sber_connections` с `UNIQUE (owner_user_id)` и теми же колонками, что у `sber_tokens`, минус `CHECK (id = 1)`.

- [ ] **Step 1: Добавить миграцию**

```ts
  {
    version: 49,
    name: 'sber_connections — подключение к Сберу на компанию (без DROP)',
    // Строго аддитивно. sber_tokens имеет CHECK (id = 1), то есть физически
    // допускает одно подключение на всю установку; снять это можно только через
    // DROP, что запрещено. Поэтому новая таблица, а старая остаётся нетронутой.
    detect: async (exec) => hasTable(exec, 'sber_connections'),
    run: async (exec) => {
      await exec.query(`
        CREATE TABLE IF NOT EXISTS sber_connections (
          id                       INT AUTO_INCREMENT PRIMARY KEY,
          owner_user_id            INT NOT NULL,
          access_token             TEXT NOT NULL,
          refresh_token            TEXT NOT NULL,
          expires_at               DATETIME NOT NULL,
          account_number           VARCHAR(64) NULL,
          org_name                 VARCHAR(512) NULL,
          payer_inn                VARCHAR(32) NULL,
          payer_kpp                VARCHAR(32) NULL,
          payer_bank_bic           VARCHAR(32) NULL,
          payer_bank_corr_account  VARCHAR(64) NULL,
          created_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_sber_connections_owner (owner_user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      // Переносим единственное существующее подключение админской компании.
      // ON DUPLICATE KEY делает повторный прогон no-op: токены не перетираются,
      // если после копирования успел пройти refresh.
      if (await hasTable(exec, 'sber_tokens')) {
        await exec.query(`
          INSERT INTO sber_connections
            (owner_user_id, access_token, refresh_token, expires_at, account_number,
             org_name, payer_inn, payer_kpp, payer_bank_bic, payer_bank_corr_account,
             created_at, updated_at)
          SELECT (SELECT MIN(id) FROM users WHERE role = 'admin'),
                 t.access_token, t.refresh_token, t.expires_at, t.account_number,
                 t.org_name, t.payer_inn, t.payer_kpp, t.payer_bank_bic,
                 t.payer_bank_corr_account, t.created_at, t.updated_at
            FROM sber_tokens t
           WHERE EXISTS (SELECT 1 FROM users WHERE role = 'admin')
          ON DUPLICATE KEY UPDATE sber_connections.id = sber_connections.id
        `);
      }
    },
  },
```

- [ ] **Step 2: Добавить таблицу в очистку между тестами**

В `tests/helpers/db.ts`, в массив `tables` рядом с `'sber_tokens'`:

```ts
    'sber_tokens',
    'sber_connections',
```

- [ ] **Step 3: Проверить типы**

Run: `npx tsc --noEmit`
Expected: без вывода.

- [ ] **Step 4: Коммит**

```bash
git add src/database/migrations.ts tests/helpers/db.ts
git commit -m "feat(db): migration 49 — per-company sber_connections"
```

---

### Task 2: `sberTokenRepo` — владелец обязателен

**Files:**
- Modify: `src/database/repositories/sberTokenRepo.ts`

**Interfaces:**
- Produces:
  - `get(ownerUserId: number): Promise<SberToken | null>`
  - `upsert(input: UpsertSberTokenInput, ownerUserId: number): Promise<void>`
  - `updateTokens(input: { access_token: string; refresh_token: string; expires_at: string }, ownerUserId: number): Promise<void>`
  - `updatePayerDetails(input: {...}, ownerUserId: number): Promise<void>`
  - `clear(ownerUserId: number): Promise<void>`
  - Интерфейс `SberToken` получает поле `owner_user_id: number`

- [ ] **Step 1: Переписать методы на новую таблицу и владельца**

Все запросы переводятся с `sber_tokens` на `sber_connections`, условие `WHERE id = 1` заменяется на `WHERE owner_user_id = ?`. Вставка в `upsert` идёт через `INSERT … ON DUPLICATE KEY UPDATE` по уникальному ключу владельца:

```ts
  async get(ownerUserId: number): Promise<SberToken | null> {
    const row = await getDb()
      .prepare('SELECT * FROM sber_connections WHERE owner_user_id = ?')
      .get<SberToken>(ownerUserId);
    return row ?? null;
  },

  async clear(ownerUserId: number): Promise<void> {
    await getDb()
      .prepare('DELETE FROM sber_connections WHERE owner_user_id = ?')
      .run(ownerUserId);
  },
```

`updateTokens` и `updatePayerDetails` — тот же приём: добавить `AND owner_user_id = ?` в `WHERE` и параметр в конец списка значений.

**Не трогать** allow-list колонок в `updatePayerDetails`: имена колонок там интерполируются в SQL, и белый список — единственная защита от инъекции (правило 18). Владелец передаётся связанным параметром, а не через список.

- [ ] **Step 2: Получить список сломанных вызывающих**

Run: `npx tsc --noEmit`
Expected: FAIL — 10 ошибок в `src/api/routes/sber.ts` (7), `src/sber/oauth.ts` (2), `src/api/routes/invoices.ts` (1). Выписать список.

- [ ] **Step 3: НЕ коммитить**

Сборка красная; коммит будет один зелёный в конце Task 4. Отдельный красный коммит сделал бы `git bisect` бесполезным на этом участке.

---

### Task 3: `getValidAccessToken` и обновление токена — по владельцу

Самая тонкая часть плана: в `src/sber/oauth.ts` есть модульная переменная `inflightRefresh`, одна на процесс. Если её не разделить, параллельный запрос одной компании получит промис обновления **чужого** токена — тот же класс ошибки, что общий кэш маппера, только с банковскими токенами.

**Files:**
- Modify: `src/sber/oauth.ts:104-120`

**Interfaces:**
- Produces: `getValidAccessToken(ownerUserId: number): Promise<string>`

- [ ] **Step 1: Сделать `inflightRefresh` пер-владельческим**

Заменить одиночную переменную на карту:

```ts
// Обновление токена дедуплицируется НА КОМПАНИЮ. Общая переменная отдала бы
// одной компании промис обновления чужого подключения — то есть чужой
// access_token. Ключ карты — владелец подключения.
const inflightRefresh = new Map<number, Promise<string>>();
```

- [ ] **Step 2: Переписать функцию**

```ts
export async function getValidAccessToken(ownerUserId: number): Promise<string> {
  const row = await sberTokenRepo.get(ownerUserId);
  if (!row) throw new Error('Sber not connected');
  const buffer = 5 * 60 * 1000;
  const expiresAt = new Date(row.expires_at).getTime();
  if (expiresAt > Date.now() + buffer) return row.access_token;

  const existing = inflightRefresh.get(ownerUserId);
  if (existing) return existing;

  const p = (async () => {
    try {
      const fresh = await refreshAccessToken(row.refresh_token);
      const newExpiresAt = new Date(Date.now() + fresh.expiresIn * 1000).toISOString();
      await sberTokenRepo.updateTokens({
        access_token: fresh.accessToken,
        refresh_token: fresh.refreshToken,
        expires_at: newExpiresAt.slice(0, 19).replace('T', ' '),
      }, ownerUserId);
      return fresh.accessToken;
    } finally {
      inflightRefresh.delete(ownerUserId);
    }
  })();
  inflightRefresh.set(ownerUserId, p);
  return p;
}
```

Остальное тело (обработка ошибок обновления) сохранить как есть — менять только источник владельца и дедупликацию.

- [ ] **Step 3: НЕ коммитить** — сборка всё ещё красная.

---

### Task 4: Вызывающие передают владельца

**Files:**
- Modify: `src/api/routes/sber.ts:47,54,92,106,124,132,161`
- Modify: `src/api/routes/invoices.ts:1626`
- Modify: `src/services/autoSendSber.ts`

- [ ] **Step 1: `sber.ts` — владелец из запроса**

Все семь вызовов внутри HTTP-обработчиков. Добавить рядом с импортами тот же помощник, что применён в `suppliers.ts` на этапе 2A:

```ts
function ownerOf(req: Request): number {
  const id = req.user?.id;
  if (id == null) throw new Error('sber route reached without an authenticated user');
  return id;
}
```

и передать `ownerOf(req)` последним аргументом в каждый из семи вызовов (`upsert` ×2, `updatePayerDetails` ×2, `get` ×2, `clear` ×1).

Роуты подключения и записи закрыты `requireAdmin` (правило 20) — это ограничение **сохранить**, оно ортогонально владению: админ подключает Сбер своей компании, а не чужой.

- [ ] **Step 2: `invoices.ts` — владелец из накладной**

В обработчике `POST /:id/send-sber` переменная `supplierOwnerId` уже вычислена на этапе 2A и проверена на `null`. Использовать её же:

```ts
  const tokenRow = await sberTokenRepo.get(supplierOwnerId);
```

Ниже в том же обработчике `getValidAccessToken()` вызывается без аргументов — передать `supplierOwnerId`.

- [ ] **Step 3: `autoSendSber.ts` — снять временное ограничение**

Заглушка из этапа 1 больше не нужна: подключение теперь у каждой компании своё. Удалить функцию `sberConnectionOwnerId()` вместе с её комментарием и блок проверки `connectionOwnerId !== ownerId`, оставив проверку наличия владельца у накладной:

```ts
export async function autoSendSberForInvoice(invoiceId: number): Promise<void> {
  try {
    const invoice = await invoiceRepo.getById(invoiceId);
    const ownerId = invoice?.owner_user_id ?? null;
    if (ownerId == null) {
      logger.warn('Auto-send Sber: у накладной нет владельца, пропуск', { invoiceId });
      return;
    }
    // Подключение к Сберу теперь пер-тенантное: у компании без своего
    // подключения /send-sber вернёт «Sber not connected», и автоотправка
    // молча не сработает — отдельная проверка владельца больше не нужна.
    const row = await getDb()
      .prepare('SELECT api_key FROM users WHERE id = ?')
      .get<{ api_key: string }>(ownerId);
    // …остальное без изменений
```

Убрать ставший неиспользуемым импорт `userRepo`.

- [ ] **Step 4: Проверить типы**

Run: `npx tsc --noEmit`
Expected: без вывода. Сборка снова зелёная.

- [ ] **Step 5: Убедиться, что `firstUserId()` больше не используется вне бутстрапа**

Run: `grep -rn "userRepo.firstUserId()" --include=*.ts src/ | grep -v "userRepo.ts:"`
Expected: пусто. Это была последняя точка — заглушка в `autoSendSber.ts` снята в Step 3.

- [ ] **Step 6: Коммит — репозиторий, oauth и все вызывающие вместе**

```bash
git add src/database/repositories/sberTokenRepo.ts src/sber/oauth.ts \
        src/api/routes/sber.ts src/api/routes/invoices.ts src/services/autoSendSber.ts
git commit -m "feat(sber): per-company Sber connection

Every sberTokenRepo method and getValidAccessToken now take a mandatory owner.
The in-flight refresh dedupe is keyed by company — a shared promise would have
handed one company another company's access token.

Drops the stage-1 stopgap in autoSendSber: with per-company connections, a
company without its own connection simply gets 'Sber not connected'."
```

---

### Task 5: Тест изоляции подключений

**Files:**
- Test: `tests/database/sberConnections.tenant.test.ts` (создать)

- [ ] **Step 1: Написать тест**

Стиль — как в `tests/database/suppliers.tenant.test.ts` (гард `describe.runIf`, `resetDb`, `closeTestDb`, создание пользователей с обязательным `notify_events`).

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { sberTokenRepo } from '../../src/database/repositories/sberTokenRepo';

describe.runIf((process.env.DB_NAME || '').includes('test'))('sber: изоляция подключений', () => {
  let companyA = 0;
  let companyB = 0;

  async function mkUser(username: string, role: string): Promise<number> {
    const res = await getDb()
      .prepare(
        `INSERT INTO users (username, password_hash, api_key, role, notify_events)
         VALUES (?, 'x', ?, ?, '[]')`
      )
      .run(username, `k-${username}`, role);
    return Number(res.lastInsertRowid);
  }

  const conn = (n: string) => ({
    access_token: `at-${n}`,
    refresh_token: `rt-${n}`,
    expires_at: '2030-01-01 00:00:00',
    account_number: `4070281000000000000${n === 'A' ? '1' : '2'}`,
    org_name: `Компания ${n}`,
    payer_inn: '7707083893',
    payer_kpp: null,
    payer_bank_bic: '044525225',
    payer_bank_corr_account: '30101810400000000225',
  });

  beforeEach(async () => {
    await resetDb();
    companyA = await mkUser('company-a', 'admin');
    companyB = await mkUser('company-b', 'user');
  });
  afterAll(async () => { await closeTestDb(); });

  it('две компании держат независимые подключения', async () => {
    await sberTokenRepo.upsert(conn('A'), companyA);
    await sberTokenRepo.upsert(conn('B'), companyB);

    expect((await sberTokenRepo.get(companyA))?.access_token).toBe('at-A');
    expect((await sberTokenRepo.get(companyB))?.access_token).toBe('at-B');
    expect((await sberTokenRepo.get(companyA))?.account_number)
      .not.toBe((await sberTokenRepo.get(companyB))?.account_number);
  });

  it('компания без подключения не видит чужое', async () => {
    await sberTokenRepo.upsert(conn('A'), companyA);
    expect(await sberTokenRepo.get(companyB)).toBeNull();
  });

  it('отключение у одной компании не трогает другую', async () => {
    await sberTokenRepo.upsert(conn('A'), companyA);
    await sberTokenRepo.upsert(conn('B'), companyB);

    await sberTokenRepo.clear(companyB);

    expect(await sberTokenRepo.get(companyB)).toBeNull();
    expect((await sberTokenRepo.get(companyA))?.access_token).toBe('at-A');
  });

  it('обновление токенов не затрагивает чужое подключение', async () => {
    await sberTokenRepo.upsert(conn('A'), companyA);
    await sberTokenRepo.upsert(conn('B'), companyB);

    await sberTokenRepo.updateTokens(
      { access_token: 'at-A-new', refresh_token: 'rt-A-new', expires_at: '2031-01-01 00:00:00' },
      companyA,
    );

    expect((await sberTokenRepo.get(companyA))?.access_token).toBe('at-A-new');
    expect((await sberTokenRepo.get(companyB))?.access_token).toBe('at-B');
  });
});
```

- [ ] **Step 2: Запустить**

Run: `DB_NAME=scanflow_test npx vitest run tests/database/sberConnections.tenant.test.ts`
Expected: PASS, 4 теста. Если первый падает на дубле — проверить, что `sber_connections` добавлена в TRUNCATE (Task 1 Step 2).

- [ ] **Step 3: Коммит**

```bash
git add tests/database/sberConnections.tenant.test.ts
git commit -m "test(sber): cover per-company connection isolation"
```

---

### Task 6: Репетиция на реальных данных, полный прогон и выкатка

- [ ] **Step 1: Полный прогон**

Run: `DB_NAME=scanflow_test npx vitest run tests/api tests/watcher tests/mapping tests/notifications tests/automation tests/utils tests/parser tests/pricing tests/duplicate tests/database tests/services tests/sber tests/integration tests/ocr tests/seo tests/tablecv`
Expected: 0 упавших. База сравнения — 475 зелёных на момент завершения 2A плюс новые тесты.

Тесты, которые обращаются к `sber_tokens` напрямую (`tests/database/sberTokenRepo.test.ts`), после смены таблицы упадут. Чинить их так же, как боевой код — передачей владельца, а не ослаблением репозитория. Помнить: компилятор их не проверяет.

- [ ] **Step 2: Репетиция миграции на реальных данных**

Прогнать настоящий раннер миграций против локальной базы (`DB_NAME=scanflow`) временным скриптом и проверить:
- `sber_connections` создана;
- число строк в ней равно числу строк в `sber_tokens` (то есть 1, если подключение было);
- `owner_user_id` равен id админа;
- `access_token` и реквизиты плательщика совпали с исходными;
- повторный прогон не создаёт дубль и **не перетирает токены**.

После проверки временный скрипт удалить. Токены в вывод скрипта не печатать — сравнивать через `=` в SQL, а не выводом значений.

- [ ] **Step 3: Выкатка**

```bash
git push origin HEAD:main
```

- [ ] **Step 4: Проверка на проде**

Под второй компанией:

```bash
curl -s https://scanflow.ru/api/sber/status -H "X-API-Key: <ключ>"
```

Expected: `"connected": false` вместо нынешнего `true`. Под первой компанией статус должен остаться `connected: true` с прежними реквизитами плательщика — проверяет владелец аккаунта, ключа второй компании для этого недостаточно (в том и смысл изоляции).

---

## Что этот план сознательно НЕ делает

- Не трогает каталог 1С, сопоставления и кэш маппера — план 2B.
- Не снимает `DATA_SCOPING_ENABLED` и сквозной доступ `admin` — план 2D, последним.
- Не переносит `auto_send_sber` из платформенных настроек в настройки компании: по разделу 4.1 спеки тумблер глобален по замыслу. Безопасность обеспечивается тем, что у компании без своего подключения действие просто не срабатывает.
- Не удаляет старую `sber_tokens`. Она остаётся как страховка отката; вопрос её удаления решается отдельно и только после того, как новая схема отработает на проде.
