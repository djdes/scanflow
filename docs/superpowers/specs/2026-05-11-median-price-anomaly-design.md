# Median-Price Anomaly Detection — Design

**Status:** approved
**Author:** Claude (со-дизайн с пользователем)
**Date:** 2026-05-11

## Проблема

Поставщики иногда поставляют товар под обычным названием (например, «Мука пшеничная 50кг») по цене, в 1.5–2× выше нормальной. Сейчас отдел снабжения замечает это только постфактум, при сверке. К моменту обнаружения накладная уже одобрена и оплачена.

Цель — в момент просмотра накладной видеть рядом с каждой ценой «обычную» цену по этой же позиции, чтобы аномалии бросались в глаза до approve_for_1c.

## Решение

К каждой строке накладной показывать **медиану цены за последние 10 поставок** этой же позиции (`onec_guid`), плюс цветовая подсветка строки по проценту отклонения текущей цены от медианы.

### Метрика

- **Медиана последних 10 поставок** (не среднее — устойчиво к выбросам, которые мы как раз и ловим).
- **Глобально по `onec_guid`** (не per-supplier) — нужен сигнал «эта мука стоит у других дешевле», а не «этот поставщик стабильно дорогой».
- **Цена за единицу с НДС** — `invoice_items.price` в проекте уже хранится в этой нормализации.
- **Минимум 3 сэмпла** — иначе не показываем медиану и не подсвечиваем строку.

### Heatmap

Цвет фона строки по `(price − median) / median × 100`:

| Δ от медианы | Цвет |
|---|---|
| ≤ −10% | зелёный (дешевле обычного) |
| −10% .. +10% | без цвета (норма) |
| +10% .. +25% | жёлтый |
| +25% .. +50% | оранжевый |
| > +50% | красный |

Если медианы нет (новый товар, мало данных, разные единицы) — строка без цвета.

## Архитектура

```
[OCR-pipeline] → invoiceRepo.create*  ──insert items──>  invoice_items
                          │
                          └──after-save hook──> recomputeMedianForGuid(guid)  ←─ для каждого затронутого GUID
                                                       │
                                                       └── UPSERT ──> nomenclature_price_stats

[UI: GET /api/invoices/:id] ──> invoiceRepo.detail() ──LEFT JOIN──> nomenclature_price_stats
                                                       │
                                                       └─> items[i].median_price, .price_deviation_pct

[Frontend: app.js invoice detail] ──> рендер таблицы товаров с новой колонкой и cell-classNamе по deviation
```

## Компоненты

### 1. Новая таблица `nomenclature_price_stats`

Миграция 24 в [src/database/migrations.ts](../../src/database/migrations.ts):

```sql
CREATE TABLE nomenclature_price_stats (
  onec_guid     VARCHAR(64) PRIMARY KEY,
  median_price  DOUBLE      NOT NULL,
  price_unit    VARCHAR(32) NOT NULL,
  samples       INT         NOT NULL,
  updated_at    DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

**Идемпотентность миграции:** `CREATE TABLE IF NOT EXISTS` + `hasTable` guard в `detect()`. Прод и dev накатывают одинаково. Бэкфилл инициальных значений — в той же миграции (см. ниже).

**Почему отдельная таблица, а не колонка в `nomenclature_mappings`:** одна запись `nomenclature_mappings` имеет одну `scanned_name`, и несколько `scanned_name` могут указывать на тот же `onec_guid`. Хранение median per-mapping приведёт к дублированию данных. `nomenclature_price_stats` keyed-by-guid — одна строка на 1C-товар.

### 2. Модуль `src/pricing/priceStats.ts` (новый)

Экспортируемые функции:

```ts
// Подсчитать медиану по последним 10 поставкам для GUID и записать в price_stats.
// Возвращает посчитанное состояние или null если samples < 3 (тогда строка удаляется).
export async function recomputeMedianForGuid(guid: string): Promise<PriceStats | null>;

