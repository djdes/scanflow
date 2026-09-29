# Пакет v2 (единицы, сопоставление, самообучение) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** реализовать пункты 1–4 и 7–20 из спеки `docs/superpowers/specs/2026-09-29-units-mapping-learning-v2-design.md` так, чтобы количество/единицы и сопоставление в 1С стали верными, правила не терялись, система училась на правках, а номер/сумма/НДС всегда были восстановимы.

**Architecture:** чистые модули (`unitConverter`, `nameKey`) + сервисы с доступом к БД (`lineConversion`, `mappingV2`, `learning/*`); все пути конвейера зовут одну функцию пересчёта; поведение переключается флагами `analyzer_config.engine_flags` (off = старый код). Три релиза, каждый деплоится отдельно.

**Tech Stack:** Node 20 (прод) / 25 (локально), TypeScript strict, Express 5, mysql2 → **MariaDB 10.11 на проде**, MySQL 9.6 локально; vitest; vanilla JS фронт; 1С BSL (внешняя обработка).

---

## Общие правила для всех задач

- Ветка интеграции: `feat/v2-units-mapping-learning` от `main` (3774b92). Параллельные агенты — в своих worktree от неё, мёрж обратно.
- Номера миграций **зафиксированы** (не менять!): 62 `engine_flags`, 63 `invoice_snapshots`, 64 `edit_log`, 65 поля сопоставлений, 66 `ocr_correction_cards.item_key/active`, 67 `invoice_items raw/conv`, 68 `item_unit_rules`, 69 `mapping_rejections`, 70 `rule_proposals`, 71 эталоны, 72 `new_item_requests`.
- SQL переносимый MariaDB/MySQL: только `hasColumn/hasTable/hasIndex`-guard, `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`, JSON хранить в `MEDIUMTEXT`, без DEFAULT у TEXT, без именованных CHECK.
- Проверка каждой задачи: `npx tsc --noEmit` + `npx vitest run <новые/затронутые DB-free тесты>`. `npm test` целиком НЕ запускать (правило 17 CLAUDE.md).
- Локальный стенд: сервер `npx ts-node --transpile-only src/index.ts` на `http://localhost:8899` (127.0.0.1:8899 перехвачен portproxy). Для прогонов на реальных данных — прод-дамп разворачивается в `scanflow_test` (оригинал схемы сохранён), сервер запускается с `DB_NAME=scanflow_test`; после — схема возвращается.
- Деньги: пересчёт не меняет `invoice_items.total` и шапку накладной. Каждый новый путь покрыт тестом-инвариантом.

## Зафиксированные интерфейсы

