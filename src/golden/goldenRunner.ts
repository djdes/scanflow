/**
 * Прогон эталонов (п.17 пакета v2).
 *
 * Берёт накладные, отмеченные «⭐ Эталон», заново распознаёт их фото ТЕКУЩЕЙ
 * моделью/промптом и сравнивает с тем, что хранится в накладной (проверено
 * человеком). Так видно, не «поехали» ли после обновления номера, даты, суммы,
 * НДС, ИНН и строки — заказчику важно заметить это до того, как ошибка уйдёт
 * в 1С и банк.
 *
 * Жёсткие правила:
 *   - в invoices / invoice_items НЕ пишем ничего — только читаем; результат
 *     живёт в golden_runs;
 *   - строго по одной накладной: параллельные вызовы Claude на картинках —
 *     ровно то, что пробило лимит памяти в инциденте 2026-07-14 (правило 21
 *     CLAUDE.md); одновременно идёт не больше одного прогона на процесс;
 *   - каталог 1С в запрос НЕ передаём: сравниваем распознавание, а не
 *     сопоставление;
 *   - ошибка на одной накладной записывается в её результат, прогон идёт дальше.
 *
 * Ограничения (сознательные):
 *   - многостраничные накладные (file_name — список через запятую) пропускаются
 *     с причиной 'multipage': в проде страницы распознаются по отдельности и
 *     потом сшиваются (склейка зависит от порядка загрузки и времени), честно
 *     воспроизвести это без записи в БД нельзя;
 *   - всегда путь «фото → модель» (claude_api), даже если в настройках выбран
 *     hybrid/диспетчер: это режим продакшена, его и меряем. В режиме gpt фото
 *     читает GPT через шлюз ProjectsFlow — так эталоны сравнивают Claude и GPT.
 */
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';
import { invoiceRepo } from '../database/repositories/invoiceRepo';
import { goldenRepo } from '../database/repositories/goldenRepo';
import { OcrManager } from '../ocr/ocrManager';
import { analyzeImageWithVerification } from '../ocr/claudeApiAnalyzer';
import { isPdfPath, pdfToImages } from '../ocr/pdfPages';
import { aiTargetFromConfig } from '../ai/engine';
import type { AiTarget } from '../ai/types';
import { buildSupplierMemory } from '../learning/supplierMemory';
import type { ParsedInvoiceData } from '../ocr/types';
import { compareGolden, truthFromInvoice, type GoldenCompareResult } from './compare';
import { recognizedFromParsed } from './recognized';
import { isXmlInvoice } from '../xml';

export type GoldenSkipReason = 'multipage' | 'no_photo' | 'not_found' | 'xml';

export interface GoldenInvoiceResult {
  invoice_id: number;
  /** Из эталона — чтобы в отчёте было видно, о какой накладной речь. */
  invoice_number: string | null;
  supplier: string | null;
  status: 'ok' | 'mismatch' | 'skipped' | 'error';
  reason?: GoldenSkipReason;
  error?: string;
  duration_ms?: number;
  compare?: GoldenCompareResult;
}

export interface GoldenRunSummary {
  model: string | null;
  planned: number;
  processed: number;
  /** Распознано и сравнено (ok + mismatch). */
  compared: number;
  ok: number;
  mismatch: number;
  skipped: number;
  errors: number;
  skipped_reasons: Partial<Record<GoldenSkipReason, number>>;
  header_ok: number;
  header_total: number;
  /** header_ok / header_total по всем сравненным накладным; null — сравнивать было нечего. */
  header_accuracy: number | null;
  items_ok: number;
  items_total: number;
  items_accuracy: number | null;
  /** Сколько накладных не сошлось по полю: invoice_number, vat_sum, items_count, line.price… */
  field_failures: Record<string, number>;
  error?: string;
}

export interface GoldenRecognizeContext {
  /** Модель из настроек на момент запуска — весь прогон меряет одну и ту же. */
  target: AiTarget;
  model: string;
  /** Памятка по поставщикам (п.16) — та же, что уходит в боевой промпт. */
  memory?: string;
}

