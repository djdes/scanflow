# Spec: GUID-based nomenclature mapping 1С ↔ scan.magday.ru

**Date:** 2026-04-05
**Status:** Approved, ready for implementation

## Problem

When an invoice is OCR'd and sent to 1C via `КНД_ЗагрузкаНакладныхСканер`, each
line item's product name is a free-text string from the supplier's paper invoice
(e.g. "Картофель"). 1C needs these to match real entries in
`Справочник.Номенклатура` (e.g. "Картофель сырой"). Today the BSL code tries:

1. Exact name match (`НайтиПоНаименованию`)
2. Fuzzy LIKE search
3. Create a new item if nothing found

This is unreliable: small wording differences between supplier and 1C names
(e.g. "Картофель" vs "Картофель сырой") cause either mis-matches (picking the
wrong товар) or duplicate creation (every variant spawns a new Номенклатура
entry, polluting the catalog).

The dashboard already has a `nomenclature_mappings` table and a "Номенклатура"
tab, but:
- Mappings are free-form strings (typos possible, renames in 1C break matches)
- There is no link to the actual 1C catalog — the user has to remember/retype
  the exact canonical 1C name
- No per-supplier filtering, so reviewing which items come from which supplier
  is impossible

## Goal

Connect dashboard mappings to the real 1C catalog via stable identifiers (GUIDs),
provide dashboard UI to review/edit mappings per-supplier, and teach the system
from each explicit user choice so subsequent invoices auto-resolve without
manual work.

## Non-goals

- Cross-mapping per-supplier rules (same scan name → different 1C items depending
  on supplier). If you say "Картофель = Картофель сырой" it's global.
- Syncing prices, stock, characteristics, groups hierarchy — only the flat list
  of Номенклатура items is needed for mapping.
- Handling `ХарактеристикиНоменклатуры` (variants). Out of scope v1.
- Deletion propagation from 1C. If an item is deleted in 1C, the
  `onec_nomenclature` row stays (with no hard-sync-delete flag).

## High-level architecture

```
┌─────────────┐  1. POST /api/nomenclature/sync  ┌────────────┐
│   1С:УНФ    │ ──── (entire catalog, batched) ─→│   scan.    │
│             │                                   │ magday.ru  │
│ Commands:   │  2. GET /pending (items w/guid)   │            │
│ - Выгрузить │ ← ────────────────────────────── │            │
│   номенкл.  │                                   │            │
│ - Загрузить │  3. POST /:id/confirm             │            │
│   накладные │ ─────────────────────────────── → │            │
└─────────────┘                                   └────────────┘
                                                        ↑
                                                  User reviews/
                                                  selects 1C item
                                                  via dropdown
```

## Data model

Three migrations on top of the current schema.

### Migration v6 — `onec_nomenclature` (1C catalog mirror)

```sql
CREATE TABLE onec_nomenclature (
  guid          TEXT PRIMARY KEY,          -- 1C Ссылка.УникальныйИдентификатор()
  code          TEXT,                      -- Справочник.Номенклатура.Код (e.g. "НФ-00001234")
  name          TEXT NOT NULL,             -- Наименование
  full_name     TEXT,                      -- НаименованиеПолное
  unit          TEXT,                      -- ЕдиницаИзмерения.Наименование ("кг", "шт")
  parent_guid   TEXT,                      -- Родитель.УникальныйИдентификатор() (nullable)
  is_folder     INTEGER NOT NULL DEFAULT 0,
  is_weighted   INTEGER NOT NULL DEFAULT 0,
  synced_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_onec_nomenclature_name ON onec_nomenclature(name COLLATE NOCASE);
CREATE INDEX idx_onec_nomenclature_parent ON onec_nomenclature(parent_guid);
```

This is the scan.magday.ru copy of the 1C catalog. The authoritative source is
1C itself; this copy is refreshed on demand via the sync endpoint.

### Migration v7 — extend `nomenclature_mappings` and `invoice_items`

```sql
ALTER TABLE nomenclature_mappings ADD COLUMN onec_guid TEXT;
ALTER TABLE nomenclature_mappings ADD COLUMN times_seen INTEGER NOT NULL DEFAULT 0;
ALTER TABLE nomenclature_mappings ADD COLUMN last_seen_supplier TEXT;
ALTER TABLE nomenclature_mappings ADD COLUMN last_seen_at TEXT;

ALTER TABLE invoice_items ADD COLUMN onec_guid TEXT;

CREATE INDEX idx_nomenclature_mappings_onec_guid ON nomenclature_mappings(onec_guid);
```

- `nomenclature_mappings.onec_guid` — link to the canonical 1C item for this
  scanned name. NULL means "user hasn't mapped this yet".
