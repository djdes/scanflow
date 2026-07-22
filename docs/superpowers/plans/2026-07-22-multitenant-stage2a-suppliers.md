# Мультитенантность, этап 2A: пер-тенантный справочник поставщиков — план реализации

> **Статус: РЕАЛИЗОВАН** 2026-07-22, но **не выкачен**. Коммиты `fa5b05a`, `1188558`.
>
> **Ключевое отклонение от плана: никаких DROP.** Владелец продукта задал жёсткое
> ограничение — операции `DROP` на боевой базе недопустимы ни при каких условиях.
> Исходный Task 1 снимал первичный ключ (`ALTER TABLE suppliers DROP PRIMARY KEY`),
> поэтому переделан целиком.
>
> Перестроить `suppliers` без дропа нельзя в принципе: `PRIMARY KEY (inn)` физически
> допускает лишь одну строку на ИНН, и снять это можно только сняв ключ. Поэтому
> вместо перестройки заводится **новая таблица `supplier_cards`** с
> `UNIQUE (owner_user_id, inn)`, а существующий справочник копируется в неё под
> админской компанией. Старая `suppliers` остаётся нетронутой.
>
> Миграция 48 в итоге — только `CREATE TABLE IF NOT EXISTS` и `INSERT … SELECT …
> ON DUPLICATE KEY` (идемпотентно при повторном прогоне). Разделы 7.1 спеки и
> Task 1 ниже описывают **отвергнутый** вариант с суррогатным ключом на месте;
> читать их как историю решения, а не как инструкцию.
>
> Побочная выгода нового подхода: откат = вернуть код, данные в `suppliers` целы.
> Это устраняет единственный необратимый шаг всего плана.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сделать `suppliers` пер-тенантной таблицей, чтобы одна компания не видела и не могла править банковские реквизиты поставщиков другой.

**Architecture:** Аддитивная колонка `owner_user_id` с бэкфиллом на админскую компанию; уникальность переезжает с `inn` на `(owner_user_id, inn)`, первичный ключ — на суррогатный `id`. Все методы `supplierRepo` получают владельца **обязательным** параметром, поэтому забытый вызывающий становится ошибкой компиляции, а не тихой утечкой. HTTP-роуты берут владельца из `req.user.id`, фоновые пути — из `invoice.owner_user_id`.

**Tech Stack:** Node.js 25, TypeScript (strict), Express 5, MySQL 9 (`mysql2/promise`), vitest.

**Спека:** [`../specs/2026-07-22-multitenant-isolation-design.md`](../specs/2026-07-22-multitenant-isolation-design.md), раздел 7. Решение по ключу — Вариант A из [`../specs/2026-06-24-per-tenant-suppliers-design.md`](../specs/2026-06-24-per-tenant-suppliers-design.md).

## Место в этапе 2

Этап 2 разбит на четыре последовательных плана — 98 вызовов репозиториев в одном плане неисполнимы:

| План | Область | Состояние |
|---|---|---|
| **2A (этот)** | `suppliers` → `supplier_cards` — 17 вызовов | реализован и выкачен |
| [2C](2026-07-22-multitenant-stage2c-sber-connections.md) | `sber_tokens` → `sber_connections` — 10 вызовов; снимает заглушку в `src/services/autoSendSber.ts` | план написан, **выкатывать раньше 2B** |
| [2B](2026-07-22-multitenant-stage2b-catalog-and-mappings.md) | каталог 1С, сопоставления, статистика цен, кэш `NomenclatureMapper` — 71 вызов | план написан |
| 2D | Удаление `DATA_SCOPING_ENABLED` и сквозного доступа `admin` — 11 веток | план не написан, **должен быть последним** |

2D идёт последним сознательно: это выключатель, который начинает принуждать изоляцию. Пока справочники не разделены, включать его нечестно.

## Global Constraints

