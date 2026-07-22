# Мультитенантность, этап 2B: каталог 1С, сопоставления и кэш маппера — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Разделить между компаниями каталог номенклатуры 1С, выученные сопоставления и статистику цен — включая кэш маппера в памяти процесса.

**Architecture:** Четыре таблицы получают пер-тенантные двойники (без `DROP`, как на этапе 2A): каталог, сопоставления, статистика цен и сопоставления по поставщику. Все методы четырёх репозиториев принимают владельца обязательным параметром. Отдельная и самая тонкая часть — `NomenclatureMapper`: он держит шесть полей общего индекса в единственном экземпляре на процесс, и без разделения по владельцу каталог одной компании продолжит отвечать на запросы другой в обход SQL.

**Tech Stack:** Node.js 25, TypeScript (strict), Express 5, MySQL 9 (`mysql2/promise`), Fuse.js, vitest.

**Спека:** [`../specs/2026-07-22-multitenant-isolation-design.md`](../specs/2026-07-22-multitenant-isolation-design.md), раздел 7.

## Место в этапе 2 и порядок

| План | Область | Состояние |
|---|---|---|
| 2A | `suppliers` → `supplier_cards` | реализован и выкачен |
| 2C | `sber_tokens` → `sber_connections` | план написан, **выкатывать раньше 2B** |
| **2B (этот)** | каталог, сопоставления, статистика, кэш маппера | к реализации |
| 2D | снятие `DATA_SCOPING_ENABLED` и admin-bypass | план не написан, **последним** |

2C идёт раньше, потому что он меньше и закрывает денежный риск. 2B — самый крупный: 71 вызов репозиториев против 17 на 2A.

## Global Constraints

- **`DROP` на боевой базе запрещён полностью.** Никаких `DROP TABLE`, `DROP PRIMARY KEY`, `DROP COLUMN`, `DROP INDEX`; `ALTER` существующих таблиц тоже не применять. Только `CREATE TABLE IF NOT EXISTS` и `INSERT … SELECT … ON DUPLICATE KEY`.
- **Соглашение об именах:** пер-тенантный двойник получает суффикс `_cards` (прецедент — `suppliers` → `supplier_cards`). Исключение делается там, где так читается плохо.
- **На компилятор не полагаться.** `tsconfig.json` содержит `"include": ["src/**/*"]` — **тесты не типизируются**. При 71 правке сигнатур это главный источник риска: `tsc` перечислит вызывающих в `src/`, но промолчит про `tests/`. На 2A так прошли два дефекта и упали в рантайме. Единственная сеть безопасности — полный прогон.
- Тесты — только `127.0.0.1` и `DB_NAME` с подстрокой `test` (правило 17). **Каждую новую таблицу добавлять в список TRUNCATE** в `tests/helpers/db.ts`.
- Полный прогон по каталогам (без аргументов `vitest run` подвисает). База сравнения — 475 зелёных после 2A.
- Правило 2 CLAUDE.md: `skipKeywords` и логика границ таблицы в парсере не трогать — этот план их не касается, но правки маппера проходят рядом.
- Версии миграций: следующая свободная после 2C. В плане обозначены как **50** (каталог) и **51** (сопоставления); при ином порядке взять актуальные.

## File Structure

| Файл | Ответственность | Действие |
|---|---|---|
| `src/database/migrations.ts` | миграции 50 и 51 — четыре новые таблицы + копирование | дополнить |
| `src/database/repositories/onecNomenclatureRepo.ts` | 6 методов принимают владельца | изменить |
| `src/database/repositories/mappingRepo.ts` | 11 методов принимают владельца | изменить |
| `src/pricing/priceStats.ts` | статистика цен считается в пределах компании | изменить |
| `src/mapping/nomenclatureMapper.ts` | кэш индексов — на компанию | изменить |
| `src/api/routes/nomenclature.ts`, `mappings.ts`, `onec.ts` | владелец из `req.user.id` / из подключения 1С | изменить |
| `src/api/routes/invoices.ts`, `dispatcher.ts` | владелец из накладной | изменить |
| `src/watcher/fileWatcher.ts`, `src/ocr/ocrManager.ts` | владелец из накладной | изменить |
| `tests/database/catalog.tenant.test.ts` | изоляция каталога и сопоставлений | **создать** |
| `tests/mapping/mapper.tenant.test.ts` | кэш маппера не протекает между компаниями | **создать** |
| `tests/helpers/db.ts` | новые таблицы в TRUNCATE | изменить |