```ts
// src/config/engineFlags.ts
export type EngineFlag = 'units_v2' | 'price_guard' | 'mapping_v2' | 'ocr_memory' | 'batch_notify' | 'learning';
export const ENGINE_FLAG_DEFAULTS: Record<EngineFlag, boolean>; // все true
export async function getEngineFlags(): Promise<Record<EngineFlag, boolean>>; // кэш 30 с
export async function isEngineOn(flag: EngineFlag): Promise<boolean>;
export function invalidateEngineFlags(): void;

// src/mapping/unitConverter.ts (чистый)
export type UnitClass = 'count' | 'mass' | 'volume';
export interface CanonUnit { unit: string; cls: UnitClass; base: 'шт' | 'кг' | 'л'; toBase: number }
export function canonUnit(raw: string | null | undefined): CanonUnit | null;
export interface Measure { value: number; unit: 'кг' | 'г' | 'л' | 'мл'; kind: 'nominal' | 'net' | 'drained' }
export interface PackInfo {
  measures: Measure[];                                   // точные меры в названии
  ranges: Array<{ low: number; high: number; unit: 'кг' | 'г' | 'л' | 'мл' }>;
  perPack: number | null;                                // «шт в упаковке»: 240г×24→24, 1/12→12, 100шт/упак→100, (х50/1000)→50
  perCase: number | null;                                // (х50/1000)→1000, *100/2500→2500
}
export function parsePack(name: string): PackInfo;
export interface RawLine { quantity: number | null; unit: string | null; price: number | null; total: number | null }
export type ConvSource = 'same' | 'scale' | 'rule' | 'name' | 'name_count' | 'price_fit' | 'legacy' | 'manual' | 'none';
export type QtyFlag = 'price_outlier' | 'unit_mismatch' | 'needs_weight';
export interface ConvertInput {
  raw: RawLine; name: string; onecUnit: string | null; onecName?: string | null;
  rule?: { factor: number; targetUnit: string; source: string } | null;
  legacyPack?: { size: number; unit: string } | null;
  llmPackHint?: number | null;                           // Claude: сколько учётных единиц в строке-единице
  medianPrice?: number | null;                           // медиана цены за единицу 1С
}
export interface ConvertResult {
  quantity: number | null; unit: string | null; price: number | null; total: number | null;
  factor: number; source: ConvSource; note: string | null; flag: QtyFlag | null; flagNote: string | null;
}
export function convertLine(input: ConvertInput): ConvertResult;

// src/services/lineConversion.ts
export interface ItemConversionFields {
  quantity: number | null; unit: string | null; price: number | null; total: number | null;
  raw_quantity: number | null; raw_unit: string | null; raw_price: number | null; raw_total: number | null;
  conv_factor: number | null; conv_note: string | null; conv_source: string | null;
  qty_flag: string | null; qty_flag_note: string | null;
}
export async function convertInvoiceLine(args: {
  ownerUserId: number | null; supplierKey: string | null; name: string; raw: RawLine;
  onecGuid: string | null; onecName?: string | null;
  mapping?: { mapping_id: number | null; pack_size: number | null; pack_unit: string | null } | null;
  llmPackHint?: number | null;
}): Promise<ItemConversionFields>;

// src/mapping/nameKey.ts (чистый)
export function itemNameKey(name: string): string;
export interface ItemAttrs { volumesMl: number[]; dims: string[]; sizes: string[]; fats: number[]; calibers: string[]; codes: string[] }
export function extractAttrs(name: string): ItemAttrs;
export function attrsConflict(a: ItemAttrs, b: ItemAttrs): string | null; // null = совместимы, иначе причина

// src/database/repositories/editLogRepo.ts
export async function logEdit(e: {
  ownerUserId: number | null; userId: number | null; invoiceId?: number | null; itemId?: number | null;
  entity: 'invoice' | 'item' | 'mapping' | 'supplier' | 'rule' | 'system';
  field: string; oldValue: unknown; newValue: unknown; context?: Record<string, unknown>;
}): Promise<void>; // никогда не бросает
```

---

## Релиз 1 — страховка и остановка порчи данных

### Task 1: Флаги движков (миграция 62)
**Files:** Create `src/config/engineFlags.ts`, `tests/config/engineFlags.test.ts`; Modify `src/database/migrations.ts`, `src/database/repositories/invoiceRepo.ts` (getAnalyzerConfig/тип), `src/api/routes/settings.ts`, `public/js/settings.js`, `public/app.html`.
- [ ] Тест: `parseEngineFlags(null)` → все true; `parseEngineFlags('{"units_v2":false}')` → units_v2=false, остальные true; мусор → дефолты.
- [ ] Миграция 62: `analyzer_config.engine_flags MEDIUMTEXT NULL`.
- [ ] `GET /api/settings/engine-flags` (любой пользователь — только чтение), `PUT /api/settings/engine-flags` (`requireAdmin`), инвалидация кэша.
- [ ] UI: «Настройки → Движки v2» — 6 переключателей с пояснением «выключено = прежнее поведение».
- [ ] tsc + тест; коммит `feat(v2): флаги движков`.