- Тесты **никогда** не коннектятся никуда, кроме `127.0.0.1`, и требуют `test` в `DB_NAME` (правило 17 CLAUDE.md). Гард в `tests/helpers/db.ts` не отключать.
- Локально `npm test` без переменной запускать **нельзя** (`.env` смотрит на боевую базу). Только `DB_NAME=scanflow_test npx vitest run <путь>`. Полный прогон `vitest run` без пути подвисает на наборах, ждущих БД, — запускать по каталогам.
- Изменения схемы — только новой миграцией, никогда правкой существующей. Каждая идемпотентна (`hasColumn`/`hasIndex`), потому что DDL в MySQL нетранзакционен (правило 16).
- Максимальная существующая версия миграции — **47**. Новая — **48**.
- Динамические имена колонок в `SET` — только из фиксированного allow-list `SUPPLIER_UPDATE_COLUMNS` (правило 18). Список не расширять и не заменять на `Object.entries(req.body)`.
- Перед выкаткой на прод — дамп БД: `mysqldump scanflow > data/backups/scanflow-$(date +%F).sql`.
- Все репозитории асинхронные: забытый `await` — «невидимый» баг (правило 15).

## File Structure

| Файл | Ответственность | Действие |
|---|---|---|
| `src/database/migrations.ts` | миграция 48 — владелец, бэкфилл, перенос ключей | дополнить |
| `src/database/repositories/supplierRepo.ts` | владелец обязателен во всех методах | изменить |
| `src/api/routes/suppliers.ts` | владелец из `req.user.id` (9 вызовов) | изменить |
| `src/api/routes/operations.ts` | владелец из `req.user.id` (2 вызова) | изменить |
| `src/api/routes/invoices.ts` | владелец из `invoice.owner_user_id` (3 вызова) | изменить |
| `src/services/enrichSupplier.ts` | владелец выводится из самой накладной | изменить |
| `src/services/resolveSupplierName.ts` | владелец пробрасывается параметром | изменить |
| `src/watcher/fileWatcher.ts`, `src/api/routes/dispatcher.ts` | прокинуть владельца в `resolveSupplierName` | изменить |
| `tests/database/suppliers.tenant.test.ts` | изоляция между двумя компаниями | **создать** |

---

### Task 1: Миграция 48 — владелец, бэкфилл и перенос ключей

**Files:**
- Modify: `src/database/migrations.ts` (добавить объект версии 48 в конец массива `MIGRATIONS`)

**Interfaces:**
- Produces: колонка `suppliers.owner_user_id INT NULL`, суррогатный `suppliers.id INT AUTO_INCREMENT PRIMARY KEY`, уникальный ключ `uq_suppliers_owner_inn (owner_user_id, inn)`. Task 2 опирается на все три.

- [ ] **Step 1: Добавить миграцию**

В `src/database/migrations.ts`, в конец массива `MIGRATIONS`:

```ts
  {
    version: 48,
    name: 'suppliers.owner_user_id — пер-тенантный справочник поставщиков',
    detect: async (exec) =>
      (await hasColumn(exec, 'suppliers', 'owner_user_id')) &&
      (await hasColumn(exec, 'suppliers', 'id')) &&
      (await hasIndex(exec, 'suppliers', 'uq_suppliers_owner_inn')),
    run: async (exec) => {
      // Порядок шагов важен: уникальный ключ ставится ДО снятия старого PK,
      // чтобы ни в один момент таблица не осталась без защиты от дублей по ИНН
      // (DDL в MySQL нетранзакционен — деплой может остановиться между шагами).

      // 1. Владелец. Nullable на время бэкфилла.
      if (!(await hasColumn(exec, 'suppliers', 'owner_user_id'))) {
        await exec.query(`ALTER TABLE suppliers ADD COLUMN owner_user_id INT NULL`);
      }

      // 2. Бэкфилл: весь существующий справочник принадлежит админской компании.
      //    Проставляем конкретный id, а не NULL: MySQL не схлопывает NULL в
      //    UNIQUE, поэтому легаси-строки с NULL потеряли бы защиту от дублей.
      await exec.query(
        `UPDATE suppliers
            SET owner_user_id = (SELECT MIN(id) FROM users WHERE role = 'admin')
          WHERE owner_user_id IS NULL
            AND EXISTS (SELECT 1 FROM users WHERE role = 'admin')`
      );

      // 3. Пер-тенантная уникальность: две компании держат свои карточки одного
      //    и того же ИНН независимо друг от друга.
      if (!(await hasIndex(exec, 'suppliers', 'uq_suppliers_owner_inn'))) {
        await exec.query(
          `ALTER TABLE suppliers ADD UNIQUE KEY uq_suppliers_owner_inn (owner_user_id, inn)`
        );
      }

      // 4. PK: inn → суррогатный id. Обе операции в одном ALTER, потому что
      //    AUTO_INCREMENT-колонка обязана быть ключом уже в момент добавления.
      if (!(await hasColumn(exec, 'suppliers', 'id'))) {
        await exec.query(
          `ALTER TABLE suppliers DROP PRIMARY KEY, ADD COLUMN id INT AUTO_INCREMENT PRIMARY KEY FIRST`
        );
      }
    },
  },
```