- `nomenclature_mappings.mapped_name_1c` — kept for backward compatibility as a
  display fallback. On read, the repository resolves the current 1C name via
  JOIN with `onec_nomenclature` by `onec_guid`. Re-syncing the catalog from 1C
  does NOT rewrite this field — it is only populated at user-mapping time.
  Consumers that need the up-to-date name should use the joined value; the
  stored string is shown only as fallback when `onec_guid` is NULL or the
  referenced `onec_nomenclature` row no longer exists.
- `times_seen` / `last_seen_*` — stats used by the supplier-scoped view.
- `invoice_items.onec_guid` — per-item mapping. Usually copied from the mapping
  but can be overridden for this one invoice.

### Migration v8 — `mapping_supplier_usage` (many-to-many stats)

```sql
CREATE TABLE mapping_supplier_usage (
  mapping_id    INTEGER NOT NULL,
  supplier      TEXT NOT NULL,      -- canonicalized supplier name
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
  times_seen    INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (mapping_id, supplier),
  FOREIGN KEY (mapping_id) REFERENCES nomenclature_mappings(id) ON DELETE CASCADE
);
CREATE INDEX idx_mapping_supplier_usage_supplier ON mapping_supplier_usage(supplier);
```

Populated as a side effect whenever a `NomenclatureMapper.map()` call succeeds
during invoice processing: for the (scan_name, supplier) pair the row is
upserted with `times_seen += 1` and `last_seen_at = now()`.

## Backend: API endpoints

### Nomenclature sync (from 1C)

```
POST /api/nomenclature/sync
Headers: X-API-Key: ...
Body:
  {
    "items": [
      {
        "guid": "7e9c1a8f-4d62-41ab-9e4f-8b5c2d3e1a01",
        "code": "НФ-00001234",
        "name": "Картофель сырой",
        "full_name": "Картофель сырой",
        "unit": "кг",
        "parent_guid": "abc-...",
        "is_folder": false,
        "is_weighted": true
      },
      ...
    ]
  }
Response:
  { "data": { "upserted": 1234, "total": 1234 } }
```

- Upsert by `guid` (INSERT OR REPLACE semantics with `synced_at = now()`).
- Called in batches of ~500 items from BSL.
- Transactional per batch.

### Nomenclature read endpoints (for dashboard)

```
GET /api/nomenclature?limit=N&search=Q&exclude_folders=true
  → { data: [ ... ], count, last_synced_at }

GET /api/nomenclature/stats
  → { data: { total, folders, items, last_synced_at } }

GET /api/nomenclature/suppliers
  → { data: [ { supplier, mappings_count, unmapped_count }, ... ] }
```

The dashboard loads the full `onec_nomenclature` list once (only non-folders)
and uses client-side Fuse.js for autocomplete. Expected size ≤ few thousand
entries — cheap to ship.

### Mapping management

```
GET /api/mappings?supplier=XYZ&unmapped=true
  → Existing endpoint, add supplier and unmapped query params.
    - supplier: only return mappings that have a row in mapping_supplier_usage
      with this supplier
    - unmapped=true: only mappings where onec_guid IS NULL

PUT /api/mappings/:id  (existing)
  → Existing, but extended: accepts onec_guid now. When onec_guid is set,
    mapped_name_1c is auto-populated from onec_nomenclature.name.
```

### Per-item mapping override (from invoice detail UI)

```
PUT /api/invoices/:invoice_id/items/:item_id/map
Headers: X-API-Key: ...
Body:
  { "onec_guid": "7e9c1a8f-..." }

Response:
  { "data": { "item_id, onec_guid, mapped_name } }
```

Server-side transaction:

1. Set `invoice_items.onec_guid = ?` and `invoice_items.mapped_name = <onec name>`
2. Upsert into `nomenclature_mappings` keyed on `scanned_name = original_name`:
   - Set/update `onec_guid`, `mapped_name_1c`
   - Increment `times_seen`
3. Upsert into `mapping_supplier_usage` for the invoice's supplier
4. Invalidate mapper cache

This is the "learning" step — once the user maps an item once, the next invoice
with the same scanned name auto-resolves via the cache.

## Backend: `NomenclatureMapper` update

New lookup order in `map(scannedName, supplier?)`:

1. **Learned mapping (exact scan name)**: lookup `nomenclature_mappings` by
   exact `scanned_name`. If found AND `onec_guid IS NOT NULL`, resolve via
   `onec_nomenclature`. Returns `{ onec_guid, mapped_name, confidence: 1.0,
   source: 'learned' }`.