export interface GoldenRunnerDeps {
  /** Распознать фото текущей моделью без каталога. Бросает, если распознать не удалось. */
  recognize: (photoPath: string, ctx: GoldenRecognizeContext) => Promise<ParsedInvoiceData>;
  /** Найти фото на диске (только чтение). null — файла нет. */
  locatePhoto: (fileName: string, filePath: string | null) => string | null;
}

/**
 * Поиск фото — тот же порядок, что у FileWatcher.reprocessInvoice:
 * processed → failed (там лежат фото накладных с ошибкой) → inbox, затем
 * file_path из строки. Только чтение. Имя с путём внутри (данные из БД) не
 * принимаем: прогон не должен уметь прочитать и отправить в Claude
 * произвольный файл сервера.
 */
export function locateGoldenPhoto(fileName: string, filePath: string | null): string | null {
  const name = fileName.trim();
  if (!name || path.basename(name) !== name) return null;
  for (const dir of [config.processedDir, config.failedDir, config.inboxDir]) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  if (filePath && path.basename(filePath) === name && fs.existsSync(filePath)) return filePath;
  return null;
}

// Свой OcrManager только ради preprocessImage (EXIF + определение поворота +
// resize/sharpen/normalise) — тот же шаг, что делает recognizeWithClaudeApi
// перед вызовом Claude. Движки внутри ленивые: пока не вызван recognize(),
// ни Tesseract, ни Google Vision не поднимаются.
let sharedOcr: OcrManager | null = null;
function ocrManager(): OcrManager {
  if (!sharedOcr) sharedOcr = new OcrManager();
  return sharedOcr;
}

/** Боевой путь (OcrManager.recognizeWithClaudeApi), но без каталога 1С (памятка поставщиков — как в бою). */
async function recognizeWithCurrentModel(photoPath: string, ctx: GoldenRecognizeContext): Promise<ParsedInvoiceData> {
  if (isPdfPath(photoPath)) {
    // PDF — картинкой страницы; эталоны пока только одностраничные.
    const pdf = await pdfToImages(photoPath, { maxPages: 1 });
    try {
      if (pdf.totalPages > 1) throw new Error('Многостраничный PDF — эталоны пока только одностраничные');
      return await recognizePrepared(pdf.paths[0], ctx, false);
    } finally {
      pdf.cleanup();
    }
  }
  return recognizePrepared(photoPath, ctx, true);
}

async function recognizePrepared(photoPath: string, ctx: GoldenRecognizeContext, detectRotation: boolean): Promise<ParsedInvoiceData> {
  const prepared = await ocrManager().preprocessImage(photoPath, { target: ctx.target, detectRotation });
  try {
    const result = await analyzeImageWithVerification(prepared, ctx.target, undefined, ctx.memory);
    if (!result.success || !result.data) {
      throw new Error(result.error || 'Image analysis failed');
    }
    return result.data;
  } finally {
    if (prepared !== photoPath) {
      try { fs.unlinkSync(prepared); } catch { /* временный файл — не критично */ }
    }
  }
}

const defaultDeps: GoldenRunnerDeps = {
  recognize: recognizeWithCurrentModel,
  locatePhoto: locateGoldenPhoto,
};

const ratio = (ok: number, total: number): number | null =>
  total > 0 ? Math.round((ok / total) * 10000) / 10000 : null;

/** Сводка прогона по результатам (чистая функция — и для прогресса, и для итога). */
export function summarizeGoldenResults(
  results: GoldenInvoiceResult[],
  planned: number,
  model: string | null,
): GoldenRunSummary {
  const s: GoldenRunSummary = {
    model,
    planned,
    processed: results.length,
    compared: 0,
    ok: 0,
    mismatch: 0,
    skipped: 0,
    errors: 0,
    skipped_reasons: {},
    header_ok: 0,
    header_total: 0,
    header_accuracy: null,
    items_ok: 0,
    items_total: 0,
    items_accuracy: null,
    field_failures: {},
  };
  const bump = (key: string) => { s.field_failures[key] = (s.field_failures[key] ?? 0) + 1; };
  for (const r of results) {
    if (r.status === 'skipped') {
      s.skipped++;
      if (r.reason) s.skipped_reasons[r.reason] = (s.skipped_reasons[r.reason] ?? 0) + 1;
      continue;
    }
    if (r.status === 'error' || !r.compare) {
      s.errors++;
      continue;
    }
    s.compared++;
    if (r.status === 'ok') s.ok++; else s.mismatch++;
    const c = r.compare.summary;
    s.header_ok += c.header_ok;
    s.header_total += c.header_total;
    s.items_ok += c.items_ok;
    s.items_total += c.items_total;
    for (const f of c.failed) bump(f);
    for (const f of Object.keys(c.line_failures)) bump(`line.${f}`);
  }
  s.header_accuracy = ratio(s.header_ok, s.header_total);
  s.items_accuracy = ratio(s.items_ok, s.items_total);
  return s;
}

