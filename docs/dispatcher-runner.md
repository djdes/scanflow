# Dispatcher Runner

Гайд по запуску диспетчера, который обрабатывает ScanFlow OCR-задачи через ProjectsFlow + Claude Code Max-подписку.

## Зачем

`analyzer_config.mode = 'dispatcher'` направляет каждое распознавание фото-накладной в ProjectsFlow как задачу с YAML-описанием. Запущенная Claude Code сессия с активной Max-подпиской подбирает задачи и обрабатывает их — Anthropic-токены не тратятся (Max — flat-rate).

## Что нужно один раз настроить

1. **На сервере ScanFlow** в `.env`:
   ```
   PROJECTSFLOW_API_URL=https://projectsflow.ru/api
   PROJECTSFLOW_AGENT_TOKEN=pfat_<ваш-токен>
   PROJECTSFLOW_SCANFLOW_PROJECT_ID=55d1d6c5-0f0f-4ece-9d5a-cdf419e52c85
   PUBLIC_BASE_URL=https://scanflow.ru
   ```

2. **В админке ScanFlow** (`/#/settings`) — выбрать **«Диспетчер (через ProjectsFlow)»** и сохранить.

## Как запустить диспетчер

1. Откройте Claude Code (Max-подписка) в любой папке (рекомендую `C:\www\ProjectsFlow`, чтобы был доступ к MCP `projectsflow` без лишних настроек).

2. Вставьте промпт-инструкцию ниже целиком первым сообщением. Claude далее работает сам:

---

### Промпт диспетчера (копировать как есть)

> Ты — dispatcher для ScanFlow. Каждую минуту:
>
> 1. Через MCP `mcp__projectsflow__pf_list_tasks` получи задачи проекта `Scanflow` (project_id `55d1d6c5-0f0f-4ece-9d5a-cdf419e52c85`) в статусе `backlog` или `todo`.
>
> 2. Для каждой задачи, чьё `description` начинается с YAML-блока `type: scanflow_ocr`:
>    - Распарси YAML — там `invoice_id`, `photo_url`, `callback_url`, `token`.
>    - **Скачай фото** через `WebFetch` или `fetch(photo_url)` (это HTTPS со встроенным токеном — без X-API-Key).
>    - **Прогони фото** через свою vision-способность с промптом для русских товарных накладных (см. ниже).
>    - **POST на `callback_url`** с телом:
>      ```json
>      {"token":"<тот же token из задачи>","success":true,"data":<распарсенный JSON>}
>      ```
>      При неудаче парсинга:
>      ```json
>      {"token":"<token>","success":false,"error":"описание проблемы"}
>      ```
>    - Помечай PF-задачу как `done` через `mcp__projectsflow__pf_update_task` с `status: 'done'`.
>
> 3. После прохода спи 60 секунд и повторяй.
>
> Если задач нет — лог «no pending scanflow tasks» и продолжай цикл.
>
> **Формат JSON-ответа** (схема `ParsedInvoiceData` из ScanFlow):
> ```json
> {
>   "invoice_type": "счет_на_оплату|торг_12|упд|счет_фактура",
>   "invoice_number": "...",
>   "invoice_date": "YYYY-MM-DD",
>   "supplier": "...",
>   "supplier_inn": "...",
>   "supplier_bik": "...",
>   "supplier_account": "...",
>   "supplier_corr_account": "...",
>   "supplier_address": "...",
>   "total_sum": число,
>   "vat_sum": число,
>   "items": [
>     {"name":"...","quantity":число,"unit":"шт|кг|л","price":число,"total":число,"vat_rate":число,"row_no":число,"pack_size":число_или_null}
>   ]
> }
> ```
>
> **Промпт для распознавания** — используй полный из репозитория ScanFlow по пути `src/ocr/claudeApiAnalyzer.ts:buildPrompt()`. Он содержит правила парсинга ТОРГ-12 / УПД / счёт-фактур, обработку упаковок (1/12, ×48), кросс-валидацию qty×price≈total, и работу с многостраничными накладными. Если у тебя нет доступа к репо — суть промпта: «извлеки JSON по схеме выше из фото русской товарной накладной, поле price = total/quantity (с НДС), name сохраняет упаковочные подсказки типа "1/12", "*48", "5кг"».
>
> Старт.

---

### Что Claude будет делать

После вставки промпта Claude:
- запросит MCP-инструменты `pf_list_tasks` / `pf_update_task`
- начнёт цикл
- для каждой найденной задачи `type: scanflow_ocr` — скачает фото, распознает, отправит callback, закроет задачу

Latency: ~30-60 сек на накладную (queue check + OCR + callback). Для 50/день этого достаточно.

## Что происходит если диспетчер выключен

ScanFlow продолжит ставить задачи в ProjectsFlow. Каждая накладная висит со status='ocr_processing'. Через **15 минут** cron-sweep (`markStaleDispatchersAsFailed`) пометит её как error со словом «Dispatcher timeout». Когда вы вернёте диспетчер — новые накладные снова пойдут в очередь.

## Что происходит если ScanFlow перезапустился пока диспетчер работал

PF-задачи никуда не делись — диспетчер подберёт их на следующем цикле. Token хранится в `invoices.dispatcher_token`, поэтому callback после рестарта всё равно валидируется правильно.

## Отладка

- **Все ли задачи создаются:** `SELECT id, dispatcher_task_id, dispatcher_started_at, status FROM invoices ORDER BY id DESC LIMIT 10;`
- **Callback validation lost:** в ScanFlow логах ищите `dispatcher photo: token invalid` или `dispatcher result: token invalid`.
- **Timeout sweep сработал:** `grep "Dispatcher timeout" logs/...` или `error_message` в `invoices` начинается с «Dispatcher timeout».
- **Тест с одной накладной**: на локалке загрузите фото через UI, проверьте что `invoices.dispatcher_task_id` появилось, потом откройте Claude Code и вставьте промпт — должно пройти в течение минуты.

## Не делаем (YAGNI)

- Несколько dispatcher-сессий параллельно (одной достаточно, плюс race на claim в MCP — отдельная история)
- Webhook from PF to ScanFlow когда задача готова (вместо этого dispatcher делает callback сам)
- Retry-логика в самом dispatcher'е — если Claude Code сессия упала, юзер заметит и перезапустит вручную
