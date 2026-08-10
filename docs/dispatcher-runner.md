# Dispatcher Runner

Гайд по запуску диспетчера, который обрабатывает ScanFlow OCR-задачи через ProjectsFlow + Claude Code Max-подписку.

## Зачем

`analyzer_config.mode = 'dispatcher'` направляет каждое распознавание фото-накладной в ProjectsFlow как **невидимый AI-job** (`mode: assistant`) с YAML-инструкцией. Запущенная Claude Code сессия с активной Max-подпиской подбирает job'ы и обрабатывает их — Anthropic-токены не тратятся (Max — flat-rate).

Карточек на доске Scanflow эта очередь не создаёт (раньше создавала — доска забивалась служебными задачами). Цикл: `pending → claim → complete`, терминальные записи сервер чистит через 7 дней.

## Что нужно один раз настроить

В админке ScanFlow (`/#/settings`):
1. Выбрать режим **«Диспетчер (через ProjectsFlow)»**.
2. Вставить `pfat_*` токен (Agent token из ProjectsFlow) в поле «ProjectsFlow agent token».
3. Сохранить.

Опционально на сервере в `.env` можно переопределить дефолты:
```
PUBLIC_BASE_URL=https://scanflow.ru                                           # куда dispatcher шлёт callback
PROJECTSFLOW_API_URL=https://projectsflow.ru/api                              # API-эндпоинт ProjectsFlow
PROJECTSFLOW_SCANFLOW_PROJECT_ID=55d1d6c5-0f0f-4ece-9d5a-cdf419e52c85          # ID проекта Scanflow в PF
```
Эти три обычно не нужно менять. Токен `PROJECTSFLOW_AGENT_TOKEN` env — fallback на случай если в БД ничего нет; UI имеет приоритет.

## Как запустить диспетчер

1. Откройте Claude Code (Max-подписка) в любой папке (рекомендую `C:\www\ProjectsFlow`, чтобы был доступ к MCP `projectsflow` без лишних настроек).

2. Вставьте промпт-инструкцию ниже целиком первым сообщением. Claude далее работает сам:

---

### Промпт диспетчера (копировать как есть)

> Ты — dispatcher для ScanFlow. Каждую минуту:
>
> 1. Через MCP `mcp__projectsflow__pf_list_pending_ai_prompt_jobs` получи очередь. Бери
>    ТОЛЬКО job'ы с `mode: assistant` и `projectId` проекта ScanFlow
>    (`82a0e598-fce2-4948-b653-ceb64d132fe2` — сверь со значением в `/#/settings → Диспетчер`)
>    — остальные (`improve`, `compose`, чужие проекты) не трогай.
>    Свой job забирай через `mcp__projectsflow__pf_claim_ai_prompt_job {jobId}`; в ответе
>    `inputText` — готовая самодостаточная инструкция. Ответ 409
>    `ai_prompt_job_already_claimed` = job забрал кто-то другой, иди дальше.
>
> 2. Обрабатывай job'ы ДВУХ типов (смотри YAML-поле `type` в начале `inputText`):
>    **`type: scanflow_ocr`** — распознавание товарной накладной, и
>    **`type: scanflow_supplier_requisites`** — распознавание реквизитов поставщика
>    (со счёта/платёжки/накладной, для страницы «Поставщики»).
>    Для любого из них следуй шагам, описанным В САМОМ JOB'Е (`inputText`), они
>    самодостаточны. Общий алгоритм:
>    - Распарси YAML из `inputText` — там `photo_url`, `callback_url`, `prompt_url`, `token`
>      (+ `invoice_id` или `job_id`).
>    - **Скачай документ** из `photo_url` (HTTPS со встроенным токеном, без X-API-Key).
>      Это может быть фото ИЛИ PDF — `scanflow_supplier_requisites` принимает оба.
>    - **Скачай промпт** из `prompt_url` (plain text) и примени его к документу.
>      У каждого типа свой промпт: `/prompt` для накладных, `/prompt-supplier` для реквизитов.
>    - **POST на `callback_url`** с телом:
>      ```json
>      {"token":"<тот же token из задачи>","success":true,"data":<распарсенный JSON>}
>      ```
>      При неудаче парсинга:
>      ```json
>      {"token":"<token>","success":false,"error":"описание проблемы"}
>      ```
>    - Завершай job через `mcp__projectsflow__pf_complete_ai_prompt_job` с
>      `{jobId, ok: true, improvedText: "recognized"}`. На неудачу —
>      `{jobId, ok: false, error: "<короткая причина>"}`.
>
> 3. После прохода спи 60 секунд и повторяй.
>
> Если job'ов нет — лог «no pending scanflow jobs» и продолжай цикл.
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
- запросит MCP-инструменты `pf_list_pending_ai_prompt_jobs` / `pf_claim_ai_prompt_job` / `pf_complete_ai_prompt_job`
- начнёт цикл
- для каждого job'а `type: scanflow_ocr` (накладные) или `type: scanflow_supplier_requisites` (реквизиты поставщика) — скачает документ, распознает по промпту из `prompt_url`, отправит callback, завершит job

Latency: ~30-60 сек на накладную (queue check + OCR + callback). Для 50/день этого достаточно.

## Что происходит если диспетчер выключен

ScanFlow продолжит ставить job'ы в ProjectsFlow. Каждая накладная висит со status='ocr_processing'. Через **15 минут** cron-sweep (`markStaleDispatchersAsFailed`) пометит её как error со словом «Dispatcher timeout»; сам job на стороне ProjectsFlow тоже отменяется через 15 минут. Когда вы вернёте диспетчер — новые накладные снова пойдут в очередь.

## Что происходит если ScanFlow перезапустился пока диспетчер работал

PF-job'ы никуда не делись — диспетчер подберёт их на следующем цикле (если они ещё не старше 15 минут). Token хранится в `invoices.dispatcher_token`, поэтому callback после рестарта всё равно валидируется правильно.

## Отладка

- **Все ли job'ы создаются:** `SELECT id, dispatcher_task_id, dispatcher_started_at, status FROM invoices ORDER BY id DESC LIMIT 10;` (колонка историческая — в ней теперь id AI-job'а)
- **Callback validation lost:** в ScanFlow логах ищите `dispatcher photo: token invalid` или `dispatcher result: token invalid`.
- **Timeout sweep сработал:** `grep "Dispatcher timeout" logs/...` или `error_message` в `invoices` начинается с «Dispatcher timeout».
- **Тест с одной накладной**: на локалке загрузите фото через UI, проверьте что `invoices.dispatcher_task_id` появилось, потом откройте Claude Code и вставьте промпт — должно пройти в течение минуты.

## Не делаем (YAGNI)

- Несколько dispatcher-сессий параллельно (одной достаточно, плюс race на claim в MCP — отдельная история)
- Webhook from PF to ScanFlow когда задача готова (вместо этого dispatcher делает callback сам)
- Retry-логика в самом dispatcher'е — если Claude Code сессия упала, юзер заметит и перезапустит вручную