/** Одна накладная. Никогда не бросает — ошибка становится результатом со status 'error'. */
export async function evaluateGoldenInvoice(
  invoiceId: number,
  ctx: GoldenRecognizeContext,
  deps: GoldenRunnerDeps = defaultDeps,
): Promise<GoldenInvoiceResult> {
  const t0 = Date.now();
  const base = { invoice_id: invoiceId, invoice_number: null as string | null, supplier: null as string | null };
  try {
    const inv = await invoiceRepo.getById(invoiceId);
    if (!inv) return { ...base, status: 'skipped', reason: 'not_found' };
    base.invoice_number = inv.invoice_number ?? null;
    base.supplier = inv.supplier ?? null;
    // Электронный документ (XML) не распознаётся — проверять распознавание не на чем.
    if (isXmlInvoice(inv)) return { ...base, status: 'skipped', reason: 'xml' };

    const files = (inv.file_name || '').split(',').map(s => s.trim()).filter(Boolean);
    if (files.length > 1) return { ...base, status: 'skipped', reason: 'multipage' };
    const photo = files.length === 1 ? deps.locatePhoto(files[0], inv.file_path ?? null) : null;
    if (!photo) return { ...base, status: 'skipped', reason: 'no_photo' };

    // «Правду» снимаем ДО распознавания: вызов Claude идёт минуты, и сравнивать
    // надо с тем, что было в накладной на момент запуска.
    const truth = truthFromInvoice(inv, await invoiceRepo.getItems(invoiceId));
    const parsed = await deps.recognize(photo, ctx);
    const compare = compareGolden(truth, recognizedFromParsed(parsed));
    return {
      ...base,
      status: compare.summary.all_ok ? 'ok' : 'mismatch',
      duration_ms: Date.now() - t0,
      compare,
    };
  } catch (err) {
    const message = (err as Error).message || String(err);
    logger.warn('Golden run: invoice failed', { invoiceId, error: message });
    return { ...base, status: 'error', error: message.slice(0, 500), duration_ms: Date.now() - t0 };
  }
}

/**
 * Весь прогон: строго последовательно, прогресс после каждой накладной, в конце
 * статус 'done' (или 'error', если не удалось записать сам прогон).
 */
export async function executeGoldenRun(
  runId: number,
  invoiceIds: number[],
  ctx: GoldenRecognizeContext,
  deps: GoldenRunnerDeps = defaultDeps,
): Promise<GoldenRunSummary> {
  const results: GoldenInvoiceResult[] = [];
  logger.info('Golden run started', { runId, invoices: invoiceIds.length, model: ctx.model });
  try {
    for (const invoiceId of invoiceIds) {
      results.push(await evaluateGoldenInvoice(invoiceId, ctx, deps));
      try {
        await goldenRepo.saveProgress(runId, summarizeGoldenResults(results, invoiceIds.length, ctx.model), results);
      } catch (err) {
        // Прогресс — удобство для UI; из-за него прогон не останавливаем.
        logger.warn('Golden run: progress save failed', { runId, error: (err as Error).message });
      }
    }
    const summary = summarizeGoldenResults(results, invoiceIds.length, ctx.model);
    await goldenRepo.finishRun(runId, 'done', summary, results);
    logger.info('Golden run finished', {
      runId, compared: summary.compared, ok: summary.ok, mismatch: summary.mismatch,
      skipped: summary.skipped, errors: summary.errors, headerAccuracy: summary.header_accuracy,
    });
    return summary;
  } catch (err) {
    const message = (err as Error).message || String(err);
    const summary = { ...summarizeGoldenResults(results, invoiceIds.length, ctx.model), error: message.slice(0, 500) };
    logger.error('Golden run failed', { runId, error: message });
    try {
      await goldenRepo.finishRun(runId, 'error', summary, results);
    } catch (e) {
      logger.error('Golden run: could not record failure', { runId, error: (e as Error).message });
    }
    return summary;
  }
}