### Task 2: Снимки шапки/строк и откат (миграция 63)
**Files:** Create `src/database/repositories/snapshotRepo.ts`, `tests/services/snapshot.test.ts`; Modify migrations, `fileWatcher.ts` (запись `recognized` перед пересчётом в processFile/reprocess/multi-page), `dispatcher.ts` (то же), `src/api/routes/invoices.ts` (`POST /:id/restore-snapshot`), `src/api/routes/debug.ts` (`POST /restore-headers`, admin), `public/js/invoices.js` (кнопки во вкладке «История»).
- [ ] Таблица `invoice_snapshots(id, invoice_id, kind VARCHAR(16), invoice_number, invoice_date, total_sum DOUBLE, vat_sum DOUBLE, supplier, supplier_inn, items_json MEDIUMTEXT, created_at)` + индекс `(invoice_id, kind, id)`; бэкфилл `baseline` для всех накладных (строки — JSON текущих items).
- [ ] Чистая функция `headerRestorePatch(current, snapshot, scope)` + тест: возвращает только отличающиеся поля из {invoice_number, invoice_date, total_sum, vat_sum}.
- [ ] Восстановление пишет в `edit_log` (после Task 4 — до этого просто логгер).
- [ ] tsc + тест; коммит.

### Task 3: Ежедневный бэкап БД
**Files:** Create `src/utils/dbDump.ts`; Modify `src/utils/backup.ts` (реальная реализация `backupDatabase()`), планировщик в `src/index.ts`.
- [ ] Логический дамп как в `scratchpad/dump.js` (START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY; SHOW CREATE TABLE; INSERT батчами по 500; gzip) → `data/backups/scanflow-YYYY-MM-DD.sql.gz`, ротация 14 файлов; ошибки — в лог, не падать.
- [ ] Коммит.

### Task 4: Журнал правок (миграция 64)
**Files:** Create `src/database/repositories/editLogRepo.ts`, `tests/database/editLog.test.ts` (сериализация значений, обрезка до 2000 символов); Modify migrations, `invoices.ts` (PATCH /:id, PATCH items, PUT map, custom name, send-sber привязка, restore), `GET /:id/edits`, `public/js/invoices.js` (история правок во вкладке «История»).
- [ ] `edit_log(id BIGINT PK AI, owner_user_id, user_id, invoice_id, item_id, entity VARCHAR(16), field VARCHAR(48), old_value TEXT, new_value TEXT, context MEDIUMTEXT, created_at)` + индексы `(invoice_id, id)`, `(owner_user_id, created_at)`.
- [ ] Коммит.

### Task 5: Выгрузка каталога не удаляет правила (п.7) (миграция 65)
> Миграция 65 создаётся здесь целиком (включая `name_key`/`source`/`confirmed_*` из Task 13), поэтому **чистый модуль `src/mapping/nameKey.ts` из Task 13 делается до Task 5** (он без БД). Остальная часть Task 13 — в релизе 2.

**Files:** Modify `src/api/routes/onec.ts:266-280`, `src/api/routes/nomenclature.ts:59-63,112`, `src/database/repositories/mappingRepo.ts` (`markOrphaned` вместо `removeOrphaned` в синках, `removeOrphaned` остаётся для ручной очистки), `src/mapping/nomenclatureMapper.ts` (пропуск `orphaned_at IS NOT NULL` уже есть через «dead GUID falls through» — проверить), migrations 65 (`orphaned_at DATETIME NULL` + остальные поля сопоставлений, см. Task 13).
- [ ] Тест (DB-free, мок репозиториев): sync-роут не вызывает `removeOrphaned`.
- [ ] `markOrphaned(owner)`: `UPDATE … SET orphaned_at = NOW() WHERE guid NOT IN catalog AND orphaned_at IS NULL`; и сброс `orphaned_at = NULL` для вернувшихся GUID. Вызывается только когда синк явно завершён (DELETE+пачки → по таймеру 5 мин после последней пачки).
- [ ] Коммит.