// Массовый пересчёт. Используется при backfill и при удалении накладной.
export async function recomputeMedianForGuids(guids: string[]): Promise<void>;
```

**Алгоритм `recomputeMedianForGuid`:**

```sql
SELECT ii.price, ii.unit
FROM invoice_items ii
JOIN invoices i ON i.id = ii.invoice_id
WHERE ii.onec_guid = :guid
  AND ii.price > 0
  AND ii.unit IS NOT NULL AND ii.unit != ''
ORDER BY i.invoice_date DESC, ii.id DESC
LIMIT 10;
```

Дальше в Node:
1. Группировать prices по `unit`. Выбрать unit с максимальным количеством записей (защита от разнобоя «кг» vs «шт» под одним GUID).
2. Tie-break: если ровно 50/50 — берём unit из первой строки (она же самая свежая по `invoice_date DESC`).
3. На выбранных prices: отсортировать по возрастанию, медиана = `prices[Math.floor(n/2)]` если N нечётно, иначе `(prices[n/2-1] + prices[n/2]) / 2`.
4. Если `samples < 3` — `DELETE FROM nomenclature_price_stats WHERE onec_guid = ?` и вернуть null (чтобы старые медианы не висели после, например, удаления накладных).
5. Иначе — `INSERT ... ON DUPLICATE KEY UPDATE`.

### 3. Хуки в `invoiceRepo`

Места в [src/database/repositories/invoiceRepo.ts](../../src/database/repositories/invoiceRepo.ts), где нужно дёрнуть пересчёт:

| Где | Когда | Что передать |
|---|---|---|
| `createInvoiceItem` (line 259) | после INSERT | один GUID, если не NULL |
| `updateItemMapping` (line 293) | после UPDATE onec_guid | новый и старый GUID |
| `updateItemFields` (line 305, 321) | если поменяли `price` или `unit` | GUID этого item-а |
| `updateItemNomenclature` (line 326) | после смены GUID | новый и старый GUID |
| `deleteByInvoiceId` (line 575) и `delete` (line 582) | до DELETE собрать GUID-ы, после DELETE пересчитать | все GUID-ы удалённых items |

**Важно:** хук вызывается АСИНХРОННО относительно ответа клиенту — не блокировать UI на пересчёт. Реализация: после успешного коммита транзакции — `void recomputeMedianForGuids(guids).catch(err => logger.warn('price-stats recompute failed', { err, guids }))`. Ошибка пересчёта не должна откатывать сохранение накладной.

### 4. API: `GET /api/invoices/:id`

В `invoiceRepo` функция, которая собирает invoice + items, расширить SELECT в части items:

```sql
SELECT
  ii.*,
  ps.median_price,
  ps.price_unit         AS median_price_unit,
  ps.samples            AS median_samples
