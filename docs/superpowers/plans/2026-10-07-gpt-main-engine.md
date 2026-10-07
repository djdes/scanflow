# GPT — единственный ИИ-движок: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** все вызовы ИИ в ScanFlow идут через один шлюз и в режиме `gpt` — только в подписку ChatGPT; недоступный GPT ставит накладные в ожидание с автоматическим возобновлением; страница «Настройки» очищена.

**Architecture:** новый модуль `src/ai/` (типы, ошибки, выбор движка, два движка, повторы, состояние). Распознавание (`claudeApiAnalyzer.ts`) и остальные места получают `AiTarget` вместо пары «ключ + модель». PDF превращается в картинки (`src/ocr/pdfPages.ts`). Ожидание — статус `waiting_ai`, возобновление — `src/services/aiResume.ts`.

**Tech Stack:** Node 25, TypeScript strict (CommonJS), Express 5, mysql2, vitest; `pdfjs-dist@6.4.299` + `@napi-rs/canvas@1.0.10` (уже в `package.json`).

**Spec:** [docs/superpowers/specs/2026-10-07-gpt-main-engine-design.md](../specs/2026-10-07-gpt-main-engine-design.md)

## Global Constraints

- Тесты — только `DB_NAME=scanflow_test npx vitest run …` (правило 17); проверка типов — `npx tsc --noEmit`.
- В режиме, отличном от `claude_api`, Claude SDK не вызывается никогда (спека, решение 1).
- Распознавание и возобновление — строго по одной накладной (правило 21).
- `emit()`/`sendOwnerAlert` никогда не бросают (правило 9).
- `/health`: состояние GPT не влияет на итоговый `status` (выкладка ждёт `"status":"ok"`).
- Тексты интерфейса — по-русски, подсказки в одну строку, без `approved_for_1c=1`, `verified=1`, «pull'е», «fuzzy», «LLM».
- Миграций нет: `status` — `VARCHAR(32)`.

## Review Focus

1. **Отравленная накладная в ожидании** — страница, на которой GPT стабильно падает по таймауту, не должна держать очередь `waiting_ai`: таймаут — обычная ошибка (`error`), а не «недоступен». Тест в задаче 1 (`classifyGptError`: `TimeoutError` → не `AiUnavailableError`).
2. **Две страницы одной накладной, пришедшие во время сбоя** — после возобновления должны склеиться, хотя загружены часы назад. Тест в задаче 5 (окно поиска соседа от `created_at` накладной, а не от `NOW()`).
3. **Зачистка «зависших» строк** (`markStaleAsFailed`) не должна переводить `waiting_ai` в `error`. Тест в задаче 5.
4. **Повторное «остановился»** — пока сбой длится, Telegram не чаще раза в 6 часов, «снова работает» — только после «остановился». Тест в задаче 5.
5. **PDF больше 10 страниц или битый PDF** — читаются первые 10 / понятная ошибка, процесс не падает. Тест в задаче 4.

---

### Task 1: ИИ-шлюз `src/ai/`

**Files:**
- Create: `src/ai/types.ts`, `src/ai/errors.ts`, `src/ai/engine.ts`, `src/ai/retry.ts`, `src/ai/gptEngine.ts`, `src/ai/claudeEngine.ts`, `src/ai/gateway.ts`
- Test: `tests/ai/gateway.test.ts`, `tests/ai/errors.test.ts`

**Interfaces (Produces):**

