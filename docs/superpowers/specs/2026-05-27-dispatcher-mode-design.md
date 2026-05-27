# Dispatcher Mode — Design

**Status:** draft (awaiting user approval)
**Author:** Claude (с пользователем)
**Date:** 2026-05-27

## Проблема

При объёме 50+ накладных/день pay-per-token Anthropic API ($0.05-0.15 за фото) превращается в $3-6/день. Claude Code Max-подписка (~$200/мес = $7/день) даёт безлимитный доступ — но через CLI/MCP, а не REST. Нужен способ направить ScanFlow-распознавание через Max вместо API.

## Решение

Третий режим обработки `dispatcher` в `analyzer_config.mode`. При его выборе ScanFlow не вызывает Claude API напрямую — создаёт задачу в ProjectsFlow с фото-URL + callback-URL + токеном. Пользователь запускает Claude Code сессию (внутри активная Max-подписка), которая через MCP подбирает задачи, читает фото, прогоняет через Claude (этой же сессии), и POST'ит результат обратно в ScanFlow.

```
ScanFlow upload (mode=dispatcher)
   │
   ▼
INSERT invoice (status='ocr_processing', dispatcher_token=<32 byte hex>, dispatcher_started_at=NOW())
   │
   ▼
POST https://projectsflow.ru/api/agent/projects/<scanflow-uuid>/tasks
   body.description = YAML-блок с invoice_id, photo_url, callback_url, token
   header.Authorization = Bearer pfat_*
   │
   ▼
ProjectsFlow holds task in queue (Kanban: status=backlog)

[Claude Code session, opened manually by user in C:/www/ProjectsFlow]
   loop:
     • pf_list_tasks(project=scanflow, status=backlog) → find scanflow-tasks
     • for each task with «scanflow_ocr» marker:
         - parse YAML from description → {invoice_id, photo_url, callback_url, token}
         - GET photo_url (returns JPG)
         - Claude (this session) reads image → invoice JSON
         - POST callback_url body={token, success:true, data:<parsed>}
         - pf_update_task(taskId, status='done')

ScanFlow callback handler:
   validates token === invoices.dispatcher_token
   on success → write invoice header + items, run mapper, status='processed'
   on error   → status='error', error_message
   clear dispatcher_token / dispatcher_started_at
```

## Архитектурные решения (согласовано с пользователем)

| Развилка | Выбор |
|---|---|
| Photo delivery | signed-URL `GET /api/invoices/:id/photo?token=<hex>` |
| Result delivery | HTTP POST `POST /api/invoices/:id/dispatcher-result` |
| Auth | per-task one-time token (32 байт hex, хранится в invoices) |
| Timeout | auto-recovery: status='error' если `dispatcher_started_at < NOW() - 15 min` |
| Dispatcher где запускается | вручную пользователем в Claude Code сессии |
| Промпт | переиспользуем существующий из `claudeApiAnalyzer.ts:buildPrompt()` (well-tuned, не дублируем) |
| Объём оправдывает | да, 50+ накладных в день |

## Компоненты

### Schema — миграция 25

`invoices` — три новых nullable колонки:
- `dispatcher_task_id VARCHAR(64) NULL` — task UUID в ProjectsFlow
- `dispatcher_token CHAR(64) NULL` — hex token для callback auth
- `dispatcher_started_at DATETIME NULL` — для timeout sweep

Plus index `(dispatcher_started_at)` для cron-recovery.

`analyzer_config.mode` уже VARCHAR — добавляется значение `dispatcher` без миграции.

### `src/config.ts` — env vars

Новые поля:
```ts
projectsflowApiUrl: envStr('PROJECTSFLOW_API_URL', 'https://projectsflow.ru/api'),
projectsflowToken: envStr('PROJECTSFLOW_AGENT_TOKEN', ''),
projectsflowProjectId: envStr('PROJECTSFLOW_SCANFLOW_PROJECT_ID', '55d1d6c5-0f0f-4ece-9d5a-cdf419e52c85'),
publicBaseUrl: envStr('PUBLIC_BASE_URL', 'https://scanflow.ru'),
```

`publicBaseUrl` нужен чтобы dispatcher знал куда грузить фото и куда callback'ить. На локалке `http://localhost:8899`, на проде `https://scanflow.ru`.

### `src/dispatcher/createTask.ts` (новый)

Функция `dispatchInvoice(invoiceId, photoPath)`:
1. Generate token `crypto.randomBytes(32).toString('hex')`
2. UPDATE invoices SET dispatcher_token=?, dispatcher_started_at=NOW() WHERE id=?
3. Build task description (YAML block, см. ниже)
4. POST `${apiUrl}/agent/projects/${projectId}/tasks` с Bearer token
5. UPDATE invoices SET dispatcher_task_id = <returned id>
6. Return — ScanFlow дальше ждёт callback

Description формат:
```yaml
type: scanflow_ocr
invoice_id: 29
photo_url: https://scanflow.ru/api/invoices/29/photo?token=<hex>
callback_url: https://scanflow.ru/api/invoices/29/dispatcher-result
token: <hex>
expected_format: invoice_json
```