Скрипты `src/scripts/test-*.ts` — вспомогательные, чинятся передачей владельца по тому же принципу; отдельными задачами не выносятся.

---

### Task 1: Миграция 50 — каталог и статистика цен

**Files:**
- Modify: `src/database/migrations.ts`

**Interfaces:**
- Produces: `onec_nomenclature_cards` с `UNIQUE (owner_user_id, guid)`; `nomenclature_price_stat_cards` с `UNIQUE (owner_user_id, onec_guid)`.

- [ ] **Step 1: Добавить миграцию**

```ts
  {
    version: 50,
    name: 'onec_nomenclature_cards + nomenclature_price_stat_cards — каталог 1С на компанию (без DROP)',
    // Строго аддитивно. У onec_nomenclature первичный ключ — guid, у
    // nomenclature_price_stats — onec_guid, то есть обе физически допускают одну
    // строку на ключ. Снять это можно только через DROP, что запрещено, поэтому
    // заводим двойники, а старые таблицы остаются нетронутыми.
    detect: async (exec) =>
      (await hasTable(exec, 'onec_nomenclature_cards')) &&
      (await hasTable(exec, 'nomenclature_price_stat_cards')),
    run: async (exec) => {
      await exec.query(`
        CREATE TABLE IF NOT EXISTS onec_nomenclature_cards (
          id            INT AUTO_INCREMENT PRIMARY KEY,
          owner_user_id INT NOT NULL,
          guid          VARCHAR(64) NOT NULL,
          code          VARCHAR(64) NULL,
          name          VARCHAR(512) NOT NULL,
          full_name     VARCHAR(1024) NULL,
          unit          VARCHAR(32) NULL,
          parent_guid   VARCHAR(64) NULL,
          is_folder     TINYINT(1) NOT NULL DEFAULT 0,
          is_weighted   TINYINT(1) NOT NULL DEFAULT 0,
          synced_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_onec_cards_owner_guid (owner_user_id, guid),
          INDEX idx_onec_cards_name (name),
          INDEX idx_onec_cards_parent (owner_user_id, parent_guid)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      await exec.query(`
        CREATE TABLE IF NOT EXISTS nomenclature_price_stat_cards (
          id            INT AUTO_INCREMENT PRIMARY KEY,
          owner_user_id INT NOT NULL,
          onec_guid     VARCHAR(64) NOT NULL,
          median_price  DOUBLE NOT NULL,
          price_unit    VARCHAR(32) NOT NULL,
          samples       INT NOT NULL,
          updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_price_stat_cards_owner_guid (owner_user_id, onec_guid)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      const adminExists = `EXISTS (SELECT 1 FROM users WHERE role = 'admin')`;
      const adminId = `(SELECT MIN(id) FROM users WHERE role = 'admin')`;

      if (await hasTable(exec, 'onec_nomenclature')) {
        await exec.query(`
          INSERT INTO onec_nomenclature_cards
            (owner_user_id, guid, code, name, full_name, unit, parent_guid, is_folder, is_weighted, synced_at)
          SELECT ${adminId}, n.guid, n.code, n.name, n.full_name, n.unit,
                 n.parent_guid, n.is_folder, n.is_weighted, n.synced_at
            FROM onec_nomenclature n
           WHERE ${adminExists}
          ON DUPLICATE KEY UPDATE onec_nomenclature_cards.id = onec_nomenclature_cards.id
        `);
      }

      if (await hasTable(exec, 'nomenclature_price_stats')) {
        await exec.query(`
          INSERT INTO nomenclature_price_stat_cards
            (owner_user_id, onec_guid, median_price, price_unit, samples, updated_at)
          SELECT ${adminId}, p.onec_guid, p.median_price, p.price_unit, p.samples, p.updated_at
            FROM nomenclature_price_stats p
           WHERE ${adminExists}
          ON DUPLICATE KEY UPDATE nomenclature_price_stat_cards.id = nomenclature_price_stat_cards.id
        `);
      }
    },
  },
```

- [ ] **Step 2: Добавить обе таблицы в TRUNCATE**

В `tests/helpers/db.ts`, рядом с существующими записями:

```ts
    'nomenclature_price_stats',
    'nomenclature_price_stat_cards',
    'onec_nomenclature',
    'onec_nomenclature_cards',
```

- [ ] **Step 3: Проверить и закоммитить**

Run: `npx tsc --noEmit` → без вывода.
Run: `DB_NAME=scanflow_test npx vitest run tests/database` → PASS.

```bash
git add src/database/migrations.ts tests/helpers/db.ts
git commit -m "feat(db): migration 50 — per-company 1C catalog and price stats"
```

---

### Task 2: Миграция 51 — сопоставления

**Files:**
- Modify: `src/database/migrations.ts`

**Interfaces:**
- Produces: `nomenclature_mapping_cards` с `UNIQUE (owner_user_id, scanned_name)`; `mapping_supplier_usage_cards`; `supplier_nomenclature_mapping_cards` с `UNIQUE (owner_user_id, supplier_key, scanned_hash)`.

Отдельная тонкость: `mapping_supplier_usage` имеет внешний ключ на `nomenclature_mappings(id)`. Новый двойник должен ссылаться на **новую** таблицу сопоставлений, иначе связь останется висеть на старой.

- [ ] **Step 1: Добавить миграцию**

```ts
  {
    version: 51,
    name: 'nomenclature_mapping_cards и спутники — сопоставления на компанию (без DROP)',
    // scanned_name в nomenclature_mappings уникален ГЛОБАЛЬНО, поэтому две
    // компании не могут выучить разные сопоставления для одного и того же
    // текста из скана. Снять уникальность можно только через DROP INDEX —
    // запрещено, поэтому двойник.
    detect: async (exec) =>
      (await hasTable(exec, 'nomenclature_mapping_cards')) &&
      (await hasTable(exec, 'mapping_supplier_usage_cards')) &&
      (await hasTable(exec, 'supplier_nomenclature_mapping_cards')),
    run: async (exec) => {
      await exec.query(`
        CREATE TABLE IF NOT EXISTS nomenclature_mapping_cards (
          id             INT AUTO_INCREMENT PRIMARY KEY,
          owner_user_id  INT NOT NULL,
          scanned_name   VARCHAR(512) NOT NULL,
          mapped_name_1c VARCHAR(512) NOT NULL,
          category       VARCHAR(255) NULL,
          default_unit   VARCHAR(64) NULL,
          approved       TINYINT(1) NOT NULL DEFAULT 0,
          onec_guid      VARCHAR(64) NULL,
          times_seen     INT NOT NULL DEFAULT 0,
          last_seen_supplier VARCHAR(512) NULL,
          last_seen_at   DATETIME NULL,
          pack_size      DOUBLE NULL,
          pack_unit      VARCHAR(32) NULL,
          created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_mapping_cards_owner_scanned (owner_user_id, scanned_name),
          INDEX idx_mapping_cards_guid (onec_guid)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      await exec.query(`
        CREATE TABLE IF NOT EXISTS mapping_supplier_usage_cards (
          mapping_card_id INT NOT NULL,
          supplier        VARCHAR(512) NOT NULL,
          first_seen_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_seen_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          times_seen      INT NOT NULL DEFAULT 1,
          PRIMARY KEY (mapping_card_id, supplier),
          INDEX idx_usage_cards_supplier (supplier),
          CONSTRAINT fk_usage_cards_mapping
            FOREIGN KEY (mapping_card_id) REFERENCES nomenclature_mapping_cards(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      await exec.query(`
        CREATE TABLE IF NOT EXISTS supplier_nomenclature_mapping_cards (
          id             INT AUTO_INCREMENT PRIMARY KEY,
          owner_user_id  INT NOT NULL,
          supplier_key   VARCHAR(64) NOT NULL,
          scanned_hash   CHAR(64) NOT NULL,
          scanned_name   VARCHAR(512) NOT NULL,
          mapped_name_1c VARCHAR(512) NOT NULL,
          onec_guid      VARCHAR(64) NOT NULL,
          times_seen     INT NOT NULL DEFAULT 1,
          created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uq_supplier_scan_cards (owner_user_id, supplier_key, scanned_hash),
          INDEX idx_supplier_mapping_cards_guid (onec_guid)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      const adminExists = `EXISTS (SELECT 1 FROM users WHERE role = 'admin')`;
      const adminId = `(SELECT MIN(id) FROM users WHERE role = 'admin')`;

      if (await hasTable(exec, 'nomenclature_mappings')) {
        await exec.query(`
          INSERT INTO nomenclature_mapping_cards
            (owner_user_id, scanned_name, mapped_name_1c, category, default_unit, approved,
             onec_guid, times_seen, last_seen_supplier, last_seen_at, pack_size, pack_unit, created_at)
          SELECT ${adminId}, m.scanned_name, m.mapped_name_1c, m.category, m.default_unit, m.approved,
                 m.onec_guid, m.times_seen, m.last_seen_supplier, m.last_seen_at,
                 m.pack_size, m.pack_unit, m.created_at
            FROM nomenclature_mappings m
           WHERE ${adminExists}
          ON DUPLICATE KEY UPDATE nomenclature_mapping_cards.id = nomenclature_mapping_cards.id
        `);
      }

      // Связь по scanned_name: id в новой таблице свои, поэтому джойним по
      // естественному ключу, а не по старому id.
      if (await hasTable(exec, 'mapping_supplier_usage')) {
        await exec.query(`
          INSERT INTO mapping_supplier_usage_cards
            (mapping_card_id, supplier, first_seen_at, last_seen_at, times_seen)
          SELECT c.id, u.supplier, u.first_seen_at, u.last_seen_at, u.times_seen
            FROM mapping_supplier_usage u
            JOIN nomenclature_mappings m ON m.id = u.mapping_id
            JOIN nomenclature_mapping_cards c
              ON c.scanned_name = m.scanned_name AND c.owner_user_id = ${adminId}
           WHERE ${adminExists}
          ON DUPLICATE KEY UPDATE mapping_supplier_usage_cards.times_seen = mapping_supplier_usage_cards.times_seen
        `);
      }

      if (await hasTable(exec, 'supplier_nomenclature_mappings')) {
        await exec.query(`
          INSERT INTO supplier_nomenclature_mapping_cards
            (owner_user_id, supplier_key, scanned_hash, scanned_name, mapped_name_1c,
             onec_guid, times_seen, created_at, updated_at)
          SELECT ${adminId}, s.supplier_key, s.scanned_hash, s.scanned_name, s.mapped_name_1c,
                 s.onec_guid, s.times_seen, s.created_at, s.updated_at
            FROM supplier_nomenclature_mappings s
           WHERE ${adminExists}
          ON DUPLICATE KEY UPDATE supplier_nomenclature_mapping_cards.id = supplier_nomenclature_mapping_cards.id
        `);
      }
    },
  },
```

- [ ] **Step 2: Добавить три таблицы в TRUNCATE**

В `tests/helpers/db.ts` — порядок важен, дочерние раньше родительских:

```ts
    'mapping_supplier_usage_cards',
    'supplier_nomenclature_mapping_cards',
    'nomenclature_mapping_cards',
```

- [ ] **Step 3: Проверить и закоммитить**

Run: `npx tsc --noEmit` → без вывода.
Run: `DB_NAME=scanflow_test npx vitest run tests/database` → PASS.

```bash
git add src/database/migrations.ts tests/helpers/db.ts
git commit -m "feat(db): migration 51 — per-company nomenclature mappings"
```

---

### Task 3: Репозитории принимают владельца

**Files:**
- Modify: `src/database/repositories/onecNomenclatureRepo.ts` (6 методов)
- Modify: `src/database/repositories/mappingRepo.ts` (11 методов)
- Modify: `src/pricing/priceStats.ts`

**Interfaces:**
- Produces (каталог): `bulkUpsert(items, ownerUserId)`, `replaceAll(items, ownerUserId)`, `clearAll(ownerUserId)`, `getByGuid(guid, ownerUserId)`, `listItems(opts)` где `opts` получает обязательное `ownerUserId`, `stats(ownerUserId)`.
- Produces (сопоставления): `create(data, ownerUserId)`, `getById(id, ownerUserId)`, `getByScannedName(scannedName, ownerUserId)`, `getAll(ownerUserId)`, `update(id, ownerUserId, data)`, `delete(id, ownerUserId)`, `upsert(data, ownerUserId)`, `getAllGrouped(ownerUserId)`, `getUnmapped(ownerUserId)`, `importBulk(items, ownerUserId)`, `removeOrphaned(ownerUserId)`.

Владелец **обязателен и без значения по умолчанию** — по той же причине, что на 2A.

- [ ] **Step 1: Переписать запросы на новые таблицы**

Механическая замена во всех запросах обоих репозиториев:
`onec_nomenclature` → `onec_nomenclature_cards`, `nomenclature_mappings` → `nomenclature_mapping_cards`, `mapping_supplier_usage` → `mapping_supplier_usage_cards` (колонка `mapping_id` → `mapping_card_id`), `nomenclature_price_stats` → `nomenclature_price_stat_cards`.

В каждый запрос добавляется `AND owner_user_id = ?` (для `INSERT` — колонка в список), параметр владельца ставится последним.

Особое внимание двум методам:

`replaceAll` сейчас удаляет весь каталог и вставляет заново. Удаление обязано быть **в пределах компании**:

```ts
  async replaceAll(items: OnecNomenclatureInput[], ownerUserId: number): Promise<{ deleted: number; upserted: number }> {
    // DELETE строго по владельцу: без этого выгрузка каталога одной компании
    // стирала бы каталог всех остальных.
    const del = await getDb()
      .prepare('DELETE FROM onec_nomenclature_cards WHERE owner_user_id = ?')
      .run(ownerUserId);
    const upserted = await this.bulkUpsert(items, ownerUserId);
    return { deleted: Number(del.changes ?? 0), upserted };
  },
```

`removeOrphaned` в `mappingRepo` чистит сопоставления, чей `onec_guid` отсутствует в каталоге. Сверять нужно с каталогом **той же** компании, иначе сопоставления вычистятся по чужому каталогу.

- [ ] **Step 2: `priceStats.ts` — считать в пределах компании**

Функции пересчёта статистики агрегируют цены по позициям накладных. Добавить владельца параметром и фильтровать исходную выборку по `invoices.owner_user_id`, а запись вести в `nomenclature_price_stat_cards` с этим же владельцем. `backfillAllStats()` должен пройти по каждой компании отдельно.

- [ ] **Step 3: Получить список сломанных вызывающих**

Run: `npx tsc --noEmit`
Expected: FAIL, порядка 71 ошибки в файлах: `src/api/routes/{nomenclature,mappings,onec,invoices,dispatcher}.ts`, `src/mapping/nomenclatureMapper.ts`, `src/ocr/ocrManager.ts`, `src/watcher/fileWatcher.ts`, `src/scripts/test-*.ts`. Сохранить вывод в файл — это рабочий список для Task 4.

- [ ] **Step 4: НЕ коммитить** — сборка красная до конца Task 5.

---

### Task 4: Кэш маппера — на компанию

Самая тонкая часть плана. `NomenclatureMapper` — один экземпляр на процесс с шестью полями индекса (`onecFuse`, `learnedTokens`, `onecTokenIndex`, `onecIdf`, `onecDf`, `onecExactIndex`). После правки SQL они всё ещё будут отдавать компании Б каталог компании А, потому что индекс строится один раз и живёт в памяти.

**Files:**
- Modify: `src/mapping/nomenclatureMapper.ts:217-223` (поля), `:303` (`invalidateCache`), `:321,348,609,617` (публичные методы)

**Interfaces:**
- Produces: `map(scannedName, ownerUserId, context?)`, `mapAll(names, ownerUserId)`, `getSuggestions(scannedName, ownerUserId, limit?)`, `mapSupplierOverride(…, ownerUserId)`, `invalidateCache(ownerUserId?)` — без аргумента сбрасывает всё (нужно тестам и полной пересинхронизации).

- [ ] **Step 1: Свернуть шесть полей в одну структуру индекса**

```ts
interface CatalogIndex {
  onecFuse: Fuse<OnecNomenclatureRow> | null;
  learnedTokens: LearnedToken[] | null;
  onecTokenIndex: OnecTokenDoc[] | null;
  onecIdf: ((token: string) => number) | null;
  onecDf: Map<string, number> | null;
  onecExactIndex: Map<string, OnecNomenclatureRow | null> | null;
}

// Индекс строится ПО КОМПАНИИ. Общий индекс на процесс отдавал бы одной
// компании каталог другой в обход SQL — фильтрация в запросах этого не ловит,
// потому что индекс живёт в памяти между запросами.
private indexes = new Map<number, CatalogIndex>();

private indexFor(ownerUserId: number): CatalogIndex {
  let ix = this.indexes.get(ownerUserId);
  if (!ix) {
    ix = { onecFuse: null, learnedTokens: null, onecTokenIndex: null,
           onecIdf: null, onecDf: null, onecExactIndex: null };
    this.indexes.set(ownerUserId, ix);
  }
  return ix;
}
```

- [ ] **Step 2: Переписать `invalidateCache`**

```ts
  invalidateCache(ownerUserId?: number): void {
    if (ownerUserId == null) {
      this.indexes.clear();
      logger.info('Nomenclature mapper cache invalidated (all tenants)');
      return;
    }
    this.indexes.delete(ownerUserId);
    logger.info('Nomenclature mapper cache invalidated', { ownerUserId });
  }
```

- [ ] **Step 3: Протянуть владельца через построение индекса и публичные методы**

Все приватные помощники, читающие каталог и сопоставления (`ensureLearnedIndex`, `refreshLearnedIndex` и построители Fuse/токенных индексов), получают `ownerUserId`, читают репозитории с этим владельцем и пишут в `this.indexFor(ownerUserId)` вместо полей экземпляра.

Публичные методы получают `ownerUserId` вторым параметром (после основного аргумента, перед необязательными).

- [ ] **Step 4: Ограничить рост карты**

Карта индексов растёт по числу компаний, а каталог 1С бывает крупным. Добавить простое ограничение: при превышении, скажем, 8 записей удалять наименее недавно использованную. Без этого память процесса растёт линейно по числу арендаторов — на текущих двух компаниях это незаметно, но заложить стоит сразу.

- [ ] **Step 5: НЕ коммитить** — сборка красная.

---

### Task 5: Вызывающие передают владельца

**Files:** по списку ошибок из Task 3 Step 3.

Источник владельца по файлам:

| Файл | Откуда владелец |
|---|---|
| `src/api/routes/nomenclature.ts`, `mappings.ts` | `req.user.id` (помощник `ownerOf(req)`, как в `suppliers.ts`) |
| `src/api/routes/onec.ts` | `req.onecConnection?.owner_user_id` — обмен с 1С идёт по подключению, а не по пользователю |
| `src/api/routes/invoices.ts` | `invoice.owner_user_id` |
| `src/api/routes/dispatcher.ts` | `row.owner_user_id` (из `validateDispatcherToken`, расширена на этапе 1) |
| `src/watcher/fileWatcher.ts` | `invoice.owner_user_id` обрабатываемой накладной |
| `src/ocr/ocrManager.ts` | параметром от вызывающего — своего контекста у него нет |
| `src/scripts/test-*.ts` | id админа явным аргументом скрипта |

- [ ] **Step 1: Пройти список сверху вниз**

Для каждой ошибки подставить владельца из таблицы выше. Там, где функция своего контекста не имеет (`ocrManager`, приватные помощники), добавить параметр и протянуть его от ближайшего места, где владелец известен.

Накладную без владельца (файл из `inbox/`) обрабатывать как на этапе 1: не падать, а пропускать обращение к пер-тенантным данным. Каталог для такой накладной недоступен, сопоставление вернёт «не найдено» — это корректно, претендента на неё нет.

- [ ] **Step 2: Проверить типы**

Run: `npx tsc --noEmit`
Expected: без вывода. Сборка зелёная.

- [ ] **Step 3: Коммит — репозитории, маппер и вызывающие вместе**

```bash
git add src/database/repositories/onecNomenclatureRepo.ts \
        src/database/repositories/mappingRepo.ts src/pricing/priceStats.ts \
        src/mapping/nomenclatureMapper.ts src/api/routes src/watcher src/ocr src/scripts
git commit -m "feat(catalog): per-company 1C catalog, mappings and mapper cache

Every catalog/mapping repo method takes a mandatory owner. The mapper's index is
keyed by company — a process-wide index served one company's catalog to another
regardless of SQL scoping, because it lives in memory between requests."
```

---

### Task 6: Тесты изоляции

**Files:**
- Test: `tests/database/catalog.tenant.test.ts` (создать)
- Test: `tests/mapping/mapper.tenant.test.ts` (создать)

- [ ] **Step 1: Изоляция данных**

`catalog.tenant.test.ts` — стиль как в `tests/database/suppliers.tenant.test.ts`. Покрыть:
- один и тот же `guid` живёт у двух компаний с разными названиями;
- компания Б не видит каталог компании А (`listItems`, `getByGuid`, `stats`);
- `replaceAll` компании Б **не стирает** каталог компании А — прямая проверка самого опасного места;
- один и тот же `scanned_name` сопоставлен по-разному у двух компаний;
- `removeOrphaned` компании Б не трогает сопоставления компании А.

- [ ] **Step 2: Изоляция кэша маппера**

`mapper.tenant.test.ts` — проверка того, чего SQL-фильтрация не ловит:

```ts
  it('прогретый каталог компании А не отвечает на запросы компании Б', async () => {
    // Заполняем каталог только компании А и прогреваем её индекс.
    await onecNomenclatureRepo.bulkUpsert([
      { guid: 'g-1', name: 'Молоко Домик в деревне 3.2%', unit: 'шт' },
    ], companyA);
    const hitA = await mapper.map('молоко домик', companyA);
    expect(hitA.onec_guid).toBe('g-1');

    // Тот же запрос от компании Б не должен получить позицию из чужого индекса.
    const hitB = await mapper.map('молоко домик', companyB);
    expect(hitB.onec_guid).toBeNull();
  });
```

Порядок вызовов важен: компания А **сначала**, чтобы индекс успел прогреться — иначе тест пройдёт даже на сломанном коде.

- [ ] **Step 3: Запустить и закоммитить**

Run: `DB_NAME=scanflow_test npx vitest run tests/database/catalog.tenant.test.ts tests/mapping/mapper.tenant.test.ts`
Expected: PASS.

```bash
git add tests/database/catalog.tenant.test.ts tests/mapping/mapper.tenant.test.ts
git commit -m "test(catalog): cover catalog, mapping and mapper-cache isolation"
```

---

### Task 7: Полный прогон, репетиция и выкатка

- [ ] **Step 1: Полный прогон по всем каталогам**

Run: `DB_NAME=scanflow_test npx vitest run tests/api tests/watcher tests/mapping tests/notifications tests/automation tests/utils tests/parser tests/pricing tests/duplicate tests/database tests/services tests/sber tests/integration tests/ocr tests/seo tests/tablecv`
Expected: 0 упавших.

Здесь ожидается **много** падений в существующих наборах: `tests/mapping/*`, `tests/pricing/*` и часть `tests/api/*` обращаются к каталогу и сопоставлениям напрямую. Компилятор их не проверял, поэтому это первая встреча с ними. Чинить передачей владельца, а не ослаблением репозиториев.

- [ ] **Step 2: Репетиция миграций на реальных данных**

Прогнать настоящий раннер миграций против локальной базы (`DB_NAME=scanflow`) временным скриптом и проверить для каждой из четырёх таблиц:
- число строк в двойнике равно числу строк в исходной;
- `owner_user_id` у всех строк равен id админа;
- выборочная сверка полей (для каталога — `guid`+`name`+`unit`, для сопоставлений — `scanned_name`+`onec_guid`);
- связь `mapping_supplier_usage_cards` → `nomenclature_mapping_cards` не потеряла строк при джойне по `scanned_name`;
- повторный прогон не создаёт дублей.

После проверки временный скрипт удалить.

- [ ] **Step 3: Выкатка**

```bash
git push origin HEAD:main
```

- [ ] **Step 4: Проверка на проде**

Под второй компанией:

```bash
curl -s "https://scanflow.ru/api/nomenclature?limit=1" -H "X-API-Key: <ключ>"
```

Expected: пустой каталог вместо чужих позиций. Под первой компанией каталог и сопоставления должны остаться в прежнем объёме — проверяет владелец аккаунта.

Дополнительно: отсканировать накладную под второй компанией и убедиться, что позиции **не** сопоставились с чужим каталогом (все пойдут как новые). Это и есть желаемое поведение — своей номенклатуры она ещё не выгружала.

---

## Что этот план сознательно НЕ делает

- Не снимает `DATA_SCOPING_ENABLED` и сквозной доступ роли `admin` — план 2D, последним.
- Не удаляет старые таблицы. Они остаются страховкой отката; вопрос удаления решается отдельно и только после того, как новая схема отработает на проде.
- Не переносит `llm_mapper_enabled` и модель Claude из платформенных настроек: по разделу 4.1 спеки они глобальны по замыслу.
- Не занимается переносом каталога между компаниями и общим «базовым» справочником — новая компания начинает с пустого каталога и выгружает свой из своей 1С.