```ts
// src/ai/types.ts
export type AiEngine = 'gpt' | 'claude';
export interface AiTarget { engine: AiEngine; model: string; apiKey: string | null }
export type AiImageType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
export type AiInput = { type: 'text'; text: string } | { type: 'image'; mediaType: AiImageType; data: string };
export interface AiRequest {
  target: AiTarget;
  label: string;
  system?: string[];
  content: AiInput[] | string;
  effort?: 'low' | 'medium' | 'high';
  imageDetail?: 'low' | 'high';
  maxOutputTokens?: number;               // Claude max_tokens, по умолчанию 32000
  thinking?: 'adaptive' | 'disabled' | 'default'; // только Claude, по умолчанию adaptive
  timeoutMs?: number;                      // по умолчанию 240000
  retries?: number;                        // по умолчанию 2 (3 попытки)
}
export interface AiStructuredRequest extends AiRequest { schema: Record<string, unknown>; schemaName: string }
export interface AiResponse { text: string; truncated: boolean }

// src/ai/errors.ts
export type AiUnavailableReason = 'not_connected' | 'reauth_required' | 'rate_limited' | 'network';
export class AiUnavailableError extends Error {
  constructor(readonly reason: AiUnavailableReason, readonly retryAtMs: number | null, detail?: string);
}
export function aiUnavailableText(reason: AiUnavailableReason, retryAtMs: number | null): string;
export function isNetworkFailure(err: unknown): boolean; // fetch failed / ECONN* / 5xx / 407 / 403-блокировка; НЕ таймаут

// src/ai/engine.ts
export function aiTargetFromConfig(cfg: { mode: string; anthropic_api_key: string | null; claude_model: string; gpt_model?: string | null }): AiTarget;
export async function resolveAiTarget(): Promise<AiTarget>;
export interface AiEngineState { engine: AiEngine; model: string; available: boolean; reason: AiUnavailableReason | null; retryAtMs: number | null; text: string }
export async function aiEngineState(target?: AiTarget): Promise<AiEngineState>;
export async function unavailableFromChatgpt(detail: string): Promise<AiUnavailableError>; // причина — по строке chatgpt_connection

// src/ai/gateway.ts
export async function aiStructured(req: AiStructuredRequest): Promise<AiResponse>;
export async function aiText(req: AiRequest): Promise<AiResponse>;
```

- `aiTargetFromConfig`: `mode === 'claude_api'` → `{engine:'claude', model: claude_model, apiKey: cfg.anthropic_api_key || config.anthropicApiKey || null}`; иначе → `{engine:'gpt', model: isGptModel(gpt_model) ? gpt_model : DEFAULT_GPT_MODEL, apiKey: null}`.
- `gptEngine`: `codexRespond({ model, instructions: system.join('\n\n') || 'Ты — ассистент ScanFlow.', content, schema?, effort, signal, label })`; `ChatgptUnavailableError` → `unavailableFromChatgpt`; `GptStreamError` с `rateLimited` и HTTP 429 → `unavailableFromChatgpt` (подключение уже помечено `codexClient`).
- `claudeEngine`: перенос нынешнего `requestStructuredText` (system-блоки с `cache_control`, streaming, `thinking`, `output_config`); без ключа → `AiUnavailableError('not_connected')`.
- `retry.ts`: `withRetry(fn, label, timeoutMs, retries)` — не повторяет `AiUnavailableError` и 4xx кроме 429.
- `gateway`: `withRetry` вокруг движка; после исчерпания попыток `isNetworkFailure(err)` → `AiUnavailableError('network', null, err.message)`.

- [ ] **Step 1: Тесты** (`tests/ai/gateway.test.ts`, моки `../../src/chatgpt/codexClient` и `@anthropic-ai/sdk`):
  - `aiTargetFromConfig` для `gpt`, `hybrid`, `dispatcher` → `engine:'gpt'`; для `claude_api` → `claude`;
  - режим `gpt`: `aiStructured` зовёт `codexRespond` и **ни разу** не создаёт `Anthropic` — даже когда `codexRespond` бросает;
  - `ChatgptUnavailableError` при `rateLimitedUntilMs` в будущем → `AiUnavailableError('rate_limited', reset)`, без повторов;
  - `TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })` трижды → `AiUnavailableError('network')`;
  - `DOMException('TimeoutError')` → исходная ошибка (не «недоступен»);
  - `schema` уходит в `codexRespond` как `{ name: schemaName, schema }`.
- [ ] **Step 2:** `DB_NAME=scanflow_test npx vitest run tests/ai` — падает (модуля нет).
- [ ] **Step 3:** Реализация файлов по интерфейсам выше.
- [ ] **Step 4:** Тесты зелёные, `npx tsc --noEmit` чистый.
- [ ] **Step 5:** Коммит `feat(ai): единый ИИ-шлюз — GPT по подписке или Claude по режиму`.

### Task 2: Распознавание через шлюз