// ── Запуск из API: один прогон на процесс ───────────────────────────────────

// null — свободно; 0 — прогон резервируется (идёт INSERT); >0 — id идущего прогона.
let activeRunId: number | null = null;

export function activeGoldenRunId(): number | null {
  return activeRunId;
}

export class GoldenRunBusyError extends Error {
  constructor(public runId: number) {
    super('Прогон эталонов уже идёт');
    this.name = 'GoldenRunBusyError';
  }
}

export class GoldenRunConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoldenRunConfigError';
  }
}

/**
 * Создать запись прогона и запустить его в фоне (НЕ ждёт окончания — прогон
 * длится минуты). Модель и ключ берутся из analyzer_config один раз на весь
 * прогон, чтобы смена модели посреди прогона не смешала результаты.
 */
export async function startGoldenRun(
  opts: { ownerUserId: number; startedBy: number; invoiceIds: number[] },
  deps: GoldenRunnerDeps = defaultDeps,
): Promise<{ runId: number; model: string }> {
  if (activeRunId !== null) throw new GoldenRunBusyError(activeRunId);
  activeRunId = 0; // резерв до INSERT: второй одновременный клик получит 409
  let runId: number;
  let ctx: GoldenRecognizeContext;
  try {
    const cfg = await invoiceRepo.getAnalyzerConfig();
    // Меряем ту модель, что читает фото в бою (ИИ-шлюз): в режиме gpt — GPT по подписке.
    const target = aiTargetFromConfig(cfg);
    if (target.engine === 'claude' && !target.apiKey) {
      throw new GoldenRunConfigError('Не задан ключ Anthropic — включён режим Claude');
    }
    ctx = { target, model: target.model, memory: await buildSupplierMemory(opts.ownerUserId) };
    runId = await goldenRepo.createRun({
      ownerUserId: opts.ownerUserId,
      startedBy: opts.startedBy,
      model: ctx.model,
      summary: summarizeGoldenResults([], opts.invoiceIds.length, ctx.model),
    });
    activeRunId = runId;
  } catch (err) {
    activeRunId = null;
    throw err;
  }
  void executeGoldenRun(runId, opts.invoiceIds, ctx, deps)
    .catch(err => logger.error('Golden run crashed', { runId, error: (err as Error).message }))
    .finally(() => { activeRunId = null; });
  return { runId, model: ctx.model };
}

/**
 * Прогон со статусом 'running', который не идёт в этом процессе, оборван
 * перезапуском (деплой, падение). Помечаем его ошибкой, чтобы UI не ждал вечно.
 * Процесс один (PM2 instances: 1), поэтому «не мой» = «мёртвый».
 */
export async function reconcileInterruptedGoldenRuns(): Promise<number> {
  // Идёт INSERT нового прогона: его id ещё неизвестен, и свежую строку
  // 'running' легко принять за оборванную. Разберёмся при следующем вызове.
  if (activeRunId === 0) return 0;
  const running = await goldenRepo.listRunning();
  let fixed = 0;
  for (const run of running) {
    // activeRunId перечитываем на каждой строке: пока ждали listRunning, мог
    // начаться новый прогон (0 — его INSERT ещё не вернул id).
    if (activeRunId === 0 || run.id === activeRunId) continue;
    let summary: Record<string, unknown> = {};
    try {
      const parsed = run.summary ? JSON.parse(run.summary) : null;
      if (parsed && typeof parsed === 'object') summary = parsed as Record<string, unknown>;
    } catch { /* битый JSON — просто перезапишем */ }
    await goldenRepo.markInterrupted(run.id, {
      ...summary,
      error: 'Прогон прерван перезапуском сервера — результаты неполные',
    });
    fixed++;
  }
  if (fixed > 0) logger.warn('Golden runs interrupted by restart marked as error', { count: fixed });
  return fixed;
}