### Task 6: Правила единиц «поставщик + товар» (п.3) (миграция 66)
**Files:** Modify `src/database/repositories/ocrCorrectionRepo.ts` (remember/apply для `item_unit` с `item_key`), migrations 66, `invoices.ts` PATCH item (передавать имя строки и сырую единицу), `tests/database/ocrCorrectionScoped.test.ts` (чистая функция `applyItemUnitCorrections(items, rules)`).
- [ ] Тест: правило {item_key('Яйцо С1 360шт'), шт→кг} меняет только эту строку; правило без item_key (active=0) не применяется; активное legacy-правило без item_key не создаётся.
- [ ] Миграция 66: `item_key VARCHAR(255) NULL`, `active TINYINT NOT NULL DEFAULT 1`; `UPDATE … SET active=0 WHERE field_name='item_unit' AND item_key IS NULL`.
- [ ] Коммит.

### Task 7 (агент, параллельно): Поставщики и эксплуатация (п.18–20) — без миграций
**Files:** Create `src/utils/inn.ts` (если нет — `isValidInn`), `tests/utils/inn.test.ts`; Modify `src/api/routes/suppliers.ts`, `src/database/repositories/supplierRepo.ts` (merge), `public/js/suppliers.js`, `src/services/supplierMatch.ts` (кандидаты с невалидным ИНН отбрасываются, двойники → валидный), `src/notifications/*` (пакетный режим под флагом `batch_notify` через `isEngineOn` — до мёржа Task 1 использовать заглушку `process.env`/true), `src/notifications/telegram/telegramNotifier.ts` («not modified» = успех), `src/api/routes/onec.ts:203` (poll-лог), `src/api/server.ts` (URIError → 400 + warn), `src/api/middleware/requestLog.ts` (не писать `/sync-flag`), `src/index.ts` (чистка `poll` > 3 дней).
- [ ] Тесты: isValidInn (5258068806 ✓, 5258006806 ✗, 7724357632 ✓, 7724357832 ✗, 12-значные); батчер уведомлений (чистая логика окна: 3 события/2 мин → batch, сводка после 90 с тишины); pickAutoLinkCandidate с невалидным двойником.
- [ ] Коммиты по подпунктам.

**Деплой релиза 1** после мёржа Tasks 1–7: tsc, тесты, локальный стенд на прод-копии (миграции 62–66 на MySQL), push в main, проверка прод-лога миграций на MariaDB, `/health`, снимок baseline создан (`SELECT kind, COUNT(*) FROM invoice_snapshots GROUP BY kind`).

## Релиз 2 — количество и сопоставление

### Task 8: Конвертер единиц (п.1–2), чистый модуль
**Files:** Create `src/mapping/unitConverter.ts`, `tests/mapping/unitConverter.test.ts`.
- [ ] Тесты на реальных строках прода (ожидания — в кг/шт 1С):
  - «Батон "Нарезной" в/с 0,4 кг», 60 шт, 1932 ₽, 1С кг → 24 кг, 80,50 ₽/кг, source `name`
  - «Мука (50кг)», 2 шт, 1С кг → 100 кг
  - «Горбуша нат. 240г*24 ГОСТ», 48 шт, 196 ₽, 1С кг → 11,52 кг (шт = банка)
  - «Горбуша … 240г*24», 2 кор, 1С кг → 11,52 кг (кор = 24 банки)
  - «Сахар Порционный 500*5г», 1 шт, 435 ₽, 1С кг, медиана 90 → 2,5 кг (`price_fit`), без медианы → флаг
  - «Перчатки нитриловые … 100шт/упак», 2 упак, 1С шт → 200 шт
  - «Контейнер … (х50/500)», 500 шт, 1С шт → 500 шт (×1)
  - «Печень говяжья зам 4-5кг», 3 шт, 1С кг → без пересчёта, флаг `needs_weight`
  - «Камбала … 300-500г», 10 кг, 1С кг → 10 кг (`same`)
  - «Майонез … 67% 10л/9,6кг», 3 шт, 1С кг → 28,8 кг
  - «Яйцо Куриное Коричневое С1 360шт», 1080 шт, 1С шт → 1080 шт (`same`)
  - «Перец желтый», 3,5 кг, 1С шт → без пересчёта, флаг `unit_mismatch`
  - «Сыр … 1,107кг», 2,214 кг, 1С шт → 2 шт
  - «Масло подсолнечное … 1л 1/15», 30 шт, 1С кг → 30 кг (плотность 1, заметка)
  - «Бедро … 600г», 10 шт, 1С кг → 6 кг
  - «Вода … 1,5л», 12 шт, 1С шт → 12 шт
  - «10x1кг» латинская x, 3 кор, 1С кг → 30 кг
  - инвариант: `total` не меняется ни в одном случае; повторный вызов на результате с тем же raw даёт тот же результат.