**Files:**
- Modify: `src/ocr/claudeApiAnalyzer.ts` (`StructuredCallParams`, `requestStructuredText`, `callStructured`, `readNumberRows`, `startNumberRows`, `verifyAndRepair`, ядра анализа, `detectOrientation*`, `mapItemsWithClaudeApi` → `mapItemsWithAi`, промпт «ТОЧНОСТЬ НАЗВАНИЙ»), `src/ocr/gptVision.ts` (убрать `visionModelFor`, `toGptContent` переезжает в `src/ai/gptEngine.ts`), `src/ocr/ocrManager.ts`, `src/services/queueReocr.ts`, `src/golden/goldenRunner.ts`, `src/api/routes/suppliers.ts`
- Test: `tests/ocr/gptVision.test.ts` (переписать под `aiTargetFromConfig`), `tests/ocr/claudeApiSchema.test.ts` (снимок промпта), `tests/services/queueReocr.test.ts`, `tests/golden/goldenRunner.test.ts`, `tests/api/suppliers.inn.test.ts`

**Interfaces:**
- Consumes: `AiTarget`, `aiStructured`, `aiText`, `AiUnavailableError`, `resolveAiTarget`.
- Produces: `analyzeImageWithVerification(path, target, catalog?, memory?)`, `analyzeImageWithClaudeApi(path, target, catalog?, memory?)`, `analyzeMultipleImagesWithVerification(paths, target, …)`, `analyzeMultiPageTextWithVerification(text, target, pageCount, catalog?, memory?)`, `detectOrientation(previews, target)`, `mapItemsWithAi(items, catalog, target)`; `callStructured` пробрасывает `AiUnavailableError`, остальные ошибки — `{success:false}`; `verifyAndRepair` при `AiUnavailableError` в до-чтении оставляет первый результат.

- [ ] **Step 1:** Тесты: снимок `INVOICE_INSTRUCTIONS` не содержит «из name убирай» и содержит «как напечатано»; `analyzeImageWithVerification` с мок-шлюзом, бросающим `AiUnavailableError`, — бросает (а не `{success:false}`); `mapItemsWithAi` разбирает ответ по схеме `matches`.
- [ ] **Step 2:** Прогон — падает.
- [ ] **Step 3:** Реализация; `buildSystemTexts(catalog, memory): string[]` вместо Anthropic-блоков (тексты те же); `ocrManager` берёт `resolveAiTarget()` один раз на распознавание; `queueReocr`/`goldenRunner` — `target` в контексте вместо `apiKey/model`, `meta.model = target.model`; `suppliers.extract` — `resolveAiTarget()`, `AiUnavailableError` → 503 с `aiUnavailableText`.
- [ ] **Step 4:** Тесты затронутых файлов и `npx tsc --noEmit` зелёные.
- [ ] **Step 5:** Коммит `feat(ocr): распознавание через ИИ-шлюз; названия как напечатано`.

### Task 3: Остальные места через шлюз и `/health`

**Files:**
- Modify: `src/services/llmRemap.ts`, `src/services/queueLlmMap.ts`, `src/watcher/fileWatcher.ts` (подбор для XML), `src/learning/llmAdvisor.ts`, `src/learning/learningService.ts`, `src/api/routes/operations.ts`, `src/services/invoiceSourceLocator.ts`, `src/api/routes/invoiceReview.ts` (текст ошибки), `src/api/server.ts` (`/health`)
- Test: `tests/services/llmRemap.test.ts`, `tests/watcher/xmlInvoice.test.ts`, `tests/learning/llmAdvisor.test.ts`, `tests/api/health.test.ts` (новый)

- [ ] **Step 1:** Тесты:
  - `llmRemapInvoice` при `AiUnavailableError` пробрасывает её, маршрут отвечает 503;
  - XML-накладная при недоступном ИИ сопоставляется правилами;
  - `adviseWithLlm` зовёт `aiStructured` с `effort:'low'` и при недоступности возвращает `[]`;
  - `/health` в режиме `gpt` без ключа Anthropic — `"status":"ok"` и `checks.ai_engine`.
- [ ] **Step 2:** Прогон — падает.
- [ ] **Step 3:** Реализация:
  - `NO_API_KEY_ERROR` и проверки ключа заменить на `resolveAiTarget()`; ключ проверяется только у `engine === 'claude'`;
  - помощник — `aiText({ effort:'low', timeoutMs: 25000, retries: 0 })`, при любой ошибке остаётся детерминированный ответ;
  - локатор — `aiStructured({ thinking:'disabled', maxOutputTokens: 12000, timeoutMs: 120000, retries: 0 })`, `truncated` → прежняя ошибка «Поиск областей не завершён»;
  - `/health`:
    - `checks.ai_engine = { ok, detail }` из `aiEngineState()`;
    - `anthropic_api_key` — только при `mode === 'claude_api'`;
    - `allOk` от `ai_engine` не зависит.