2. **Fuzzy onec_nomenclature**: use Fuse.js index built from
   `onec_nomenclature` (non-folders) by `name` and `full_name`. Fuse
   `threshold: 0.3` (Fuse score of the best match must be ≤ 0.3, which the
   mapper converts to `confidence = 1 - score ≥ 0.7`). Returns
   `{ onec_guid, mapped_name, confidence, source: 'onec_fuzzy' }` if top match
   passes the threshold.

3. **No match**: `{ onec_guid: null, mapped_name: scannedName, confidence: 0,
   source: 'none' }`. Invoice item is saved without `onec_guid`, requires manual
   mapping.

Side effects on call (applied by caller, not mapper itself):
- On any non-none result → upsert `mapping_supplier_usage(mapping_id, supplier)`
  and bump mapping's `times_seen` and `last_seen_*`.

The current `fileWatcher.processFile` will call the mapper, then persist the
invoice_item with `onec_guid` (nullable) and `mapping_confidence`.

## Dashboard UI

### Invoice detail page — autocomplete per item

The existing read-only "Название (1С)" column turns into an interactive
autocomplete dropdown per row:

- **Data source**: pre-fetched `onec_nomenclature` on page load (one request).
- **Widget**: text input with autocomplete; typing filters via local Fuse.js.
- **Badge**: 🟢 if `mapping_confidence >= 0.95` (learned or exact), 🟡 if
  fuzzy 0.7-0.95, 🔴 if unmapped.
- **On select**: PUT the item with the selected GUID; refresh the row.
- **"Отправить в 1С" button gating**: disabled while any row is 🔴
  (`onec_guid IS NULL`). Shows tooltip: "Сопоставьте все товары перед отправкой".

### Nomenclature tab — two modes

A toggle at the top switches between:

**Mode A — "Все маппинги"** (default, current behavior kept)
- Search by text, table of all mappings
- Columns: `Скан имя | 1С товар | Раз встречено | Посл. поставщик | Ред.`
- Badge next to title: `Справочник из 1С: N позиций, обновлено ДД.ММ.ГГГГ`
- If `onec_nomenclature.count = 0`: CTA "Запустите команду 'Выгрузить номенклатуру' в обработке 1С"

**Mode B — "По поставщикам"** (new)
- Left column: list of suppliers from `mapping_supplier_usage`, each with count
  of mappings. Plus a special entry "🔴 Не сопоставлено (N)" showing mappings
  with `onec_guid IS NULL` (regardless of supplier).
- Right pane: table of mappings filtered by selected supplier (or unmapped
  filter). Same columns as Mode A.
- URL state: `#/mappings?mode=by-supplier&supplier=...` for shareable deep links.

### Adding a mapping manually

Existing "Добавить" flow, but the "1С товар" field becomes an autocomplete from
`onec_nomenclature`. The text input for the scanned name stays a free text
input. Submitting sets both `scanned_name` and `onec_guid` (and derives
`mapped_name_1c` server-side).

## 1C side: `КНД_ЗагрузкаНакладныхСканер` additions

### New command "Выгрузить номенклатуру на сайт"

Registered as a second `КНД_ЗагрузкаНакладныхСканер` command in
`СведенияОВнешнейОбработке()`. Logic:

```bsl
Запрос = Новый Запрос;
Запрос.Текст =
  "ВЫБРАТЬ
  |   Номенклатура.Ссылка КАК Ссылка,
  |   Номенклатура.Код,
  |   Номенклатура.Наименование,
  |   Номенклатура.НаименованиеПолное,
  |   Номенклатура.ЕдиницаИзмерения.Наименование КАК ЕдиницаИзмерения,
  |   Номенклатура.Родитель,
  |   Номенклатура.ЭтоГруппа,
  |   Номенклатура.Весовой
  |ИЗ
  |   Справочник.Номенклатура КАК Номенклатура
  |ГДЕ
  |   НЕ Номенклатура.ПометкаУдаления";

Выборка = Запрос.Выполнить().Выбрать();
Батч = Новый Массив;
Для Каждого Строка Цикл:
  Запись = Новый Структура;
  Запись.Вставить("guid", Строка(Строка.Ссылка.УникальныйИдентификатор()));
  Запись.Вставить("code", Строка.Код);
  ...
  Батч.Добавить(Запись);
  Если Батч.Количество() >= 500 Тогда:
    ОтправитьБатч(Батч);
    Батч.Очистить();
  КонецЕсли;
КонецЦикла;
Если Батч.Количество() > 0 Тогда:
  ОтправитьБатч(Батч);
```

Each batch is POSTed to `/api/nomenclature/sync`. Final report shown via
`ПоказатьПредупреждение`: "Выгружено 1234 позиций. Папок: 56. Товаров: 1178."

### Existing command "Загрузить накладные" — GUID-first resolution