- [ ] Реализация; коммит.

### Task 9: Хранение raw/conv + сервис пересчёта (миграции 67–68)
**Files:** Create `src/services/lineConversion.ts`, `src/database/repositories/itemUnitRuleRepo.ts`, `tests/services/lineConversion.test.ts` (моки репо); Modify migrations 67–68, `invoiceRepo.ts` (`addItem`/`CreateInvoiceItemData`, `updateItemConversion`), `src/pricing/priceStats.ts` (`getRobustMedian(owner, guid, unit)`).
- [ ] 67: `invoice_items` + `raw_quantity DOUBLE, raw_unit VARCHAR(32), raw_price DOUBLE, raw_total DOUBLE, conv_factor DOUBLE, conv_note VARCHAR(255), conv_source VARCHAR(16), qty_flag VARCHAR(24), qty_flag_note VARCHAR(255)`; бэкфилл raw_* = текущие.
- [ ] 68: `item_unit_rules(id, owner_user_id, supplier_key VARCHAR(64) NULL, name_key VARCHAR(255), raw_unit VARCHAR(32) NULL, target_unit VARCHAR(32), factor DOUBLE, source VARCHAR(16), note VARCHAR(255), active TINYINT DEFAULT 1, times_used INT DEFAULT 0, last_used_at, created_by, created_at, updated_at)` + UNIQUE `(owner_user_id, supplier_key, name_key, raw_unit)`.
- [ ] `convertInvoiceLine`: флаг off → `resolveAndApplyPackTransform` (legacy) + raw_* заполняются; on → правило поставщик+товар → правило товара → legacy-упаковка (только если мера есть в названии) → `convertLine`.
- [ ] Коммит.

### Task 10: Все пути конвейера через convertInvoiceLine
**Files:** Modify `src/watcher/fileWatcher.ts` (reprocess ~:471-505, append ~:604-631, multi-page ~:1195-1215, processFile ~:1452-1484), `src/api/routes/dispatcher.ts` (~:505-530), `src/api/routes/invoices.ts` (`/remap` ~:983-1024 — от raw; `/llm-remap` ~:1120-1190; PUT map ~:1520-1545 — вместо наивного умножения; PATCH item ~:1640-1680 — правка количества/единицы в «1С-слое» → `conv_source='manual'` + предложение правила).
- [ ] Тест-инвариант (DB-free, моки): для всех путей сумма `total` строк до/после одинакова.
- [ ] Коммит.

### Task 11: Проверка правдоподобия (п.4)
**Files:** Modify `src/pricing/priceStats.ts` (медиана без флагованных строк, отсев ×5), `src/automation/qualityGate.ts` (`unit_suspect`), `public/js/invoices.js` (красная строка, «−10%» не зелёное при флаге, подтверждение отправки в 1С при флагах).
- [ ] Тесты на `robustMedian` и `evaluateQualitySubject` c `flagged_items>0`.
- [ ] Коммит.

### Task 12: UI строки
**Files:** Modify `public/js/invoices.js`, `public/css/style.css`, `src/api/routes/invoices.ts` (`POST /:invoiceId/items/:itemId/revert-raw`, `POST /:invoiceId/items/:itemId/unit-rule`).
- [ ] Под количеством: «в накладной: 60 шт × 32,20 ₽» + формула; флаг с пояснением; кнопки «Вернуть как в накладной», «Запомнить пересчёт».
- [ ] Коммит.