- [ ] **Step 2: Проверить типы**

Run: `npx tsc --noEmit`
Expected: без вывода.

- [ ] **Step 3: Прогнать миграцию на тестовой базе и убедиться в идемпотентности**

Run: `DB_NAME=scanflow_test npx vitest run tests/database`
Expected: PASS. Наборы в `tests/database` поднимают схему через `runMigrations`, поэтому повторный прогон = повторное применение. Если второй прогон падает — миграция не идемпотентна, чинить `detect`/гарды.

- [ ] **Step 4: Коммит**

```bash
git add src/database/migrations.ts
git commit -m "feat(db): migration 48 — per-tenant suppliers directory"
```

---

### Task 2: `supplierRepo` — владелец обязателен во всех методах

**Files:**
- Modify: `src/database/repositories/supplierRepo.ts`

**Interfaces:**
- Produces:
  - `findByInn(inn: string, ownerUserId: number): Promise<Supplier | null>`
  - `create(input: CreateSupplierInput, ownerUserId: number): Promise<Supplier>`
  - `upsert(input: CreateSupplierInput, ownerUserId: number): Promise<Supplier>`
  - `mergeEmpty(input: CreateSupplierInput, ownerUserId: number): Promise<{ supplier: Supplier; mode: 'created' | 'merged' | 'unchanged' }>`
  - `update(inn: string, ownerUserId: number, patch: Partial<CreateSupplierInput>): Promise<void>`
  - `touchLastUsed(inn: string, ownerUserId: number): Promise<void>`
  - `delete(inn: string, ownerUserId: number): Promise<void>`
  - `list(opts: ListOptions): Promise<Supplier[]>`, где `ListOptions` получает обязательное поле `ownerUserId: number`
  - Интерфейс `Supplier` получает поля `id: number` и `owner_user_id: number | null`

Владелец **обязателен и не имеет значения по умолчанию**: это единственное, что превращает забытый вызывающий из тихой утечки в ошибку компиляции.

- [ ] **Step 1: Расширить типы**

```ts
export interface Supplier {
  id: number;
  owner_user_id: number | null;
  inn: string;
  // …остальные поля без изменений
}

export interface ListOptions {
  ownerUserId: number;
  q?: string;
  verified?: number;
  limit: number;
  offset: number;
}
```

- [ ] **Step 2: Переписать методы**