In `СоздатьПриходнуюНакладную`, for each item:

```bsl
Номенклатура = Неопределено;

Если Товар.Свойство("onec_guid") И ЗначениеЗаполнено(Товар.onec_guid) Тогда
    // Fast path — server already knows the 1C item
    Попытка
        УИД = Новый УникальныйИдентификатор(Товар.onec_guid);
        СсылкаКандидат = Справочники.Номенклатура.ПолучитьСсылку(УИД);
        // ПолучитьСсылку always returns a reference; verify it resolves
        Если ЗначениеЗаполнено(СсылкаКандидат) И НЕ СсылкаКандидат.ЭтоГруппа Тогда
            Номенклатура = СсылкаКандидат;
        КонецЕсли;
    Исключение
        // Invalid GUID string — fall through to name lookup
    КонецПопытки;
КонецЕсли;

Если НЕ ЗначениеЗаполнено(Номенклатура) Тогда
    Номенклатура = НайтиИлиСоздатьНоменклатуру(ИмяНоменклатуры);
КонецЕсли;
```

If GUID resolution succeeds → no name search, no creation, guaranteed correct
товар. If GUID is stale/absent → existing fallback behavior.

## Data flow — end-to-end

### Setup (once)

1. User opens УНФ, runs command **"Выгрузить номенклатуру на сайт"**
2. BSL streams the catalog in batches of 500 to `POST /api/nomenclature/sync`
3. Report: "Выгружено 1234 позиций"
4. Dashboard shows badge: "Справочник из 1С: 1178 товаров"

### Each new invoice

1. Photo uploaded → OCR → invoice parsed
2. For each line item, `NomenclatureMapper.map(original_name, supplier)`:
   - 15/16: hit the learned mapping cache → `onec_guid` populated
   - 1/16: fuzzy fails, `onec_guid = NULL`
3. Invoice appears in dashboard as "Обработан"
4. User opens invoice detail → sees 15 green rows, 1 red row
5. Red row has autocomplete open → user picks the right 1C item → PUT
6. Server saves `invoice_items.onec_guid` and upserts the learned mapping
7. "Отправить в 1С" button becomes active → user clicks → invoice approved
8. 1C runs "Загрузить накладные" → GETs `/pending` → for each item gets
   `onec_guid` → `Справочники.Номенклатура.ПолучитьСсылку(guid)` → document
   created with correct items
9. 1C calls `/confirm` → status = sent_to_1c
10. Next invoice containing the same scan name automatically resolves

### Catalog update in 1C (e.g. new supplier item added)

1. User adds/renames item in 1C
2. User re-runs "Выгрузить номенклатуру на сайт"
3. Upsert keeps existing mappings intact (they're keyed by guid, which is
   stable), updates names for display

## Error handling

- **Invalid GUID in sync payload**: reject the row, continue with rest. Report
  errors in response.
- **Duplicate scan_name in upsert**: UPDATE existing row, bump `times_seen`.
- **GUID refers to deleted 1C item in invoice**: `ПолучитьСсылку` returns a
  broken ref; BSL catches and falls back to name lookup as before.
- **Sync is slow with large catalogs**: BSL batches at 500/request. The report
  endpoint remains non-blocking.
- **Empty `onec_nomenclature` on dashboard**: UI shows "Synchronize catalog
  first" CTA and blocks autocomplete with a helpful message.

## Testing

- Unit tests for `NomenclatureMapper.map()` covering:
  - Exact learned match
  - Fuzzy with score ≥ 0.7
  - Fuzzy below threshold → none
  - Empty catalog
- Integration test for `POST /api/nomenclature/sync`:
  - Empty catalog → upserted = items.length
  - Re-sync same data → no duplicates, rows updated
- Integration test for `PUT /invoices/:id/items/:id/map`:
  - New scan name → creates mapping, links item
  - Existing scan name → updates mapping, bumps times_seen
  - Supplier stats row inserted/updated
- Integration test for `/api/nomenclature/suppliers` returns correct counts
- Manual E2E: sync catalog from 1C dump fixtures (or mock), upload known
  invoice, verify auto-resolution on second invoice

## Observability

- Log `synced_at` on each sync with counts (info level)
- Log every mapper.map() call at debug level with source (learned/onec_fuzzy/none)
- Log every PUT item/map as user action

## Rollout

Backward compatible — existing invoices without `onec_guid` continue to work
via the name-based fallback in BSL. Users don't have to migrate existing data,
they just start mapping new invoices with the richer UI.

1. Deploy migrations + backend
2. Deploy BSL changes to УНФ (user rebuilds .epf)
3. User runs "Выгрузить номенклатуру" once
4. New invoices get auto-matched via GUIDs from that point on