Plus текст-инструкция ниже для дочери-Claude, объясняет что делать (markdown).

### Routes — два новых endpoint'а

**`GET /api/invoices/:id/photo`** ([src/api/routes/invoices.ts](../../src/api/routes/invoices.ts))
- Auth: НЕ по X-API-Key (он у диспетчера не должен быть). Auth: `?token=` query param совпадает с `invoices.dispatcher_token`
- Если invoice не найдена / token не совпадает / `dispatcher_token IS NULL` → 401
- Иначе stream JPG из `invoices.file_path` с правильным Content-Type
- Rate limit: 10 req/min per IP (если dispatcher куда-то залип)

**`POST /api/invoices/:id/dispatcher-result`** ([src/api/routes/invoices.ts](../../src/api/routes/invoices.ts))
- Auth: token в body совпадает с `invoices.dispatcher_token`
- Body schema:
  ```ts
  { token: string, success: boolean, data?: ParsedInvoiceData, error?: string }
  ```
- На success:
  - Validate `data` (basic shape: items array, supplier/number/date optional)
  - UPDATE invoices с supplier/number/date/totals
  - INSERT invoice_items по `data.items`
  - Запустить nomenclature mapper (как обычный OCR flow делает)
  - status='processed', clear dispatcher_token+started_at
  - Trigger price-stats recompute hook (уже автоматом по addItem)
- На error: status='error', error_message=data.error, clear dispatcher fields

### File watcher dispatch (`src/watcher/fileWatcher.ts`)

В `processFile` где сейчас branch `if (analyzerConfig.mode === 'claude_api')`:
- Добавить branch `else if (analyzerConfig.mode === 'dispatcher')`:
  - Call `dispatchInvoice(invoice.id, processedPath)`
  - Return — no further OCR processing in this code path

### Timeout sweep (`src/utils/staleRecovery.ts` или новый файл)

Существующий `markStaleAsFailed` (упомянут в моей memory) расширить или создать отдельный:
- Раз в 5 минут: `SELECT id FROM invoices WHERE status='ocr_processing' AND dispatcher_started_at < NOW() - INTERVAL 15 MINUTE`
- Для каждой: status='error', error_message='Dispatcher timeout (>15 min)', clear dispatcher fields

### Frontend (`/#/settings`)

Существующая dropdown «Режим OCR» имеет два варианта: `claude_api`, `hybrid`. Добавляется третий: `dispatcher` с подсказкой:

> «Диспетчер — задачи отправляются в ProjectsFlow, обрабатываются вашей Claude Code сессией с Max-подпиской. Требует активную сессию-обработчик. Подробнее: docs/dispatcher-runner.md»

### Документация (`docs/dispatcher-runner.md`)

Шаги для пользователя:
1. Открыть Claude Code в `C:\www\ProjectsFlow`
2. Вставить промпт-инструкцию (Claude знает что делать: получает задачи проекта Scanflow, для каждой парсит description, скачивает фото, OCRит, делает callback)
3. Сессия работает пока открыта; задачи в очереди не теряются — после рестарта подхватятся снова

## Edge cases

| Случай | Поведение |
|---|---|
| Dispatcher offline (не работает Claude Code) | invoices застывают `ocr_processing` → через 15 мин cron помечает error |
| Dispatcher вернул невалидный JSON | callback handler возвращает 400, invoice остаётся в `ocr_processing` → еще 15 мин → error. Можно улучшить: dispatcher должен помечать PF task `'failed'` и пробовать снова. |
| Token в callback не совпадает | 401, лог в `logger.warn` |
| Photo URL вызван второй раз с тем же token | OK, отдаём JPG (idempotent) |
| ProjectsFlow API недоступен при создании задачи | `dispatchInvoice` бросает — invoice остаётся `new`, watcher переотправит при следующем рестарте через `recoverStuckProcessing` |
| Двойной callback на одну invoice (dispatcher retry) | проверка: если `dispatcher_token IS NULL` уже (значит processed), вернуть 409 |
| invoice удалена пока в `ocr_processing` | callback придёт на удалённую — 404 |

## Не делаем (YAGNI)

- Multi-tenancy (один dispatcher на инсталляцию)
- Retry-инфра в самом dispatcher'е (Claude Code сессия сама умеет ретраить)
- Webhook от ProjectsFlow обратно в ScanFlow (поллинг ScanFlow'ом не нужен — dispatcher делает callback)
- Distinct PF agent_job vs task — используем обычный task (description field вместимо)

## Open questions

Все основные — решены. Перед кодом нужно подтвердить:
1. PUBLIC_BASE_URL на проде = `https://scanflow.ru`? (предполагаю да)
2. ProjectsFlow Scanflow project ID = `55d1d6c5-0f0f-4ece-9d5a-cdf419e52c85` (из моей предыдущей сессии — нашёл через `pf_list_projects`). Подтверждаете?
3. Чей PFAT-токен использует ScanFlow? Берём один и тот же что у моего Claude Code (`pfat_9573...`) — это OK или сделать отдельный для серверного процесса?