FROM invoice_items ii
LEFT JOIN nomenclature_price_stats ps ON ps.onec_guid = ii.onec_guid
WHERE ii.invoice_id = ?
ORDER BY ii.id;
```

В контроллере (или прямо в репо) — пост-обработка:

```ts
for (const item of items) {
  if (
    item.median_price != null &&
    item.median_samples >= 3 &&
    item.median_price_unit === item.unit &&
    item.price > 0
  ) {
    item.price_deviation_pct = ((item.price - item.median_price) / item.median_price) * 100;
  } else {
    // Возвращаем фронту "ничего не показывать"
    item.median_price = null;
    item.price_deviation_pct = null;
  }
}
```

Поле `median_samples` оставляем в ответе — фронт показывает `«(N поставок)»`.

### 5. Frontend (vanilla, `public/`)

В [public/app.html](../../public/app.html) (секция Invoice Detail) и [public/js/app.js](../../public/js/app.js) (рендер таблицы товаров):

- Добавить колонку **«Обычная»** в таблицу `items` рядом с «Цена».
- Содержимое: `<span>{median_price} ₽</span><br><small class="muted">{N} поставок</small>` — если `median_price != null`, иначе пусто.
- На `<tr>` строки добавлять class по `price_deviation_pct`:
  - `≤ -10` → `row-price-good`
  - `-10..10` → нет класса
  - `10..25` → `row-price-warn`
  - `25..50` → `row-price-alert`
  - `> 50` → `row-price-anomaly`
- Стили — в [public/css/style.css](../../public/css/style.css), tokens:
  - `row-price-good`: фон `rgba(6, 214, 160, 0.08)` (зелёный)
  - `row-price-warn`: `rgba(251, 191, 36, 0.10)` (жёлтый)
  - `row-price-alert`: `rgba(251, 146, 60, 0.13)` (оранжевый)
  - `row-price-anomaly`: `rgba(239, 68, 68, 0.15)` (красный)
  - Цвет шрифта остаётся стандартным — читаемость важнее.
- Темновой режим — реюзаем те же RGBA-значения (полупрозрачные), они читаются на обоих темах.

### 6. Backfill при первой накатке миграции

Внутри `run()` миграции 24, после `CREATE TABLE`:

```sql
SELECT DISTINCT onec_guid FROM invoice_items WHERE onec_guid IS NOT NULL;
```

Для каждого GUID — вызвать `recomputeMedianForGuid` (миграция должна импортнуть функцию из `src/pricing/priceStats.ts`). На текущих 43 накладных это ~30-60 уникальных GUID, заполнение займёт пару секунд.

## Edge cases

| Кейс | Поведение |
|---|---|
| `onec_guid IS NULL` на item | median не показывается, без цвета |
| `price == 0` или null | в выборке не участвует, heatmap для этой строки нет |
| Разные единицы в истории GUID | берём мажорную (или самую свежую при tie) |
| `item.unit ≠ median_price_unit` | показываем median, но без цвета (сравнение бессмысленно) |
| `samples < 3` | строка в `price_stats` удаляется, фронт показывает пусто |
| Параллельная обработка двух накладных | UPSERT по PK атомарен; double-recompute даёт тот же результат |
| Хук пересчёта упал | логируем warn, сохранение накладной не откатывается |

## Тесты

`tests/pricing/priceStats.test.ts`:

- 5 поставок в одной единице → median = `prices[2]`
- 6 поставок в одной единице → median = `avg(prices[2], prices[3])`
- `samples < 3` → возвращает null, строка в БД отсутствует
- 5 шт + 3 кг для одного GUID → берёт шт (мажорная единица), samples=5
- 5 шт + 5 кг для одного GUID, последняя — кг → берёт кг (tie-break по свежести)
- `price = 0` фильтруется
- Берём 10 ПОСЛЕДНИХ по `invoice_date DESC`, 11-ю не учитываем
- После повторного вызова `recompute` строка обновляется, не дублируется

`tests/api/invoices.test.ts` (новый или дополнить существующий):

- `GET /api/invoices/:id` возвращает items с `median_price`, `median_price_unit`, `median_samples`, `price_deviation_pct`
- Item без `onec_guid` — поля `null`
- Item с `unit ≠ median_price_unit` — `price_deviation_pct == null`, `median_price` показан

`tests/database/migrations.test.ts` (если есть) — миграция 24 идемпотентна (повторный run не падает).

**Что НЕ тестируем:**
- Heatmap-цвета — CSS без бизнес-логики, проверится глазами.
- Backfill в миграции — одноразовый, валидируется вручную после деплоя.

## Не делаем (YAGNI)

- График цены по времени.
- Per-supplier медиана.
- Telegram/email уведомления о price spike (можно добавить позже как отдельное событие в `notification_events`).
- Блокировка `approve_for_1c` на красных строках — пусть остаётся решением пользователя.
- Сравнение с внешним рынком (DaData/конкуренты) — слишком разные структуры.

## Открытые вопросы

Нет. Все ключевые развилки разобраны на этапе brainstorming:
- метрика (медиана из 10),
- группировка (глобально по GUID),
- сигнал (heatmap, без алертов),
- хранение (отдельная таблица),
- минимум сэмплов (3).