- [ ] **Step 4:** Тесты и `npx tsc --noEmit` зелёные.
- [ ] **Step 5:** Коммит `feat(ai): подбор позиций, советчик, помощник, подсветка и /health через шлюз`.

### Task 4: PDF через картинки

**Files:**
- Create: `src/ocr/pdfPages.ts`
- Modify: `src/ocr/ocrManager.ts` (`recognizeWithClaudeApi` для `.pdf`), `src/services/queueReocr.ts`, `src/golden/goldenRunner.ts`, `src/api/routes/suppliers.ts` (PDF — первая страница; убрать 400 «PDF только в диспетчере»)
- Test: `tests/ocr/pdfPages.test.ts`

**Interfaces (Produces):**

```ts
export interface PdfPages { paths: string[]; totalPages: number; truncated: boolean; cleanup(): void }
export async function pdfToImages(pdfPath: string, opts?: { maxPages?: number; dpi?: number }): Promise<PdfPages>; // maxPages 10, dpi 200
export function isPdfPath(p: string): boolean;
```

- Загрузка `pdfjs-dist/legacy/build/pdf.mjs` через `new Function('s','return import(s)')` и `pathToFileURL` (проект CommonJS). `standardFontDataUrl` — с прямыми слешами и `/` в конце. Холст — `@napi-rs/canvas`, белый фон, JPEG 90. Временные файлы — в `os.tmpdir()`, `cleanup()` удаляет.
- PDF в `ocrManager`:
  - одна страница — как фото, но без определения поворота (`preprocessImage(path, { detectRotation: false })`);
  - несколько — постранично `analyzeImageWithVerification` и склейка `analyzeMultiPageTextWithVerification` (движок `gpt_api_multipage`);
  - `truncated` → в `raw_text` пометка «PDF: прочитаны первые 10 страниц из N».

- [ ] **Step 1:** Тесты:
  - PDF из двух страниц (генерируется в тесте как текст PDF с правильной таблицей xref) → две JPEG-картинки с сигнатурой `FF D8`;
  - `maxPages: 1` → одна картинка, `truncated: true`;
  - мусор вместо PDF → понятная ошибка «Не удалось открыть PDF»;
  - `cleanup()` удаляет файлы.
- [ ] **Step 2:** Прогон — падает.
- [ ] **Step 3:** Реализация.
- [ ] **Step 4:** Тесты зелёные.
- [ ] **Step 5:** Коммит `feat(ocr): PDF читается через картинки страниц — тем же путём, что фото`.

### Task 5: «Ждёт GPT», возобновление, Telegram, статус

**Files:**
- Create: `src/services/aiResume.ts`, `src/services/aiOutage.ts`, `src/api/routes/ai.ts`
- Modify:
  - `src/watcher/fileWatcher.ts`: `processFile` → `recognizeCreatedInvoice`, `parkWaitingAi`, `resumeWaitingInvoice`; окно соседних страниц от `anchorTime`;
  - `src/database/repositories/invoiceRepo.ts`: `markWaitingAi`, `listWaitingAiIds`, `countWaitingAi`, `clearErrorMessage`; `anchor` в `findRecentByNumber`, `findRecentBySupplier`, `findRecentByFileNamePattern`, `findMostRecentProcessedForContinuation`; `waiting_ai` исключён из `markStaleAsFailed`;
  - `src/services/queueJobs.ts`: статус `paused`, `pausedJob` и `resumePausedQueueJobs`;
  - `src/services/queueReocr.ts`, `src/services/queueLlmMap.ts`: недоступность → пауза;
  - `src/api/routes/chatgpt.ts`: `kickAiResume()` после входа и успешной проверки;
  - `src/api/routes/invoices.ts`: «Пересканировать» — сначала `aiEngineState()`, иначе 503;
  - `src/api/server.ts`: `/api/ai` для любого пользователя;
  - `src/index.ts`: крон каждые 5 минут и проход на старте.
- Test: `tests/services/aiResume.test.ts`, `tests/services/aiOutage.test.ts`, `tests/watcher/waitingAi.test.ts`, `tests/database/neighborWindow.test.ts`, `tests/services/queueJobs.test.ts` (дописать)

**Interfaces (Produces):**