```ts
export const supplierRepo = {
  async findByInn(inn: string, ownerUserId: number): Promise<Supplier | null> {
    const row = await getDb()
      .prepare('SELECT * FROM suppliers WHERE inn = ? AND owner_user_id = ?')
      .get<Supplier>(inn, ownerUserId);
    return row ?? null;
  },

  async create(input: CreateSupplierInput, ownerUserId: number): Promise<Supplier> {
    await getDb().prepare(`
      INSERT INTO suppliers (owner_user_id, inn, name, kpp, account, bank_bic, bank_corr_account, bank_name, address, verified, source, notes)
      VALUES (:owner_user_id, :inn, :name, :kpp, :account, :bank_bic, :bank_corr_account, :bank_name, :address, :verified, :source, :notes)
    `).run({
      owner_user_id: ownerUserId,
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
    return (await this.findByInn(input.inn, ownerUserId))!;
  },

  async upsert(input: CreateSupplierInput, ownerUserId: number): Promise<Supplier> {
    const existing = await this.findByInn(input.inn, ownerUserId);
    if (existing) {
      await this.update(input.inn, ownerUserId, input);
    } else {
      await this.create(input, ownerUserId);
    }
    return (await this.findByInn(input.inn, ownerUserId))!;
  },

  async mergeEmpty(
    input: CreateSupplierInput,
    ownerUserId: number,
  ): Promise<{ supplier: Supplier; mode: 'created' | 'merged' | 'unchanged' }> {
    const existing = await this.findByInn(input.inn, ownerUserId);
    if (!existing) {
      return { supplier: await this.create(input, ownerUserId), mode: 'created' };
    }
    const patch: Partial<CreateSupplierInput> = {};
    for (const [k, raw] of Object.entries(input)) {
      if (k === 'inn') continue;
      if (raw == null || raw === '') continue;
      const current = (existing as unknown as Record<string, unknown>)[k];
      if (current == null || current === '') {
        (patch as Record<string, unknown>)[k] = raw;
      }
    }
    if (Object.keys(patch).length === 0) {
      return { supplier: existing, mode: 'unchanged' };
    }
    await this.update(input.inn, ownerUserId, patch);
    return { supplier: (await this.findByInn(input.inn, ownerUserId))!, mode: 'merged' };
  },

  async update(inn: string, ownerUserId: number, patch: Partial<CreateSupplierInput>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'inn' || v === undefined) continue;
      if (!SUPPLIER_UPDATE_COLUMNS.has(k)) continue; // SQLi guard — см. allow-list выше
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push(`updated_at = NOW()`);
    vals.push(inn, ownerUserId);
    await getDb()
      .prepare(`UPDATE suppliers SET ${sets.join(', ')} WHERE inn = ? AND owner_user_id = ?`)
      .run(...vals);
  },

  async touchLastUsed(inn: string, ownerUserId: number): Promise<void> {
    await getDb()
      .prepare(`UPDATE suppliers SET last_used_at = NOW() WHERE inn = ? AND owner_user_id = ?`)
      .run(inn, ownerUserId);
  },

  async delete(inn: string, ownerUserId: number): Promise<void> {
    await getDb()
      .prepare('DELETE FROM suppliers WHERE inn = ? AND owner_user_id = ?')
      .run(inn, ownerUserId);
  },

  async list(opts: ListOptions): Promise<Supplier[]> {
    const wheres: string[] = ['owner_user_id = ?'];
    const params: unknown[] = [opts.ownerUserId];
    if (opts.q) {
      wheres.push('(name LIKE ? OR inn LIKE ?)');
      params.push(`%${opts.q}%`, `%${opts.q}%`);
    }
    if (opts.verified !== undefined) {
      wheres.push('verified = ?');
      params.push(opts.verified);
    }
    const lim = Math.max(1, Math.min(500, Math.trunc(Number(opts.limit)) || 100));
    const off = Math.max(0, Math.trunc(Number(opts.offset)) || 0);
    const sql = `
      SELECT * FROM suppliers
      WHERE ${wheres.join(' AND ')}
      ORDER BY (last_used_at IS NULL), last_used_at DESC, name
      LIMIT ${lim} OFFSET ${off}
    `;
    return getDb().prepare(sql).all<Supplier>(...params);
  },
};
```

- [ ] **Step 3: Получить список сломанных вызывающих**

Run: `npx tsc --noEmit`
Expected: FAIL — ошибки во всех файлах из таблицы File Structure. Это рабочий список для Task 3 и Task 4; выписать его перед тем, как чинить.

- [ ] **Step 4: НЕ коммитить**

Коммита здесь нет намеренно. Смена сигнатур ломает сборку, и отдельный красный коммит сделал бы `git bisect` и откат бесполезными на этом участке истории. Изменения репозитория остаются в рабочем дереве и уезжают одним зелёным коммитом в конце Task 4 вместе с вызывающими.

---

### Task 3: HTTP-роуты передают владельца из `req.user.id`

**Files:**
- Modify: `src/api/routes/suppliers.ts:78,83,92,95,108,114,115,119,221`
- Modify: `src/api/routes/operations.ts:85,96`

**Interfaces:**
- Consumes: сигнатуры из Task 2.

- [ ] **Step 1: Ввести локальный помощник в `suppliers.ts`**

Добавить рядом с импортами:

```ts
// Владелец справочника — всегда текущий пользователь. Значения по умолчанию нет:
// запрос без пользователя до сюда не доходит (роут под apiKeyAuth), а если
// дойдёт — пусть падает явно, а не читает чужие реквизиты.
function ownerOf(req: Request): number {
  const id = req.user?.id;
  if (id == null) throw new Error('supplier route reached without an authenticated user');
  return id;
}
```

- [ ] **Step 2: Пробросить владельца в девять вызовов**

```ts
// :78
const suppliers = await supplierRepo.list({ ownerUserId: ownerOf(req), q, verified, limit, offset });

// :83
const supplier = await supplierRepo.findByInn((req.params.inn as string), ownerOf(req));

// :92
if (await supplierRepo.findByInn(body.inn, ownerOf(req))) {

// :95 — второй аргумент после объекта input
const supplier = await supplierRepo.create({ /* …без изменений… */ }, ownerOf(req));

// :108
const existing = await supplierRepo.findByInn((req.params.inn as string), ownerOf(req));

// :114
await supplierRepo.update((req.params.inn as string), ownerOf(req), body);

// :115
return res.json({ supplier: await supplierRepo.findByInn((req.params.inn as string), ownerOf(req)) });

// :119
await supplierRepo.delete((req.params.inn as string), ownerOf(req));

// :221 — второй аргумент после объекта input
const result = await supplierRepo.mergeEmpty({ /* …без изменений… */ }, ownerOf(req));
```

- [ ] **Step 3: Починить `operations.ts`**

```ts
// :85
const supplier = await supplierRepo.findByInn(inn, req.user?.id ?? -1);

// :96
await supplierRepo.update(inn, req.user?.id ?? -1, {
```

`-1` здесь безопасен: такого владельца не существует, поэтому запрос вернёт пусто вместо чужой строки. Роут закрыт `requireAdmin`, так что реально `req.user` всегда есть.

- [ ] **Step 4: Проверить типы**

Run: `npx tsc --noEmit`
Expected: остаются только ошибки в `invoices.ts`, `enrichSupplier.ts`, `resolveSupplierName.ts` — их чинит Task 4.

- [ ] **Step 5: НЕ коммитить**

Сборка всё ещё красная (остались `invoices.ts` и два сервиса). Изменения копятся в рабочем дереве до конца Task 4.

---

### Task 4: Фоновые пути берут владельца из накладной

**Files:**
- Modify: `src/services/enrichSupplier.ts:22-28`
- Modify: `src/services/resolveSupplierName.ts:25-31`
- Modify: `src/api/routes/invoices.ts:1635,1645,1771`
- Modify: `src/watcher/fileWatcher.ts:212`, `src/api/routes/dispatcher.ts:43`

**Interfaces:**
- Produces: `resolveSupplierName(rawSupplier, inn, ownerUserId: number | null)` — третий параметр обязателен.
- `enrichInvoiceWithSupplier` сигнатуру **не меняет**: владелец выводится из самой накладной, поэтому её четыре вызывающих не трогаем.

- [ ] **Step 1: `enrichSupplier.ts` — владелец из накладной**

Добавить `owner_user_id` в `Pick<>` дженерика и использовать его:

```ts
export async function enrichInvoiceWithSupplier<T extends Pick<Invoice,
  /* …существующие поля… */ | 'owner_user_id'
>>(invoice: T): Promise<T> {
  if (!invoice.supplier_inn) return invoice;
  // Справочник пер-тенантный: подтягиваем карточку только владельца накладной.
  // Накладная без владельца (файл из inbox/) справочником не обогащается —
  // претендента на неё нет, а брать чужую карточку нельзя.
  if (invoice.owner_user_id == null) return invoice;
  const supplier = await supplierRepo.findByInn(invoice.supplier_inn, invoice.owner_user_id);
  if (!supplier || !supplier.verified) return invoice;
  // …остальное без изменений
```

- [ ] **Step 2: `resolveSupplierName.ts` — владелец параметром**

```ts
export async function resolveSupplierName(
  rawSupplier: string | null | undefined,
  inn: string | null | undefined,
  ownerUserId: number | null,
): Promise<string | undefined> {
  const innTrim = inn ? String(inn).trim() : '';
  if (innTrim && ownerUserId != null) {
    const dir = await supplierRepo.findByInn(innTrim, ownerUserId);
    // …остальное без изменений
```

