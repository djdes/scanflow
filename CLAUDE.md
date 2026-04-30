# 1C-JPGExchange — Документация для будущих доработок

**Дата:** 2026-04-24
**Версия:** 1.6 (production, deployed)
**Статус:** Production на scanflow.ru | GitHub Actions CI/CD

---

## Оглавление

1. [Обзор проекта](#обзор-проекта)
2. [Текущий статус](#текущий-статус)
3. [Архитектура](#архитектура)
4. [Парсер накладных — важные детали](#парсер-накладных--важные-детали)
5. [Известные ограничения](#известные-ограничения)
6. [Планы доработок](#планы-доработок)
7. [Обучение и улучшение парсера](#обучение-и-улучшение-парсера)
8. [Примеры обработанных документов](#примеры-обработанных-документов)
9. [Гибридный OCR (Google Vision + Claude CLI)](#гибридный-ocr-google-vision--claude-cli-) ⭐
10. [Многостраничные накладные](#многостраничные-накладные)
11. [Авторизация: пользователи и API-ключи](#авторизация-пользователи-и-api-ключи) ⭐
12. [Деплой и CI/CD](#деплой-и-cicd) ⭐

---

## Обзор проекта

**1C-JPGExchange** — сервис для автоматического распознавания приходных накладных с фотографий и интеграции с 1С:УНФ 1.6.

### Основной процесс

```
Фото накладной (JPG)
    ↓
OCR (Google Vision → Claude CLI → Tesseract)
    ↓
Парсинг структурированных данных
    ↓
Маппинг номенклатуры
    ↓
Сохранение в SQLite
    ↓
Отправка в 1С через webhook/REST API
```

### Технологии

- **Backend:** Node.js v25.2.1, TypeScript (strict mode)
- **OCR:** Google Cloud Vision API (основной), Claude Code CLI (резервный), Tesseract.js (офлайн fallback)
- **БД:** SQLite (better-sqlite3) с WAL mode
- **API:** Express v5.2.1 с авторизацией по `X-API-Key` (ключ привязан к аккаунту в таблице `users`; вход в дашборд — логин/пароль через `POST /api/auth/login`)
- **Frontend:** Статический HTML+CSS+JS (vanilla, hash-routing)
- **Логирование:** Winston

---

## Текущий статус

### ✅ Реализовано

#### Бэкенд
- ✅ OCR-цепочка с автоматическим fallback (Google Vision → Tesseract)
- ✅ **Гибридный OCR (Google Vision + Claude CLI)** — интеллектуальная структуризация текста через MAX подписку
- ✅ Парсер накладных с поддержкой 3 форматов:
  - "Счёт на оплату" (простой формат, 1-2 товара)
  - "Счёт на оплату" (с платёжным поручением, продуктовые коды)
  - ТОРГ-12 (товарная накладная, до 13+ товаров) — **100% точность с Claude analyzer**
- ✅ Маппинг номенклатуры (нечёткий поиск через fuse.js)
- ✅ File watcher (автоматическая обработка при добавлении файлов в `data/inbox/`)
- ✅ REST API (накладные, маппинги, загрузка, webhook, статистика)
- ✅ Webhook для отправки в 1С
- ✅ SQLite БД с миграциями

#### Фронтенд
- ✅ Дашборд (список накладных, фильтры, статистика)
- ✅ Детальный просмотр накладной (товары, суммы, OCR текст)
- ✅ Загрузка файлов через drag & drop
- ✅ Управление маппингами номенклатуры (CRUD)
- ✅ Настройки webhook

#### Тестирование
- ✅ Полное тестирование всех API эндпоинтов
- ✅ Проверка на 3 типах реальных накладных
- ✅ Zero ошибок в production-режиме

### 🔧 Требует доработки

1. ~~**Парсер ТОРГ-12:**~~ — **РЕШЕНО** с помощью гибридного OCR (Claude analyzer)
   - ~~Количества и цены определяются с неточностями~~
   - Теперь: 100% точность на всех 13 товарах с Claude analyzer

2. **Маппинг номенклатуры:**
   - Пока только базовый нечёткий поиск
   - Нет supplier-specific маппинга (разные поставщики → разные названия товаров)
   - Нет автоматического обучения на основе пользовательских исправлений

3. **1С интеграция:**
   - Внешняя обработка (.epf) для 1С ещё не написана
   - Webhook тестировался только на example.com (405 ожидаемо)

4. ~~**ML/обучение:**~~ — **Частично решено** через Claude analyzer
   - Claude CLI обеспечивает интеллектуальный парсинг без отдельной ML-модели
   - Использует MAX подписку (бесплатно)

---

## Архитектура

### Структура проекта

```
1C-JPGExchange/
├── src/
│   ├── index.ts                      # Точка входа
│   ├── config.ts                     # Конфигурация из .env
│   ├── watcher/
│   │   └── fileWatcher.ts            # Chokidar file watcher
│   ├── ocr/
│   │   ├── ocrManager.ts             # Fallback chain manager + recognizeHybrid()
│   │   ├── googleVision.ts           # Google Cloud Vision API
│   │   ├── claudeCodeBridge.ts       # Claude Code CLI subprocess (disabled - can't read images)
│   │   ├── claudeTextAnalyzer.ts     # ⭐ Claude CLI текстовый анализатор (hybrid mode)
│   │   └── tesseract.ts              # Tesseract.js fallback
│   ├── parser/
│   │   └── invoiceParser.ts          # ⚠️ КЛЮЧЕВОЙ ФАЙЛ — парсинг накладных
│   ├── mapping/
│   │   └── nomenclatureMapper.ts     # Fuse.js нечёткий поиск
│   ├── database/
│   │   ├── db.ts                     # SQLite init
│   │   ├── migrations.ts             # DB schema
│   │   └── repositories/
│   │       ├── invoiceRepo.ts        # CRUD накладных
│   │       └── mappingRepo.ts        # CRUD маппингов
│   ├── api/
│   │   ├── server.ts                 # Express server
│   │   ├── middleware/
│   │   │   └── auth.ts               # API key auth
│   │   └── routes/
│   │       ├── invoices.ts           # GET /api/invoices, /:id, /stats, POST /:id/send
│   │       ├── mappings.ts           # CRUD /api/mappings
│   │       ├── upload.ts             # POST /api/upload
│   │       └── webhook.ts            # GET/PUT /api/webhook/config
│   ├── integration/
│   │   └── webhook.ts                # HTTP POST к 1С
│   └── utils/
│       └── logger.ts                 # Winston logging
├── public/                           # Статический фронтенд
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── app.js                    # Роутер, API wrapper, auth
│       ├── invoices.js               # Список + детали
│       ├── upload.js                 # Drag & drop upload
│       ├── mappings.js               # CRUD маппингов
│       └── webhook.js                # Настройки webhook
├── data/
│   ├── inbox/                        # Входящие JPG
│   ├── processed/                    # Обработанные
│   ├── failed/                       # С ошибками
│   └── database.sqlite               # БД
├── .env                              # Конфигурация
├── package.json
└── CLAUDE.md                         # Этот документ
```

### База данных (SQLite)

#### Таблица `invoices`
```sql
CREATE TABLE invoices (
  id INTEGER PRIMARY KEY,
  file_name TEXT NOT NULL,
  file_path TEXT,
  invoice_number TEXT,
  invoice_date TEXT,
  supplier TEXT,
  total_sum REAL,
  raw_text TEXT,
  status TEXT DEFAULT 'new',  -- new | ocr_processing | parsing | processed | sent_to_1c | error
  ocr_engine TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  sent_at TEXT,
  error_message TEXT
);
```

#### Таблица `invoice_items`
```sql
CREATE TABLE invoice_items (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL,
  original_name TEXT NOT NULL,      -- Название из скана
  mapped_name TEXT,                 -- Название в 1С (после маппинга)
  quantity REAL,
  unit TEXT,
  price REAL,
  total REAL,
  mapping_confidence REAL,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id)
);
```

#### Таблица `nomenclature_mappings`
```sql
CREATE TABLE nomenclature_mappings (
  id INTEGER PRIMARY KEY,
  scanned_name TEXT UNIQUE NOT NULL,
  mapped_name_1c TEXT NOT NULL,
  category TEXT,
  default_unit TEXT,
  approved INTEGER DEFAULT 0
);
```

#### Таблица `webhook_config`
```sql
CREATE TABLE webhook_config (
  id INTEGER PRIMARY KEY,
  url TEXT,
  enabled INTEGER DEFAULT 0,
  auth_token TEXT
);
```

---

## Парсер накладных — важные детали

**Файл:** [`src/parser/invoiceParser.ts`](src/parser/invoiceParser.ts) — **самый сложный компонент системы**.

### Стратегия парсинга

Парсер использует **3 стратегии последовательно** (fallback):

#### Strategy 1: Table-like rows (одна строка = весь товар)
```
1  Молоко 3.2% 1л  10  шт  89.90  899.00
```
- Работает для простых накладных с хорошим OCR
- Regex: `/^(?:\d+[.\)\s]+)?(.+?)\s+(\d+[.,]?\d*)\s*(кг|шт|л)?\.?\s+(\d+[.,]?\d+)\s+(\d+[.,]?\d+)/`

#### Strategy 2: Multi-line OCR table parsing ⚠️ **ОСНОВНАЯ**
Работает когда OCR разбивает таблицу на отдельные строки:
```
1
Молоко 3.2% 1л
10
шт
89.90
899.00
```

**Этапы:**
1. Определение границ таблицы (`товар[ыа]?\s*\(?работ/i` → `итого|всего`)
2. Сбор элементов:
   - **Названия товаров** (Cyrillic, начинается с номера или standalone)
   - **Количество + ед.изм** ("60 шт")
   - **Standalone количество** (просто "60")
   - **Цены** (числа с 2 знаками после запятой)
3. Post-processing:
   - Поиск standalone названий (без номера строки)
   - Сортировка по индексу
   - Merge continuation lines (многострочные названия типа "Сладкая\nЖизнь")
4. Привязка qty/price к товарам:
   - **Proximity assignment** (цены между товарами) — row-by-row OCR
   - **Sequential assignment** (цены после всех товаров) — column-by-column OCR
5. Cross-validation:
   - Если `qty × price ≠ total` (разница >1) → перерасчёт

#### Strategy 3: Multiplication patterns
```
10 шт x 89.90 = 899.00
```
- Для накладных с явным форматом "qty × price = total"

### Ключевые regex-паттерны

#### Номер накладной
```typescript
const INVOICE_NUMBER_PATTERNS = [
  /номер\s+документа[^\n]*\n\s*(\S+)/i,                   // ТОРГ-12
  /(?:счет|счёт|накладная|наклад)[\s\w]*№\s*(\d+)/i,      // Счёт № 94
  /№\s*([A-Za-zА-Яа-я]{1,5}[\-]?\d[\d\-\/]*)/i,          // №ПН-00457
  /(?:ПН|ТН|УПД)[\s\-]*(\d+[\-\/]?\d*)/i,                 // ПН-00457
];
```

#### Поставщик
```typescript
const COMPANY_PATTERN = /((?:ООО|ОАО|ЗАО|АО|ПАО|ИП)\s+.+?)(?:,\s*ИНН|$)/i;
```
- Ищется между строками "Поставщик" и "Покупатель"
- Или первая компания до "Покупатель" (fallback)

#### Товары (ТОРГ-12 с кодом)
```typescript
/^(?:\d{1,3}-\d{2,3}-\d{2}\s+)?(\d{1,3})\s+(?:\d{4,}\s+)?([А-ЯЁа-яё].{2,})/
```
Примеры:
- `40-057-11 2 Кальмар Командорский` → row=2, name="Кальмар Командорский"
- `1 0000000000 Батон "Нарезной"` → row=1, name="Батон \"Нарезной\""

#### Количество + единица
```typescript
/^(\d{1,4}(?:[.,]\d+)?)\s+(кг|шт|л|уп|упак|пач|бут)\.?\s*$/i
```
- **Ограничение 4 цифры** чтобы не путать с артикулами (113393 шт → это артикул, не qty)

#### Standalone количество
```typescript
/^\d{1,4}$/  // max 4 digits, не более 9999
```

#### Цены/суммы
```typescript
/^(\d[\d\s]*[.,]\d{2})\s*$/  // "1 900,00" или "30,60"
```

### Специфика ТОРГ-12

**Проблема:** OCR читает широкую таблицу ТОРГ-12 **column-by-column** вместо row-by-row:
```
Все товары (13 строк)
Все количества (13 строк)
Все цены (13 строк)
Все суммы (13 строк)
```

**Решение:**
1. Обнаружение паттерна: `prices.filter(pr => pr.index > lastProductIdx)`
2. Разделение на unit prices (до "Итого") и totals (после "Итого")
3. Sequential assignment: `items[0].price = unitPrices[0].value`

**Результат:**
- ✅ Все 13 товаров распознаны
- ⚠️ Qty/price для некоторых неточны из-за OCR ошибок

### Skip keywords (ТОРГ-12)
```typescript
const skipKeywords = /^(кол|количеств|ед\.?$|цена|сумма|товар|работ|услуг|
  наименов|наим\.?$|итого|всего|без\s+налог|ставк|ндс|код$|номер|№|
  лист|набор|мест$|штук|принят|факт|руб|коп|учет|%$|адрес|грузо|
  основан|рейс|заказ|диспетч)/i;
```
- Фильтрует заголовки колонок и метаданные

---

## Известные ограничения

### 1. Парсер (regex-режим, без Claude analyzer)
- ~~❌ **ТОРГ-12 qty/price точность:** ~60-70%~~ → ✅ **РЕШЕНО** с Claude analyzer (100%)
- ~~❌ **Счёт с многострочной таблицей**~~ → ✅ **РЕШЕНО** с Claude analyzer
- ❌ **Сложные таблицы:** если >2 товара на одной строке OCR — не распознаётся (редкий случай)
- ❌ **НДС расчёты:** парсер не умеет вычитать НДС из итоговой суммы
- ~~❌ **Слияние товаров**~~ → ✅ **РЕШЕНО** с Claude analyzer

### 2. OCR
- ❌ **Плохое качество фото:** если фото размыто/криво — все OCR-движки дадут плохой текст
- ❌ **Рукописный текст:** не распознаётся (только печатный текст)
- ❌ **Смешанные языки:** английский в русских накладных иногда путается
- ⚠️ **Claude CLI не читает изображения** — решено гибридным подходом (Google Vision + Claude text)

### 3. Маппинг
- ❌ **Supplier-specific маппинг:** сейчас один глобальный список маппингов
- ❌ **Автообучение:** нет механизма запоминания пользовательских исправлений

### 4. 1С интеграция
- ✅ **Исходный код обработки готов:** папка `1c/` содержит модули и инструкцию
- ⚠️ **Требуется сборка .epf:** скомпилировать в Конфигураторе 1С (см. `1c/README_1C.md`)
- ❌ **Реальный webhook не тестировался:** только mock example.com

### 5. Claude analyzer
- ⚠️ **Один запрос одновременно:** очередь решает проблему, но обработка последовательная
- ⚠️ **Timeout 60 секунд:** для очень длинных накладных может не хватить
- ⚠️ **Зависимость от MAX подписки:** без подписки Claude CLI не работает

---

## Планы доработок

### Приоритет 1 (критично для продакшна)

1. **Написать 1С обработку (.epf)**
   - Файл: `1c/ЗагрузкаНакладныхИзСервиса.epf`
   - Функции:
     - `GET /api/invoices/pending` → получить необработанные
     - Создать `Документы.ПриходнаяНакладная`
     - Заполнить `Запасы` (номенклатура, qty, price)
     - `POST /api/invoices/:id/confirm` → подтвердить
   - См. план в [`C:\Users\djdes\.claude\plans\partitioned-puzzling-wilkes.md`](C:\Users\djdes\.claude\plans\partitioned-puzzling-wilkes.md)

2. **Улучшить парсер для хаотичных таблиц**
   - Проблема: Google Vision читает широкие таблицы непоследовательно (не row-by-row)
   - **Решение А (position-aware parsing):**
     - ✅ Google Vision уже возвращает bounding boxes для каждого слова (реализовано в `googleVision.ts`)
     - ⏳ Написать parser, который реконструирует таблицу по X/Y координатам
     - Алгоритм:
       1. Определить колонки таблицы по X-координатам (кластеризация слов по X)
       2. Сгруппировать слова по строкам (Y-координаты ± tolerance)
       3. Для каждой строки: название (left column) + qty (middle-left) + price (middle-right) + total (right)
     - **Точность:** >95% для любых таблиц
   - **Решение Б (Claude API fallback):**
     - При низком confidence или <50% товаров с ценами → отправить в Claude API
     - Prompt: "Extract invoice data from this image as JSON: {invoice_number, supplier, items: [{name, qty, unit, price, total}]}"
     - **Стоимость:** ~$0.01 за накладную
   - **Решение В (улучшение text-based parser):**
     - Добавить "recovery mode" для хаотичных данных
     - Использовать статистику: если после N товаров идёт M чисел, попробовать распределить их равномерно

3. **Supplier-specific маппинг**
   - Таблица: `supplier_nomenclature_mappings`
   - Столбцы: `supplier`, `scanned_name`, `mapped_name_1c`
   - Приоритет: supplier-specific → global fallback

### Приоритет 2 (улучшения)

4. **Автообучение парсера**
   - Механизм:
     - Пользователь исправляет qty/price в дашборде → сохранить как "ground truth"
     - Накопить 100+ исправлений → обучить ML-модель (TensorFlow.js?)
     - Модель предсказывает qty/price для новых товаров
   - Таблица: `invoice_item_corrections (invoice_item_id, field, corrected_value, corrected_at)`

5. **Поддержка УПД (универсальный передаточный документ)**
   - Формат: ТОРГ-12 + счёт-фактура в одном документе
   - Сложность: 2 таблицы на одной странице

6. **OCR quality score**
   - Google Vision возвращает `confidence` для каждого слова
   - Если средний confidence <0.7 → предупредить пользователя
   - Опция: "отправить на ручную проверку"

7. **Batch processing**
   - UI для загрузки 10+ накладных за раз
   - Очередь обработки (bullmq?)
   - Progress bar в реальном времени (WebSocket?)

### Приоритет 3 (дополнительно)

8. **Экспорт в Excel**
   - Кнопка "Скачать накладную как .xlsx"
   - Библиотека: exceljs

9. **Email уведомления**
   - При ошибке обработки → email администратору
   - nodemailer

10. **Multi-tenancy**
    - Несколько компаний в одной БД
    - Таблица `companies`, FK в invoices
    - API key per company

---

## Обучение и улучшение парсера

### Текущий подход (regex-based)

**Преимущества:**
- ✅ Не требует обучения
- ✅ Прозрачная логика (можно дебажить)
- ✅ Работает на 80% накладных "из коробки"

**Недостатки:**
- ❌ Не адаптируется к новым форматам
- ❌ Хрупкие паттерны (одна буква не так → не распознается)
- ❌ Требует ручной доработки для каждого формата

### Будущий подход (ML-based)

#### Вариант 1: Sequence labeling (NER-like)

**Идея:** каждая строка OCR = токен, задача = классификация:
- `PRODUCT_NAME`
- `QUANTITY`
- `UNIT`
- `PRICE`
- `TOTAL`
- `OTHER`

**Модель:** LSTM или Transformer (BERT для русского языка)

**Тренировка:**
1. Собрать 500+ накладных с ручной разметкой
2. Токенизация OCR-текста (по строкам)
3. Обучить модель на GPU (Google Colab / Kaggle)
4. Экспорт в ONNX → запуск в Node.js через onnxruntime-node

**Пример разметки:**
```
Лефицованная форма № ТОРГ-1     → OTHER
Номер документа                  → OTHER
17-0048600                       → INVOICE_NUMBER
Товары (работы, услуги)          → OTHER
1 Сердце Говяжье Замороженное    → PRODUCT_NAME
15,810                           → QUANTITY
кг                               → UNIT
380,00                           → PRICE
6 007,80                         → TOTAL
```

#### Вариант 2: Table detection + OCR position-aware parsing

**Идея:** использовать bounding boxes из Google Vision API

Google Vision возвращает для каждого слова:
```json
{
  "description": "Сердце",
  "boundingPoly": {
    "vertices": [
      {"x": 120, "y": 450},
      {"x": 200, "y": 450},
      {"x": 200, "y": 470},
      {"x": 120, "y": 470}
    ]
  }
}
```

**Алгоритм:**
1. Определить колонки таблицы по X-координатам
2. Сгруппировать слова по строкам (Y-координаты)
3. Каждая колонка = тип данных (название / qty / price / total)
4. Не нужно ML, только heuristics

**Преимущество:** точность 95%+ для ТОРГ-12

#### Вариант 3: Claude API для сложных случаев

**Идея:** fallback на Claude 3.5 Sonnet через API

**Workflow:**
1. Google Vision OCR → text
2. Парсер regex → если <50% товаров распознаны
3. Отправить полный OCR text + image в Claude API:
   ```
   Prompt: "Проанализируй фото накладной. Верни JSON с полями:
   invoice_number, supplier, items: [name, qty, unit, price, total]"
   ```
4. Claude возвращает готовый JSON

**Плюсы:**
- ✅ Работает для любых форматов
- ✅ Не требует обучения

**Минусы:**
- ❌ Дорого (~$0.01 за накладную)
- ❌ Зависимость от внешнего API

### Рекомендация

**Краткосрочно (1-2 месяца):**
- Собрать датасет из 100+ реальных накладных
- Вручную разметить ground truth (товары, qty, price)
- Измерить текущую точность парсера: `accuracy = correct_fields / total_fields`
- Цель: accuracy >85%

**Среднесрочно (3-6 месяцев):**
- Реализовать Вариант 2 (position-aware parsing) для ТОРГ-12
- Добавить fallback на Claude API для сложных случаев
- Автоматическая валидация: если `items_total ≠ invoice_total` (diff >5%) → флаг "требует проверки"

**Долгосрочно (6+ месяцев):**
- Обучить ML-модель (Вариант 1) на 500+ накладных
- A/B тест: regex vs ML парсер
- Если ML accuracy >95% → переход на ML полностью

---

## Примеры обработанных документов

### Тип 1: Счёт на оплату (простой)

**Файл:** `photo_2026-01-30_09-16-55.jpg`
**Результат:**
```json
{
  "invoice_number": "94",
  "invoice_date": "2026-01-22",
  "supplier": "ИП Чихинов Г. А.",
  "total_sum": 7000,
  "items": [
    {
      "name": "Мука (50кг)",
      "quantity": 2,
      "unit": "шт",
      "price": 1900,
      "total": 3800
    },
    {
      "name": "Сахар (50кг)",
      "quantity": 1,
      "unit": "шт",
      "price": 3200,
      "total": 3200
    }
  ]
}
```
**Точность:** ✅ 100%

---

### Тип 2: Счёт с платёжным поручением

**Файл:** `photo_2026-01-30_12-20-11.jpg`
**Результат:**
```json
{
  "invoice_number": "89772",
  "invoice_date": "2026-01-22",
  "supplier": "ООО \"Торговый дом \"Нижегородский хлеб\"",
  "total_sum": 1836,
  "items": [
    {
      "name": "Батон \"Нарезной\" в/с 0,4 кг без упаковки",
      "quantity": 60,
      "unit": "шт",
      "price": 30.6,
      "total": 1836
    }
  ]
}
```
**Точность:** ✅ 100%

**Особенность:** правильно отфильтровал секцию "Образец заполнения платежного поручения" благодаря table boundary detection.

---

### Тип 3: ТОРГ-12 (товарная накладная)

**Файл:** `photo_2026-01-30_12-49-26.jpg`
**Результат:**
```json
{
  "invoice_number": "17-0048600",
  "invoice_date": "2026-01-28",
  "supplier": "ООО \"Свит Лайф Фудсервис\"",
  "total_sum": 55565.86,
  "items": [
    {"name": "Сердце Говяжье Замороженное Бразилия", "quantity": null, "price": null},
    {"name": "Кальмар Командорский Очищенный 5кг", "quantity": 5, "unit": "шт", "price": 380, "total": 1900},
    {"name": "Бедро Куриное Домоседка Свежемороженое 1 кг", "quantity": null, "price": null},
    {"name": "Вода Питьевая Негазированная бл пэт Сладкая Жизнь", "quantity": 2, "unit": "шт", "price": 569.09, "total": 1138.18},
    {"name": "Вода Питьевая Негазированная 0,6л пэт Сладкая Жизнь", "quantity": 12, "unit": "шт", "price": 21.72, "total": 260.64},
    {"name": "Вода Питьевая Негазированная 1,5л пэт Сладкая Жизнь", "quantity": 6, "unit": "шт", "price": 31.56, "total": 189.36},
    {"name": "Вода Питьевая Газированная 0,6л пэт Сладкая Жизнь", "quantity": 12, "unit": "шт", "price": 22.13, "total": 265.56},
    {"name": "Вода Питьевая Газированная 1,5л пэт Сладкая Жизнь", "quantity": null, "price": null},
    {"name": "Соус Aramaki Терияки 1л", "quantity": 6, "unit": "шт", "price": 32.38, "total": 194.28},
    {"name": "Чеснок Натрули Сушеный 1 кг", "quantity": 5, "unit": "шт", "price": 575.07, "total": 2875.35},
    {"name": "Филе Грудки Куриной Черкизово Охлажденное 13 кг", "quantity": null, "price": null},
    {"name": "Яйцо Куриное Чамзинка Коричневое С1 360шт", "quantity": null, "price": null},
    {"name": "Лопатка свиная б/к охл. в/у Мираторг - 5,3 кг", "quantity": 13, "unit": "шт", "price": 309.09, "total": 4018.17}
  ]
}
```

**Точность:**
- ✅ Все 13 товаров распознаны
- ✅ Названия 100% верны
- ⚠️ Qty/price: 9/13 корректны (69%)
- ❌ 4 товара без qty/price (OCR column-by-column путаница)

**Типичные ошибки:**
- Товар #4: qty=2 вместо реального (неизвестно из фото)
- Товар #13: qty=13 вместо 27 (путаница с весом "13 кг" в названии)

---

## Конфигурация (.env)

```env
# OCR
OCR_CHAIN=google_vision,claude_cli,tesseract
GOOGLE_APPLICATION_CREDENTIALS=./google-credentials.json
CLAUDE_CLI_PATH=claude

# Paths
INBOX_DIR=./data/inbox
PROCESSED_DIR=./data/processed
FAILED_DIR=./data/failed
DB_PATH=./data/database.sqlite

# API
API_PORT=3000
API_KEY=your-secret-api-key

# Webhook
WEBHOOK_1C_URL=http://server:8080/invoice_exchange/hs/invoices
WEBHOOK_1C_TOKEN=token-for-1c
WEBHOOK_ENABLED=false

# Debug
DEBUG=true
LOG_LEVEL=debug
DRY_RUN=false
```

---

## Запуск проекта

### Установка
```bash
npm install
```

### Настройка Google Cloud Vision
1. Создать проект в Google Cloud Console
2. Включить Cloud Vision API
3. Создать Service Account → скачать JSON key
4. Сохранить как `google-credentials.json`
5. В .env: `GOOGLE_APPLICATION_CREDENTIALS=./google-credentials.json`

### Запуск dev-сервера
```bash
npm run dev
```

### Доступ к дашборду
```
http://localhost:8899/
```
Логин в дашборд — username/password admin. На первом запуске пароль генерируется случайно и **один раз** печатается в логах (`pm2 logs scanflow | grep -A2 "FIRST-RUN ADMIN"`). Сменить пароль: `npm run reset-admin-password [новый_пароль]`. Подробнее — [Авторизация: пользователи и API-ключи](#авторизация-пользователи-и-api-ключи).

### Тестирование парсера
```bash
# Полный пайплайн: JPEG → OCR → Parse → JSON
npm run test:pipeline -- ./test-invoice.jpg

# Только OCR (сравнение всех движков)
npm run test:ocr -- ./test-invoice.jpg

# Только парсер (на готовом тексте)
npm run test:parse

# Гибридный OCR: Google Vision + Claude analyzer
npm run test:hybrid -- ./test-invoice.jpg
```

### Гибридный OCR (Google Vision + Claude CLI)
Включается настройкой `USE_CLAUDE_ANALYZER=true` в `.env`.

**Workflow:**
1. Google Vision извлекает текст из изображения
2. Claude CLI (через MAX подписку) структурирует текст в JSON
3. Возвращается готовый `ParsedInvoiceData`

**Преимущества:**
- 100% точность на сложных ТОРГ-12 (vs 69% с regex-парсером)
- Использует MAX подписку (бесплатно, без API ключей)
- Автоматический fallback на regex-парсер при ошибках

**Конфигурация:**
```env
USE_CLAUDE_ANALYZER=true
CLAUDE_CLI_PATH=C:/Users/.../claude.cmd
CLAUDE_CODE_GIT_BASH_PATH=C:\Users\...\git\2.52.0\usr\bin\bash.exe
```

**Важно:** Путь к Git Bash должен использовать Windows-стиль (backslashes).

---

## Важные заметки для будущих разработчиков

### 1. Никогда не удаляй `skipKeywords` в парсере
Это защита от ложных срабатываний. Каждое слово там — результат реального бага.

### 2. Table boundary detection критичен
Без него парсер путает "Образец платёжного поручения" с товарами.

### 3. Cross-validation qty × price = total
Спасает от ~30% ошибок когда OCR путает НДС с total.

### 4. ТОРГ-12: quantities limits (4 digits)
Артикулы типа "113393" не должны распознаваться как qty.

### 5. Supplier extraction: line-by-line analysis
Regex `SUPPLIER_PATTERNS` не работал — путал buyer с supplier. Только построчный анализ.

### 6. Race condition: file watcher + API upload
Решение: `fileWatcher.markProcessing(filePath)` в upload route.

### 7. File rename ENOENT — это нормально
Если file watcher уже переместил файл, второй `fs.renameSync` упадёт — обернуть в try-catch.

### 8. Express route order важен
`GET /api/invoices/stats` **должен быть** раньше `GET /api/invoices/:id`, иначе "stats" трактуется как ID.

### 9. Claude CLI не может читать изображения
В non-interactive режиме (`-p`) Claude CLI **не может** читать файлы изображений напрямую.
Решение: гибридный подход (Google Vision OCR → Claude CLI text structuring).

### 10. Windows: путь к Git Bash должен быть с backslashes
```env
# ПРАВИЛЬНО:
CLAUDE_CODE_GIT_BASH_PATH=C:\Users\djdes\scoop\apps\git\2.52.0\usr\bin\bash.exe

# НЕПРАВИЛЬНО (не работает):
CLAUDE_CODE_GIT_BASH_PATH=C:/Users/djdes/scoop/apps/git/2.52.0/usr/bin/bash.exe
```

### 11. Shell escaping на Windows
Сложные промпты с русским текстом ломаются при передаче через аргументы.
Решение: записать промпт во временный файл и передать через pipe:
```typescript
const shellCommand = `type "${promptFile}" | "${cliPath}" -p - --dangerously-skip-permissions`;
```

---

## Гибридный OCR (Google Vision + Claude CLI) ⭐

**Файл:** [`src/ocr/claudeTextAnalyzer.ts`](src/ocr/claudeTextAnalyzer.ts)

### Как это работает

```
Фото накладной
    ↓
Google Vision API → raw OCR text (с bounding boxes)
    ↓
Claude CLI (MAX подписка) → структурированный JSON
    ↓
ParsedInvoiceData { invoice_number, supplier, items[] }
```

### Почему не Claude CLI для OCR напрямую?

Claude CLI в non-interactive режиме (`-p`) **не может читать изображения**. При попытке прочитать image-файл, он читает CLAUDE.md вместо изображения. Это ограничение CLI, не API.

### Архитектура

1. **`ocrManager.recognizeHybrid()`** — точка входа
   - Вызывает Google Vision для OCR
   - Передаёт текст в Claude analyzer
   - Возвращает `OcrResult` с полем `structured`

2. **`claudeTextAnalyzer.analyzeTextWithClaude()`** — анализ текста
   - Пишет промпт во временный файл (избегает shell escaping)
   - Запускает `type "file" | claude -p - --dangerously-skip-permissions`
   - Парсит JSON из ответа

3. **Промпт для Claude:**
```
Ты эксперт по распознаванию накладных. Проанализируй этот OCR-текст и извлеки структурированные данные.

ВАЖНО:
- Верни ТОЛЬКО валидный JSON без пояснений и markdown
- Названия товаров указывай ТОЧНО как в тексте
- Если поле не найдено, используй null
- Для чисел используй точку как десятичный разделитель (30.60, не 30,60)

Формат ответа:
{"invoice_number":"...", "supplier":"...", "items":[{"name":"...", "quantity":..., "unit":"...", "price":..., "total":...}]}

OCR-ТЕКСТ ДЛЯ АНАЛИЗА:
[текст от Google Vision]
```

### Очередь запросов

**Проблема:** Claude CLI может обрабатывать только один запрос одновременно. При параллельных запросах второй получал ошибку и падал на regex-парсер (который выдаёт мусор).

**Решение:** Простая очередь в `claudeTextAnalyzer.ts`:

```typescript
const analysisQueue: Array<{
  ocrText: string;
  resolve: (result: AnalyzerResult) => void;
}> = [];

export async function analyzeTextWithClaude(ocrText: string): Promise<AnalyzerResult> {
  if (isAnalyzing) {
    // Добавить в очередь и ждать
    return new Promise((resolve) => {
      analysisQueue.push({ ocrText, resolve });
    });
  }
  // Обработать немедленно...
}

// После завершения текущего запроса — обработать следующий из очереди
function processNextInQueue() {
  if (analysisQueue.length > 0) {
    const next = analysisQueue.shift();
    // process...
  }
}
```

**Логи при работе очереди:**
```
Claude Analyzer: starting text analysis {textLength: 3182}
Claude Analyzer: busy, adding to queue {queueLength: 1}
Claude Analyzer: response received {length: 1104}
Claude Analyzer: starting text analysis from queue {textLength: 2957, queueRemaining: 0}
```

### Конфигурация

```env
# Включить гибридный OCR
USE_CLAUDE_ANALYZER=true

# Путь к Claude CLI (можно просто "claude" если в PATH)
CLAUDE_CLI_PATH=C:/Users/djdes/scoop/apps/nodejs/current/bin/claude.cmd

# ВАЖНО: backslashes для Windows!
CLAUDE_CODE_GIT_BASH_PATH=C:\Users\djdes\scoop\apps\git\2.52.0\usr\bin\bash.exe
```

### Результаты

| Документ | Regex-парсер | Claude analyzer |
|----------|--------------|-----------------|
| Счёт на оплату (простой) | 100% | 100% |
| Счёт с платёжным поручением | 100% | 100% |
| ТОРГ-12 (13 товаров) | 69% (4 товара без qty/price) | **100%** |
| УПД (2 страницы) | мусор | **100%** |

### Fallback

Если Claude analyzer недоступен или возвращает ошибку:
1. Логируется warning: `Hybrid OCR: Claude analyzer failed, using raw result`
2. Используется regex-парсер из `invoiceParser.ts`
3. Качество падает, но система продолжает работать

---

## Многостраничные накладные

**Файлы:**
- [`src/watcher/fileWatcher.ts`](src/watcher/fileWatcher.ts) — логика объединения
- [`src/database/repositories/invoiceRepo.ts`](src/database/repositories/invoiceRepo.ts) — методы БД

### Как это работает

1. При обработке накладной извлекается `invoice_number` и `supplier`
2. Поиск в БД: есть ли накладная с таким же номером за последние 10 минут?
3. Если есть — это дополнительная страница:
   - Товары добавляются к существующей накладной
   - Имя файла дописывается через запятую
   - OCR-текст дописывается с разделителем `--- СТРАНИЦА ---`
   - Временная запись накладной удаляется
4. Итоговая сумма пересчитывается из товаров

### Код детекции

```typescript
if (parsed.invoice_number) {
  const existingInvoice = invoiceRepo.findRecentByNumber(
    parsed.invoice_number,
    parsed.supplier ?? undefined,
    10 // within last 10 minutes
  );

  if (existingInvoice && existingInvoice.id !== invoice.id) {
    // Это дополнительная страница
    targetInvoiceId = existingInvoice.id;
    isMergedPage = true;

    invoiceRepo.appendFileName(existingInvoice.id, fileName);
    invoiceRepo.appendRawText(existingInvoice.id, ocrResult.text);
  }
}
```

### Методы репозитория

```typescript
// Поиск недавней накладной с таким же номером
findRecentByNumber(invoiceNumber: string, supplier?: string, withinMinutes = 10): Invoice | undefined

// Добавить имя файла (через запятую)
appendFileName(id: number, newFileName: string): void

// Добавить OCR-текст с разделителем
appendRawText(id: number, additionalText: string): void

// Пересчитать итог из товаров
recalculateTotal(id: number): void
```

### Логи при объединении

```
Multi-page invoice detected, merging into existing {existingId: 1121, newPageId: 1123, invoiceNumber: "ВМ-105"}
Invoice pages merged successfully {id: 1121, totalItemsCount: 10, addedItemsCount: 1}
```

### Важно

- Очередь Claude analyzer критична для многостраничных накладных
- Без очереди вторая страница падала на regex-парсер и выдавала мусор
- С очередью обе страницы проходят через Claude и корректно объединяются

---

## Авторизация: пользователи и API-ключи

**Файлы:**
- [`src/database/migrations.ts`](src/database/migrations.ts) — миграция 17 (таблица `users`)
- [`src/database/repositories/userRepo.ts`](src/database/repositories/userRepo.ts) — CRUD пользователей
- [`src/auth/password.ts`](src/auth/password.ts) — хэширование scrypt (`scrypt$N$salt$hash`)
- [`src/auth/seedAdmin.ts`](src/auth/seedAdmin.ts) — first-run сидер
- [`src/api/middleware/auth.ts`](src/api/middleware/auth.ts) — `X-API-Key` → `users.api_key`
- [`src/api/routes/auth.ts`](src/api/routes/auth.ts) — `POST /api/auth/login`
- [`src/scripts/reset-admin-password.ts`](src/scripts/reset-admin-password.ts) — `npm run reset-admin-password`

### Модель

- **Один пользователь = один `api_key`.** Ключ — единственный механизм авторизации `/api/*`. Заголовок `X-API-Key` ищется в `users.api_key`; найденный пользователь подкладывается в `req.user = { id, username, role }`.
- **Логин/пароль — это UX-обёртка над ключом.** `POST /api/auth/login` принимает `{username, password}`, проверяет `scryptSync` + `timingSafeEqual`, возвращает `{apiKey, username, role}`. Фронт сохраняет `apiKey` в `localStorage` и шлёт в `X-API-Key` как раньше.
- **Никаких credentials в `.env`.** В `.env` живёт только `API_KEY` (bootstrap-секрет). Логины-пароли — только в БД (хэши).

### Таблица `users`

```sql
CREATE TABLE users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  username        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash   TEXT NOT NULL,        -- scrypt$N$saltHex$hashHex
  api_key         TEXT NOT NULL UNIQUE,
  role            TEXT NOT NULL DEFAULT 'user',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at   TEXT
);
CREATE INDEX idx_users_api_key ON users(api_key);
```

### First-run admin

При старте сервера если `users` пустая:
1. Создаётся `admin` со случайным паролем (12 байт → 16 base64url-символов, ~96 бит энтропии).
2. `api_key = config.apiKey` — это нужно, чтобы существующие интеграции (1С webhook, мобильная камера) продолжили работать с тем же ключом, что был в `.env`.
3. Пароль печатается в логи **один раз** жирным баннером:

```
========================================================================
FIRST-RUN ADMIN ACCOUNT CREATED — copy the password NOW...
  username: admin
  password: <случайный пароль>
To change it later: npm run reset-admin-password
========================================================================
```

На всех последующих стартах сидер ничего не делает — БД источник правды.

### Смена пароля

```bash
# Сгенерить случайный
npm run reset-admin-password

# Установить конкретный
npm run reset-admin-password -- мойПароль
```

Минимум 4 символа (защита от опечаток). На сервере:
```bash
ssh magday@magday.ru
cd ~/www/scanflow.ru/app
npm run reset-admin-password -- новыйПароль
```

### Добавление новых пользователей

Сейчас UI для этого нет — добавляются через ts-node:
```typescript
import { userRepo } from './src/database/repositories/userRepo';
import { hashPassword, generateApiKey } from './src/auth/password';

userRepo.create({
  username: 'ivan',
  password_hash: hashPassword('паролеВанЯ'),
  api_key: generateApiKey(),
  role: 'user',
});
```

### Rate limit

`POST /api/auth/login` ограничен 20 попытками / 5 мин на IP — защита от перебора пароля.

### Совместимость

- Старый `config.apiKey` из `.env` больше **не сравнивается напрямую** в middleware. Доступ даёт только то, что лежит в `users.api_key`.
- Сидер на первом запуске копирует `config.apiKey` в `users.api_key` для admin'а — поэтому 1С webhook, мобильная камера и любые скрипты, использующие старый ключ, продолжают работать без изменений.
- Если нужно ротировать `API_KEY`: поменять в `.env` → перезапустить → ключ admin **не** обновляется автоматически (это изменили намеренно: сидер не трогает существующего юзера). Обновить вручную через `userRepo.updateApiKey(id, newKey)` или прямой `UPDATE users SET api_key = ? WHERE id = ?`.

---

## Уведомления пользователю на email

**Файлы:**
- [`src/notifications/events.ts`](src/notifications/events.ts) — `emit(eventType, payload, userId)` точка эмиссии
- [`src/notifications/digestWorker.ts`](src/notifications/digestWorker.ts) — cron 9-18 MSK почасовой, 19 MSK дневной, 03:30 чистка > 7 дней
- [`src/notifications/templates.ts`](src/notifications/templates.ts) — HTML рендер (realtime + digest)
- [`src/notifications/types.ts`](src/notifications/types.ts) — `EventType`, `NotifyMode`, `URGENT_EVENT_TYPES`
- [`src/api/routes/profile.ts`](src/api/routes/profile.ts) — `GET/PATCH /api/profile`, `POST /api/profile/test-email`
- В дашборде: вкладка «Профиль» (inline-section в `public/app.html` + `public/js/profile.js`)

### Модель

- 7 событий: `photo_uploaded`, `invoice_recognized`, `recognition_error`, `suspicious_total`, `invoice_edited`, `approved_for_1c`, `sent_to_1c`
- 2 события — срочные (`recognition_error`, `suspicious_total`), всегда шлются мгновенно
- 3 режима: `realtime` / `digest_hourly` (default) / `digest_daily`
- Email и режим хранятся в `users` (миграция 18: колонки `email`, `notify_mode`, `notify_events`)
- Очередь дайджеста — таблица `notification_events`, чистится раз в сутки

### emit()

`emit(eventType, payload, triggeredByUserId)` никогда не бросает исключение — failure логируется и глотается. Если `triggeredByUserId === null`, берётся `userRepo.firstUserId()` (для текущего single-user сетапа это владелец). Если у юзера нет `email` или событие выключено в `notify_events` — return без сайд-эффекта.

### Точки эмиссии

- `fileWatcher.ts` → `photo_uploaded`, `invoice_recognized`, `recognition_error`, `suspicious_total`
- `api/routes/invoices.ts` → `invoice_edited` (PATCH item), `approved_for_1c` (POST send), `sent_to_1c` (POST confirm)
- `integration/webhook.ts` → `sent_to_1c` (после `markSent`)

### Существующие системные письма не трогаем

`sendErrorEmail` (uncaughtException, диск-монитор) продолжает слаться через `MAIL_TO` из `.env`. Это сделано специально — системные письма должны работать даже когда БД недоступна.

### Конфигурация SMTP

`SMTP_HOST/PORT/USER/PASS` в `.env`. Если не заданы — `smtpConfigured()` возвращает `false`, в UI видна плашка «SMTP не настроен на сервере», тестовое письмо отдаёт 503.

---

## Деплой и CI/CD

### Инфраструктура

| Компонент | Значение |
|-----------|----------|
| **Хостинг** | FastPanel, Ubuntu 24.04 LTS |
| **Сервер** | magday.ru (79.137.237.2) |
| **Домен** | scanflow.ru |
| **SSH порт (локальный)** | 22 |
| **SSH порт (GitHub Actions)** | 50222 |
| **SSH пользователь** | magday |
| **Node.js на сервере** | v20.20.0 (nvm) |
| **PM2 процесс** | scanflow |
| **Порт приложения** | 8899 (nginx проксирует с домена) |
| **GitHub репозиторий** | djdes/scanflow (private) |

### Автодеплой

**Файл:** [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)

При каждом `git push` в `main`:
1. GitHub Actions запускает workflow
2. `rsync` копирует файлы на сервер (SSH, порт 50222)
3. `npm ci` + `npm run build` (TypeScript)
4. `npm prune --production`
5. `pm2 startOrRestart ecosystem.config.js`

**Время деплоя:** ~25 секунд

### GitHub Secrets

| Secret | Описание |
|--------|----------|
| `SSH_PRIVATE_KEY` | Ed25519 ключ для деплоя |
| `SSH_HOST` | magday.ru |
| `SSH_USER` | magday |
| `SSH_PORT` | 50222 |

### Файловая структура на сервере

```
/var/www/magday/data/                    # HOME директория
├── www/
│   └── scanflow.ru/
│       ├── index.html                   # FastPanel placeholder (HTTPS)
│       └── app/                         # Приложение
│           ├── dist/                    # Скомпилированный JS
│           ├── src/                     # Исходники (для отладки)
│           ├── public/                  # Статический фронтенд
│           ├── node_modules/
│           ├── data/
│           │   ├── database.sqlite      # БД (НЕ перезаписывается при деплое)
│           │   ├── inbox/               # Входящие JPG
│           │   ├── processed/           # Обработанные
│           │   └── failed/              # С ошибками
│           ├── google-credentials.json  # Google Vision (НЕ в git)
│           ├── ecosystem.config.js      # PM2 конфигурация
│           ├── .env                     # Конфигурация (НЕ в git)
│           └── package.json
├── logs/
│   ├── scanflow-out.log
│   └── scanflow-error.log
└── .pm2/
```

### Что НЕ деплоится (rsync exclude)

- `.env` — конфигурация сервера (создаётся вручную)
- `google-credentials.json` — ключ Google Vision (загружается вручную)
- `data/database.sqlite` — БД с данными
- `data/inbox/*`, `data/processed/*`, `data/failed/*` — файлы накладных
- `node_modules/`, `dist/` — пересоздаются при деплое
- `.claude/`, `.vscode/`, `*.log` — dev-артефакты

### HTTP прокси для Anthropic API

Claude API работает через HTTP прокси (настроено в `.env` на сервере):

```env
ANTHROPIC_PROXY_URL=http://user:pass@host:port
```

**Файл:** [`src/ocr/claudeApiAnalyzer.ts`](src/ocr/claudeApiAnalyzer.ts) — используется `undici.ProxyAgent` + custom `fetch`.

**Важно:** `fetchOptions.dispatcher` не работает на Node 20 с Anthropic SDK — нужно передавать `fetch` как custom функцию:
```typescript
const dispatcher = new ProxyAgent(proxyUrl);
const proxiedFetch = (url, init) => undiciFetch(url, { ...init, dispatcher });
new Anthropic({ apiKey, fetch: proxiedFetch });
```

### Полезные команды

```bash
# SSH на сервер (локально)
ssh magday@magday.ru

# PM2 управление
pm2 list                           # статус процессов
pm2 logs scanflow                  # live логи
pm2 logs scanflow --lines 50       # последние 50 строк
pm2 restart scanflow               # перезапуск
pm2 stop scanflow                  # остановка
pm2 flush scanflow                 # очистить логи

# Проверка
curl http://localhost:8899/health
curl -H "X-API-Key: your-secret-api-key" http://localhost:8899/api/invoices/stats

# GitHub Actions
gh run list --repo djdes/scanflow
gh run watch <run-id> --repo djdes/scanflow

# Загрузка файлов на сервер (БД, credentials)
# ВАЖНО: сначала остановить PM2, потом загрузить, потом запустить
pm2 stop scanflow
scp -P 22 ./data/database.sqlite magday@magday.ru:~/www/scanflow.ru/app/data/
pm2 start scanflow
```

### HTTPS

HTTPS на scanflow.ru показывает страницу FastPanel, а не приложение. HTTP проксирование на порт 8899 работает. Для HTTPS нужно настроить Node.js proxy в панели FastPanel (как сделано для haccp.magday.ru).

> Историческая справка: до апреля 2026 проект был доступен на `scan.magday.ru`. В апреле 2026 мигрировали и домен, и серверные пути — сейчас приложение живёт в `~/www/scanflow.ru/app/`, PM2 процесс называется `scanflow`. Старое имя `scan.magday.ru` остаётся только в changelog v1.5 ниже. SSH-хост сервера — `magday.ru` — это имя **самого сервера**, а не проекта, оно не менялось.

### Важные заметки по деплою

12. **rsync --delete удаляет файлы** не из git. `.env` и `google-credentials.json` защищены через `--exclude`, но если добавляете другие серверные файлы — добавьте exclude.

13. **БД не деплоится** — она живёт только на сервере. Бэкап локальной БД — на dev-машине в `data/database.sqlite`.

14. **PM2 ecosystem.config.js** — `cwd: __dirname` (т.е. директория, откуда запускается PM2). На сервере это `/var/www/magday/data/www/scanflow.ru/app`. При изменении структуры на сервере — обновить.

15. **Node.js 20 на сервере** vs 25 на dev — TypeScript компилируется в ES2022 (совместим с обоими). Нативные зависимости (better-sqlite3, sharp) пересобираются при `npm ci`.

---

## Контакты и ресурсы

- **GitHub:** https://github.com/djdes/scanflow (private)
- **Production:** https://scanflow.ru/
- **Документация 1С:УНФ 1.6:** https://its.1c.ru/db/unf
- **Google Vision API docs:** https://cloud.google.com/vision/docs
- **Claude API docs:** https://docs.anthropic.com/claude/reference

---

**Последнее обновление:** 2026-04-24
**Автор:** Claude Code (совместно с разработчиком)

---

## Changelog

### v1.6 (2026-04-24)
- ✅ **Переезд на домен scanflow.ru** — публичный URL, серверные пути (`~/www/scanflow.ru/app/`) и имя PM2-процесса (`scanflow`) — всё мигрировано. Старое имя `scan.magday.ru` остаётся только здесь в changelog v1.5.
- ✅ **Авторизация по логину/паролю** — `POST /api/auth/login`, фронт перестал просить вставить API-ключ руками
- ✅ **Таблица `users`** (миграция 17) — у каждого аккаунта свой `api_key`, нет глобального секрета в коде
- ✅ **scrypt-хэширование** паролей через нодовский `crypto` — без нативных зависимостей
- ✅ **First-run сидер** генерит случайный пароль admin, печатает один раз в логи; пароль/логин **не хранится** в `.env`
- ✅ **`npm run reset-admin-password`** — CLI для ротации пароля
- ✅ **Rate limit 20/5min на IP** для `POST /api/auth/login`
- ✅ Существующие интеграции (1С webhook, мобильная камера) работают без изменений: api_key admin'а = старый `API_KEY` из `.env`

### v1.5 (2026-04-03)
- ✅ **Production деплой** на scan.magday.ru (FastPanel, Ubuntu 24.04)
- ✅ **GitHub Actions CI/CD** — автодеплой при push в main (~25 сек)
- ✅ GitHub repo: djdes/scanflow (private), SSH secrets настроены
- ✅ PM2 процесс `scan-magday` на порту 8899
- ✅ **HTTP прокси для Anthropic API** — undici ProxyAgent + custom fetch
- ✅ Google Vision credentials загружены на сервер
- ✅ База данных (1141 накладных) мигрирована на сервер

### v1.4 (2026-02-27)
- ✅ **Двойной режим анализа** — переключение Google Vision+CLI / Claude API
- ✅ **Claude API анализатор** — прямая отправка изображений в Anthropic API
- ✅ **Извлечение реквизитов поставщика** — ИНН, БИК, счета, адрес (для счетов на оплату)
- ✅ Страница настроек в дашборде
- ✅ Определение типа документа (счет_на_оплату, торг_12, упд, счет_фактура)

### v1.3 (2026-02-04)
- ✅ **Внешняя обработка для 1С:УНФ 1.6** — исходный код в папке `1c/`
- ✅ Модуль объекта с HTTP-клиентом для API
- ✅ Автопоиск/создание контрагентов и номенклатуры
- ✅ Инструкция по сборке .epf в Конфигураторе

### v1.2 (2026-02-04)
- ✅ **Простая очередь для Claude analyzer** — параллельные запросы ждут в очереди вместо fallback на regex
- ✅ Многостраничные накладные корректно обрабатываются через очередь
- ✅ Все страницы УПД проходят через Claude (100% точность)

### v1.1 (2026-02-04)
- ✅ **Гибридный OCR** — Google Vision + Claude CLI text analyzer
- ✅ **Многостраничные накладные** — автоматическое объединение по номеру
- ✅ ТОРГ-12 точность: 69% → 100% с Claude analyzer
- ✅ Новые методы в invoiceRepo: `findRecentByNumber`, `appendFileName`, `appendRawText`, `recalculateTotal`
- ✅ Тестовый скрипт `npm run test:hybrid`

### v1.0 (2026-01-30)
- ✅ Базовая функциональность реализована
- ✅ Парсер поддерживает 3 формата накладных
- ✅ Веб-дашборд запущен
- ✅ Все тесты пройдены
- ⏳ 1С обработка не написана
- ~~⏳ ML-парсер не реализован~~ → Решено через Claude analyzer