### Task 13: Ключ товара и атрибуты (п.9–10) + поля сопоставлений (миграция 65)
**Files:** Create `src/mapping/nameKey.ts`, `tests/mapping/nameKey.test.ts`; migrations 65 (`source VARCHAR(16)`, `confirmed_at`, `confirmed_by`, `name_key VARCHAR(255)` + индекс `(owner_user_id, name_key)`, `orphaned_at`; то же `name_key` для `supplier_nomenclature_mapping_cards`; бэкфилл JS: approved=1 → `import`+confirmed, иначе `llm`).
- [ ] Тесты ключа: «Капуста морская(3кг)» = «Капуста морская (3 кг)» = «Капуста морская 3кг»; «Огурчики 9-12 маринованные 7,5кг» = «Огурчики маринованные 7,5кг 9-12»; «Контейнер 750мл» ≠ «Контейнер 500мл»; «Маслины 300г 1/12» = «Маслины 300г».
- [ ] Тесты атрибутов: 750мл vs 500мл → конфликт; «(M)» vs «S» → конфликт; «67%» vs «67%» → нет; «Сметана 20%» vs «Сметана 15%» → конфликт; объём только с одной стороны → нет.
- [ ] Коммит.

### Task 14: Порядок и происхождение правил (п.8)
**Files:** Modify `src/mapping/nomenclatureMapper.ts` (стадии v2 под `mapping_v2`), `src/database/repositories/mappingRepo.ts` (`getByNameKey`, `confirm`, `touchUsage`, upsert не трогает confirmed), `src/watcher/fileWatcher.ts` (LLM-выбор после подтверждённых правил, без перезаписи подтверждённых), `invoices.ts` (PUT map → confirmed + confidence 1; `POST /:id/confirm-mappings`), `public/js/invoices.js` (кнопка «Подтвердить сопоставления»), `public/js/mappings.js` (колонки «источник», «подтверждено», живые счётчики).
- [ ] Тесты (моки): подтверждённое правило побеждает LLM; LLM обновляет только неподтверждённое; ручной выбор ставит confirmed.
- [ ] Коммит.

### Task 15: «Не это» и атрибуты в подборе (п.10–11) (миграция 69)
**Files:** Create `src/database/repositories/rejectionRepo.ts`; Modify mapper (все стадии пропускают отклонённые GUID и конфликт атрибутов), fileWatcher (пост-проверка выбора LLM), `invoices.ts` (запись отклонений в PUT map/clear), `mappings.js` (список отклонённых с удалением).
- [ ] `mapping_rejections(id, owner_user_id, name_key, onec_guid, created_by, created_at, UNIQUE(owner_user_id, name_key, onec_guid))`.
- [ ] Коммит.

### Task 16: Холодный старт (п.13)
**Files:** Modify `src/api/routes/onec.ts`/`nomenclature.ts` (дебаунс-таймер «каталог обновлён» → `remapUnsentInvoices(owner)`), `src/services/remapUnsent.ts` (create), `invoices.ts` (`GET /:invoiceId/items/:itemId/candidates` — топ-3 с баллами и конфликтами), `public/js/invoices.js` (чипы кандидатов у строк < 0,8).
- [ ] Коммит.

### Task 17: Восстановление стёртых правил (п.7)
**Files:** Create `src/scripts/restore-mappings-from-dump.ts` (локально: читает старый дамп, берёт `nomenclature_mapping_cards`/`nomenclature_mappings` строки, выдаёт JSON), `src/api/routes/mappings.ts` (`POST /api/mappings/restore` admin: INSERT только отсутствующих `(owner, scanned_name)`, GUID обязан быть в каталоге, `source='restored'`).
- [ ] Коммит.