- [ ] **Step 3: Прокинуть владельца в двух обёртках**

`src/watcher/fileWatcher.ts:212` и `src/api/routes/dispatcher.ts:43` — это методы-обёртки `resolveSupplier(rawSupplier, inn)`. Добавить им третий параметр `ownerUserId: number | null` и передать дальше:

```ts
    return resolveSupplierName(rawSupplier, inn, ownerUserId);
```

Затем компилятор укажет на вызовы этих обёрток — в каждом передать владельца обрабатываемой накладной (`invoice.owner_user_id`, либо `meta?.ownerUserId ?? null` там, где накладная ещё не создана).

- [ ] **Step 4: `invoices.ts` — три вызова в `POST /:id/send-sber`**

Переменная `invoice` в этом обработчике уже загружена выше.

```ts
// :1635
let supplier = invoice.owner_user_id != null
  ? await supplierRepo.findByInn(invoice.supplier_inn, invoice.owner_user_id)
  : null;

// :1645 — второй аргумент после объекта overrides
supplier = await supplierRepo.upsert({ /* …без изменений… */ }, invoice.owner_user_id as number);

// :1771
if (invoice.owner_user_id != null) {
  await supplierRepo.touchLastUsed(supplier.inn, invoice.owner_user_id);
}
```

Перед блоком с `upsert` добавить явную защиту, чтобы приведение типа на `:1645` было честным:

```ts
  if (invoice.owner_user_id == null) {
    return res.status(400).json({ error: 'У накладной не указан владелец — отправка в Сбербанк невозможна' });
  }
```

- [ ] **Step 5: Проверить типы**

Run: `npx tsc --noEmit`
Expected: без вывода. Красная сборка из Task 2 закрыта.

- [ ] **Step 6: Коммит — репозиторий и все вызывающие вместе**

Первый зелёный момент с начала Task 2, поэтому коммитим весь срез целиком.

```bash
git add src/database/repositories/supplierRepo.ts \
        src/api/routes/suppliers.ts src/api/routes/operations.ts \
        src/services/enrichSupplier.ts src/services/resolveSupplierName.ts \
        src/api/routes/invoices.ts src/watcher/fileWatcher.ts src/api/routes/dispatcher.ts
git commit -m "fix(suppliers): scope the supplier directory per company

Every supplierRepo method now takes a mandatory owner, so a forgotten call site
is a compile error instead of a silent cross-company read. HTTP routes pass
req.user.id; background paths derive the owner from the invoice."
```

---

### Task 5: Тест изоляции между компаниями

**Files:**
- Test: `tests/database/suppliers.tenant.test.ts` (создать)

**Interfaces:**
- Consumes: `supplierRepo` из Task 2, помощники из `tests/helpers/db.ts`.

- [ ] **Step 1: Написать тест**

Создать `tests/database/suppliers.tenant.test.ts`. Перед написанием открыть соседний набор в `tests/database/` и сверить, как там готовится база: если хелпер называется не `resetDb` или требует дополнительного вызова миграций — использовать принятый в проекте способ, а не изобретать свой.

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { supplierRepo } from '../../src/database/repositories/supplierRepo';
import { resetDb } from '../helpers/db';
import { getDb } from '../../src/database/db';

const INN = '7707083893';

async function makeUser(username: string, role: string): Promise<number> {
  const res = await getDb()
    .prepare(`INSERT INTO users (username, password_hash, api_key, role) VALUES (?, 'x', ?, ?)`)
    .run(username, `key-${username}`, role);
  return Number(res.lastInsertRowid);
}