```ts
// src/services/aiOutage.ts
export async function reportAiOutage(err: AiUnavailableError): Promise<void>; // админам, 'ai_unavailable', 6 ч; никогда не бросает
export async function reportAiResumed(count: number): Promise<void>;          // 'ai_resumed' только после 'ai_unavailable'
// src/services/aiResume.ts
export function startAiResume(watcher: FileWatcher): void;  // крон 5 мин + проход на старте
export function kickAiResume(): void;                        // внеочередной проход
export async function runAiResumePass(watcher: Pick<FileWatcher, 'resumeWaitingInvoice'>): Promise<{ resumed: number; stoppedBy: AiUnavailableError | null }>;
// FileWatcher
async resumeWaitingInvoice(invoiceId: number): Promise<'processed' | 'waiting' | 'error' | 'skipped'>;
```

- [ ] **Step 1:** Тесты:
  - `processFile` с мок-OCR, бросающим `AiUnavailableError`: статус `waiting_ai`, фото в `processed/`, нет `recognition_error` и `sendErrorEmail`, `recovery_attempts` не изменился;
  - `runAiResumePass`:
    - две ждущие накладные, вторая снова «недоступен» → первая `processed`, вторая `waiting_ai`, проход остановлен;
    - порядок — по возрастанию id, вызовы последовательные (счётчик одновременных ≤ 1);
  - соседняя страница: две накладные с `created_at` 3 часа назад и разницей 1 минута → `findRecentByNumber(..., anchor)` находит пару; без `anchor` — нет;
  - `markStaleAsFailed` не трогает `waiting_ai`;
  - `reportAiOutage` дважды подряд → одно сообщение; `reportAiResumed` без предшествующего «остановился» → ничего;
  - задача очереди при `AiUnavailableError` → `status:'paused'`, `resumePausedQueueJobs` запускает оставшиеся id;
  - `GET /api/ai/status` → `{ engine, model, available, text, waiting }` своей компании.
- [ ] **Step 2:** Прогон — падает.
- [ ] **Step 3:** Реализация.
- [ ] **Step 4:** Тесты и `npx tsc --noEmit` зелёные.
- [ ] **Step 5:** Коммит `feat(ai): «Ждёт GPT» — ожидание, возобновление по одной и оповещение админу`.

### Task 6: Страница «Настройки», статус в списке, документация

**Files:**
- Modify:
  - `public/app.html`: секция `view-settings`, полоса `#ai-status-banner` над списком накладных;
  - `public/js/settings.js`;
  - `public/js/app.js`: `statusLabel`/`statusBadge` — `waiting_ai` → «Ждёт GPT»;
  - `public/js/invoices.js`: полоса из `/api/ai/status`;
  - `public/js/upload.js`: `waiting_ai` — не «ошибка», а «ждёт GPT»;
  - `public/js/queue.js`: `paused`;
  - `src/services/engineFlags.ts`: подсказки в одну строку;
  - `CLAUDE.md`.

- [ ] **Step 1:** Разметка и JS по разделу 6 спеки:
  - карточки «Распознавание», «Автоматизация» (переключатели сохраняются сразу), «Поставщики», «Проверки и пересчёт» (`<details>`, свёрнуто);
  - карточки админа — короче тексты.
- [ ] **Step 2:** Проверка в браузере локально (`npm run dev` на локальной БД):
  - 1280, 390 и 320 px, `document.documentElement.scrollWidth <= innerWidth`;
  - загрузка настроек, переключатель автоотправки, сохранение модели.
- [ ] **Step 3:** CLAUDE.md:
  - режим OCR;
  - правило 39 — шлюз и «Claude не вызывается»;
  - новое правило 40 — `waiting_ai`, возобновление, окно по `created_at`;
  - API `/api/ai/status`;
  - `/health`;
  - `pdfjs-dist`.
- [ ] **Step 4:** Полный прогон `DB_NAME=scanflow_test npx vitest run` и `npx tsc --noEmit`.
- [ ] **Step 5:** Коммит `feat(settings): чистая страница настроек под GPT; статус «Ждёт GPT»; CLAUDE.md`.

### После реализации (с подтверждения владельца)

Push в `main` → GitHub Actions → проверка на проде:
- одно фото и один PDF;
- «Подобрать позиции ИИ» на одной накладной;
- подсветка источника;
- вопрос помощнику;
- `/health`;
- `GET /api/ai/status`.