**Деплой релиза 2**: стенд на прод-копии — `/remap` по 10 реальным накладным (194, 676, 699, 719, 727, 740, 745, 752, 764, 775) сравнить до/после; проверить шапки не изменились; push; прод-проверка.

## Релиз 3 — самообучение и новые товары

### Task 18: Предложения правил (п.15) (миграция 70)
**Files:** Create `src/learning/ruleMiner.ts` (чистые майнеры), `src/learning/llmAdvisor.ts`, `src/learning/scheduler.ts`, `src/database/repositories/ruleProposalRepo.ts`, `src/api/routes/learning.ts` (`GET /api/learning/proposals`, `POST /:id/accept|reject`, `POST /run`), `public/js/learning.js`, пункт меню «Справочники → Предложения правил»; `tests/learning/ruleMiner.test.ts`.
- [ ] `rule_proposals(id, owner_user_id, kind VARCHAR(24), supplier_key, name_key, payload MEDIUMTEXT, evidence MEDIUMTEXT, source VARCHAR(8), status VARCHAR(12), created_at, decided_at, decided_by, UNIQUE(owner_user_id, kind, supplier_key, name_key, status))`.
- [ ] Майнеры: (а) ≥2 одинаковые правки количества с устойчивым коэффициентом → `unit_rule`; (б) `price_outlier` строки → коэффициент из медианы, совпадающий с мерой из названия → `unit_rule`; (в) повторяющиеся замены позиции → `mapping`; (г) привязки поставщика по названию → `supplier_alias`.
- [ ] Принятие создаёт правило и пересчитывает неотправленные накладные с этим товаром.
- [ ] Коммит.

### Task 19: Памятка по поставщикам в промпте (п.16)
**Files:** Create `src/learning/supplierMemory.ts` (`buildSupplierMemory(owner): string`, ≤ 3000 токенов), Modify `src/ocr/claudeApiAnalyzer.ts` (кэшируемый system-блок после каталога), `src/ocr/ocrManager.ts` (прокинуть owner), тест на формат/ограничение длины.
- [ ] Коммит.

### Task 20 (агент, параллельно): Эталоны (п.17) (миграция 71)
**Files:** migrations 71 (`invoices.golden TINYINT DEFAULT 0, golden_at DATETIME NULL`; `golden_runs(id, started_at, finished_at, owner_user_id, status, summary MEDIUMTEXT, results MEDIUMTEXT)`), `src/utils/photoRetention.ts` (пропуск golden), `src/golden/goldenRunner.ts` (перераспознавание без записи, сравнение), `src/api/routes/invoices.ts` (`PATCH /:id/golden`), `src/api/routes/debug.ts` (`POST /golden/run`, `GET /golden/runs`), `public/js/invoices.js` (⭐), `public/js/settings.js` (прогон и результаты).
- [ ] Тест чистой функции сравнения (номер/дата/сумма/НДС/ИНН, строки по порядку, допуски 0,01).
- [ ] Коммит.

### Task 21: Новые товары (п.12) (миграция 72)
**Files:** migrations 72 (`new_item_requests(id, owner_user_id, name_key, name, unit, parent_guid, status VARCHAR(12), onec_guid, created_by, created_at, updated_at)`), `src/api/routes/newItems.ts`, `public/js/newItems.js`, `invoiceRepo.getPendingWithItems` (поле `new_item` в строках), `1c/.../Ext/ObjectModule.bsl` (при создании номенклатуры брать единицу и группу из `new_item`, иначе прежнее поведение), после синка каталога — связывание по имени.
- [ ] Коммит.

### Task 22: Документация
**Files:** Create `docs/runbooks/rollback-v2.md`; Modify `CLAUDE.md` (прод = MariaDB 10.11; миграция 72; новые правила «не удалять правила при синке», «пересчёт только через convertInvoiceLine», «правки → edit_log»).
- [ ] Коммит.

**Деплой релиза 3**; финальная проверка: эталонный прогон на 5 накладных, отчёт пользователю.