describe('suppliers: изоляция между компаниями', () => {
  let companyA = 0;
  let companyB = 0;

  beforeEach(async () => {
    await resetDb();
    companyA = await makeUser('company-a', 'admin');
    companyB = await makeUser('company-b', 'user');
  });

  it('две компании держат свои карточки одного и того же ИНН независимо', async () => {
    await supplierRepo.create(
      { inn: INN, name: 'Поставщик глазами А', bank_bic: '044525225', account: '40702810000000000001' },
      companyA,
    );
    await supplierRepo.create(
      { inn: INN, name: 'Поставщик глазами Б', bank_bic: '044525225', account: '40702810000000000002' },
      companyB,
    );

    const a = await supplierRepo.findByInn(INN, companyA);
    const b = await supplierRepo.findByInn(INN, companyB);
    expect(a?.name).toBe('Поставщик глазами А');
    expect(b?.name).toBe('Поставщик глазами Б');
    expect(a?.account).not.toBe(b?.account);
  });

  it('компания Б не видит поставщика компании А', async () => {
    await supplierRepo.create({ inn: INN, name: 'Только у А', bank_bic: '044525225' }, companyA);

    expect(await supplierRepo.findByInn(INN, companyB)).toBeNull();
    const listB = await supplierRepo.list({ ownerUserId: companyB, limit: 100, offset: 0 });
    expect(listB).toHaveLength(0);
  });

  it('компания Б не может изменить или удалить поставщика компании А', async () => {
    await supplierRepo.create({ inn: INN, name: 'Только у А', bank_bic: '044525225' }, companyA);

    await supplierRepo.update(INN, companyB, { name: 'Взломано' });
    await supplierRepo.delete(INN, companyB);

    const stillThere = await supplierRepo.findByInn(INN, companyA);
    expect(stillThere?.name).toBe('Только у А');
  });

  it('роль admin не даёт доступа к справочнику другой компании', async () => {
    // companyA заведена как admin — сквозного доступа всё равно быть не должно.
    await supplierRepo.create({ inn: INN, name: 'Только у Б', bank_bic: '044525225' }, companyB);
    expect(await supplierRepo.findByInn(INN, companyA)).toBeNull();
  });
});
```

- [ ] **Step 2: Запустить тест**

Run: `DB_NAME=scanflow_test npx vitest run tests/database/suppliers.tenant.test.ts`
Expected: PASS, 4 теста. Если падает первый — проверить, что уникальный ключ действительно `(owner_user_id, inn)`, а не остался на одном `inn`.

- [ ] **Step 3: Коммит**

```bash
git add tests/database/suppliers.tenant.test.ts
git commit -m "test(suppliers): cover cross-company isolation of the directory"
```

---

### Task 6: Прогон, дамп и выкатка

**Files:** изменений кода нет.

- [ ] **Step 1: Прогнать затронутые области**

Run: `DB_NAME=scanflow_test npx vitest run tests/database tests/services tests/sber tests/api`
Expected: PASS. Ожидаемо всплывут наборы, которые сами вставляют строки в `suppliers` напрямую или зовут `supplierRepo` без владельца — починить их так же, как боевой код (передать владельца), а не ослаблением репозитория.

- [ ] **Step 2: Полная проверка типов**

Run: `npx tsc --noEmit`
Expected: без вывода.

- [ ] **Step 3: Дамп боевой базы перед выкаткой**

Миграция 48 перестраивает первичный ключ заполненной таблицы. Это единственный необратимый шаг плана.

Run на сервере: `mysqldump scanflow > data/backups/scanflow-$(date +%F).sql`
Expected: непустой файл; проверить `ls -lh`.

- [ ] **Step 4: Выкатка**

```bash
git push origin HEAD:main
```

- [ ] **Step 5: Проверка на проде**

Под вторым аккаунтом запросить справочник и убедиться, что он **пуст**, а не показывает 14 чужих поставщиков:

```bash
curl -s https://scanflow.ru/api/suppliers -H "X-API-Key: <ключ второй компании>"
```

Expected: `{"suppliers":[]}`. Под первой компанией — прежние 14 записей на месте.

---

## Что этот план сознательно НЕ делает

- Не трогает `onec_nomenclature`, `nomenclature_mappings`, `nomenclature_price_stats` и кэш маппера — план 2B. До него вторая компания продолжает видеть чужой каталог 1С.
- Не трогает `sber_tokens` — план 2C. Временное ограничение в `src/services/autoSendSber.ts` остаётся на месте.
- Не снимает `DATA_SCOPING_ENABLED` и сквозной доступ `admin` — план 2D, последним.
- Не переносит владельца в `mapping_supplier_usage`: она скоупится транзитивно через `mapping_id` и относится к плану 2B.
