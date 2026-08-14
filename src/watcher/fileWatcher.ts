import { watch, type FSWatcher } from 'chokidar';
import path from 'path';
import fs from 'fs';
import { config } from '../config';
import { logger } from '../utils/logger';
import { OcrManager } from '../ocr/ocrManager';
import { parseInvoiceText } from '../parser/invoiceParser';
import { NomenclatureMapper } from '../mapping/nomenclatureMapper';
import { invoiceRepo, DuplicateFileHashError } from '../database/repositories/invoiceRepo';
import { userRepo } from '../database/repositories/userRepo';
import { mappingRepo } from '../database/repositories/mappingRepo';
import { onecNomenclatureRepo, OnecNomenclatureRow } from '../database/repositories/onecNomenclatureRepo';
import type { MappingResult } from '../mapping/nomenclatureMapper';
import { evaluateInvoiceQuality } from '../automation/qualityGate';
import type { ParsedInvoiceData } from '../ocr/types';
import { sendErrorEmail } from '../utils/mailer';
import { canonicalizeSupplierName } from '../utils/invoiceNumber';
import { resolveSupplierName } from '../services/resolveSupplierName';
import { sha256File } from '../utils/fileHash';
import { resolveAndApplyPackTransform } from '../mapping/packTransform';
import { sanitizeItemArithmetic, sanitizeInvoiceVat, sanitizeItemVatPerItem } from '../parser/itemSanitizer';
import { emit as emitNotification, emitElevatedPricesIfAny } from '../notifications/events';
import { editMessageText } from '../notifications/telegram/telegramClient';
import { invoiceUrl } from '../utils/invoiceUrl';
import { UploadSource } from '../utils/uploadSource';
import { autoSendSberForInvoice } from '../services/autoSendSber';
import { mergeBlockedByNumber, mergeLostData } from '../services/mergeDecision';
import { ocrCorrectionRepo } from '../database/repositories/ocrCorrectionRepo';
import { webhookConfigRepo } from '../database/repositories/webhookConfigRepo';

/**
 * Переписать телеграм-пузырь склеенной страницы.
 *
 * Уведомление «фото загружено» уходит ДО распознавания, поэтому к моменту
 * склейки в чате уже висит «Накладная №654 · Загружена» со ссылкой на строку,
 * которой сейчас не станет. Оставлять её мёртвой нельзя — именно на это
 * жаловались 16.07. Правим текст на «страница вошла в накладную #N».
 *
 * Никогда не бросает: уведомления не имеют права ломать конвейер (правило 9).
 * Пары (chat_id, message_id) должны быть прочитаны ДО удаления строки —
 * invoice_telegram_messages висит на ON DELETE CASCADE.
 */
async function notifyPageMerged(
  ownerUserId: number | null,
  sourceId: number,
  targetId: number,
  bubbles: Map<string, number>,
): Promise<void> {
  try {
    if (!bubbles.size || ownerUserId == null) return;
    const tg = await userRepo.getTelegramConfig(ownerUserId);
    if (!tg?.bot_token) return;
    const text = `📎 Страница загружена и вошла в накладную #${targetId}\n\n`
      + `Отдельной накладной №${sourceId} не существует — это был лист того же документа.\n`
      + invoiceUrl(targetId);
    for (const [chatId, messageId] of bubbles) {
      try {
        await editMessageText(tg.bot_token, chatId, messageId, text);
      } catch (err) {
        logger.warn('notifyPageMerged: edit failed', {
          sourceId, targetId, chatId, error: (err as Error).message,
        });
      }
    }
  } catch (err) {
    logger.warn('notifyPageMerged: unexpected error', {
      sourceId, targetId, error: (err as Error).message,
    });
  }
}

const SUPPORTED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.webp'];

/**
 * Extract the row_no of the FIRST item from a persisted invoice's raw_text.
 *
 * We never migrated row_no into the invoice_items table (it's only useful at
 * merge-time), so we re-parse it from the JSON Claude returned and that we
 * stored verbatim in invoices.raw_text. Tolerant to jsonrepair cases where
 * the text contains fenced markdown — we scan for the first /"row_no":\s*(\d+)/.
 */
async function getFirstRowNo(invoiceId: number): Promise<number | null> {
  const row = await invoiceRepo.getById(invoiceId);
  if (!row || !row.raw_text) return null;
  const m = row.raw_text.match(/"row_no"\s*:\s*(\d+)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface UploadMeta {
  source?: UploadSource;
  userAgent?: string | null;
  // Owning tenant for multi-tenant isolation. Set by /api/upload (req.user.id).
  // Undefined for watcher-detected inbox files (no user context) → NULL owner.
  ownerUserId?: number | null;
}

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private ocrManager: OcrManager;
  private mapper: NomenclatureMapper;
  private processing: Set<string> = new Set();

  constructor(ocrManager: OcrManager, mapper: NomenclatureMapper) {
    this.ocrManager = ocrManager;
    this.mapper = mapper;
  }

  start(): void {
    const watchPath = config.inboxDir;

    // Ensure directories exist
    for (const dir of [config.inboxDir, config.processedDir, config.failedDir]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    this.watcher = watch(watchPath, {
      ignored: /(^|[\/\\])\../, // ignore dotfiles
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 500,
      },
    });

    this.watcher
      .on('add', (filePath: string) =>
        this.onFileAdded(filePath).catch(err =>
          logger.error('onFileAdded failed', { error: (err as Error).message })
        ))
      .on('error', (error: unknown) => logger.error('File watcher error', { error: (error as Error).message }));

    logger.info('File watcher started', { path: watchPath });
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      logger.info('File watcher stopped');
    }
  }

  private async onFileAdded(filePath: string): Promise<void> {
    const ext = path.extname(filePath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(ext)) {
      logger.debug('Ignoring non-image file', { filePath });
      return;
    }

    // Normalize path for consistent dedup (Windows case-insensitive paths)
    const normalizedPath = path.resolve(filePath).toLowerCase();

    if (this.processing.has(normalizedPath)) {
      logger.debug('Already processing, skipping', { filePath });
      return;
    }

    this.processing.add(normalizedPath);
    const fileName = path.basename(filePath);

    // DB-level dedup: check if this file was already processed recently (within 5 min)
    const recentDuplicate = await invoiceRepo.findRecentByFileName(fileName, 5);
    if (recentDuplicate) {
      logger.warn('File already processed recently, skipping duplicate', {
        fileName,
        existingId: recentDuplicate.id,
        existingStatus: recentDuplicate.status,
      });
      this.processing.delete(normalizedPath);
      return;
    }

    logger.info('New invoice image detected', { fileName });

    // Файл, положенный прямо в inbox/, приходит без пользовательского контекста.
    // Раньше такая накладная оставалась БЕЗ владельца, и после разделения данных
    // по компаниям это ломало всё, что владельца требует: справочник поставщиков
    // не подставлялся, отправка в Сбер отклонялась, уведомление уходило не туда.
    // Папка inbox/ на сервере принадлежит оператору платформы — им и помечаем.
    const inboxOwnerId = await userRepo.firstUserId();
    if (inboxOwnerId == null) {
      logger.warn('Inbox file detected but there is no user to own it', { fileName });
    }

    try {
      await this.processFile(filePath, fileName, undefined, { ownerUserId: inboxOwnerId });
    } catch (err) {
      logger.error('Failed to process invoice', { fileName, error: (err as Error).message });
    } finally {
      this.processing.delete(normalizedPath);
    }
  }

  markProcessing(filePath: string): void {
    this.processing.add(path.resolve(filePath).toLowerCase());
  }

  /**
   * Resolve catalog_idx (1-based, as returned by Claude) to a real 1C GUID.
   * MUST use the same ordering that getCatalogForPrompt used when building
   * the prompt — both are backed by onecNomenclatureRepo.listItems() with
   * the same options, and its ORDER BY is deterministic.
   *
   * Returns undefined on invalid idx / disabled LLM mapper / idx out of range.
   */
  private resolveCatalogIdx(
    idx: number | null | undefined,
    catalog: OnecNomenclatureRow[] | null,
  ): { guid: string; name: string; unit: string | null } | undefined {
    if (!catalog || idx == null || !Number.isFinite(idx)) return undefined;
    const row = catalog[idx - 1];
    if (!row) return undefined;
    return { guid: row.guid, name: row.name, unit: row.unit };
  }

  /**
   * When a pack transform was resolved via name-based fallback (i.e. the
   * learned mapping didn't carry pack_size / pack_unit), persist the detected
   * values back onto the mapping row so the next run skips the regex pass.
   */
  private async persistPackFallback(
    mappingId: number | null,
    resolved: { usedFallback: boolean; packSize: number | null; packUnit: string | null },
    ownerUserId: number,
  ): Promise<void> {
    if (!mappingId || !resolved.usedFallback) return;
    if (!resolved.packSize || !resolved.packUnit) return;
    try {
      await mappingRepo.update(mappingId, ownerUserId, {
        pack_size: resolved.packSize,
        pack_unit: resolved.packUnit,
      });
    } catch (err) {
      logger.warn('Failed to persist pack fallback to mapping', {
        mappingId,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Перепрогнать существующую накладную через OCR + Claude + mapping pipeline
   * заново, используя её исходный файл. Используется кнопкой UI «Пересканировать
   * фото» когда юзер хочет полностью переанализировать (например, после
   * обновления промпта или 1С-каталога).
   *
   * Файл ищется в `processed/` (где он лежит после успешной обработки), либо в
   * `inbox/`, либо по invoice.file_path. Если не найден — кидаем ошибку.
   *
   * Existing items стираются и пересохраняются. Invoice metadata обновляется.
   * `duplicate_of` сбрасывается в NULL (юзер решит сам после переанализа).
   *
   * Multi-page logic НЕ запускается — для повторного scan'а одной страницы её
   * не нужно сливать с другими.
   */
  /**
   * Resolve the supplier name to store: verified directory card by ИНН wins,
   * else snap to an already-stored spelling (by ИНН, else fuzzy ≥70%) so OCR
   * drift doesn't fork the supplier. See {@link resolveSupplierName}.
   */
  private async resolveSupplier(
    rawSupplier: string | null | undefined,
    inn: string | null | undefined,
    ownerUserId: number | null,
  ): Promise<string | undefined> {
    return resolveSupplierName(rawSupplier, inn, ownerUserId);
  }

  /**
   * Block until every EARLIER invoice that's still mid-processing has settled
   * (or a hard 120s cap elapses). Pages of one document often OCR in parallel,
   * and a sibling's supplier/items aren't committed until the end of its run —
   * so a continuation page that finishes first would otherwise fork into a
   * standalone invoice (the 205/206 bug). Only EARLIER ids are awaited, so two
   * concurrent pages can never wait on each other (no deadlock).
   */
  private async awaitInFlightPredecessors(currentId: number, withinMinutes = 5): Promise<void> {
    const deadline = Date.now() + 120_000;
    let announced = false;
    while (Date.now() < deadline) {
      const n = await invoiceRepo.countInFlightOlderThan(currentId, withinMinutes);
      if (n === 0) return;
      if (!announced) {
        logger.info('Multi-page: waiting for earlier page(s) still scanning before merge check', {
          currentId, inFlight: n,
        });
        announced = true;
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    logger.warn('Multi-page: gave up waiting for in-flight predecessor(s) after 120s', { currentId });
  }

  async reprocessInvoice(invoiceId: number): Promise<void> {
    const invoice = await invoiceRepo.getById(invoiceId);
    if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);

    // Перераспознавание переписывает всю шапку, поэтому отметки «сверено с
    // фото» становятся ложными — снимаем все пять. Сбрасываем ДО разбора: если
    // OCR упадёт на середине, лучше остаться с пустым чек-листом (человек
    // сверит заново), чем с галочками от предыдущих значений.
    await invoiceRepo.resetAttrChecks(invoiceId);

    // Каталог, сопоставления и подсказка каталога для Claude — пер-тенантные:
    // весь разбор идёт в области владельца этой накладной. У «ничьей» накладной
    // каталога нет, сопоставление вернёт «не найдено» — это корректно.
    const mappingOwnerId = invoice.owner_user_id ?? -1;

    // ВСЕ файлы накладной. Многостраничная = несколько имён через запятую.
    // Раньше rescan брал ТОЛЬКО первый файл (split(',')[0]) и терял остальные
    // страницы: у 2-страничной накладной оставались только позиции листа 1 и
    // его субитог, а позиции листа 2 + общий итог пропадали. Теперь читаем все.
    const files = (invoice.file_name || '').split(',').map(s => s.trim()).filter(Boolean);
    if (files.length === 0) throw new Error(`Invoice ${invoiceId} has no file_name`);

    // Локатор фото: processed → failed (errored-накладные лежат там) → inbox.
    const locate = (name: string): string | undefined => [
      path.join(config.processedDir, name),
      path.join(config.failedDir, name),
      path.join(config.inboxDir, name),
    ].find(p => fs.existsSync(p));

    // OCR одной страницы — RESPECT analyzer_config.mode (как в processFile). Без
    // этого rescan скатывался в OCR-chain (Tesseract) + regex-парсер даже при
    // mode='claude_api', давая 0.00 сумм.
    const analyzerConfig = await invoiceRepo.getAnalyzerConfig();
    const recognizeOne = (fp: string) =>
      analyzerConfig.mode === 'claude_api' ? this.ocrManager.recognizeWithClaudeApi(fp, mappingOwnerId)
        : config.useClaudeAnalyzer ? this.ocrManager.recognizeHybrid(fp, mappingOwnerId, true)
          : this.ocrManager.recognize(fp);

    // Распознаём каждую найденную страницу по отдельности (как загрузка).
    const pages: { text: string; engine: string; structured?: ParsedInvoiceData }[] = [];
    for (const name of files) {
      const fp = locate(name) ?? (invoice.file_path && fs.existsSync(invoice.file_path) ? invoice.file_path : undefined);
      if (!fp) { logger.warn('Reprocess: page file not found, skipping', { invoiceId, name }); continue; }
      logger.info('Reprocessing page from existing file', { invoiceId, filePath: fp });
      const r = await recognizeOne(fp);
      pages.push({ text: r.text, engine: r.engine, structured: r.structured });
    }
    if (pages.length === 0) {
      throw new Error(`Original file(s) not found for invoice ${invoiceId} (looked for: ${files.join(', ')})`);
    }

    let parsed: ParsedInvoiceData | undefined;
    let ocrText: string;
    let ocrEngine: string;
    if (pages.length === 1) {
      parsed = pages[0].structured ?? parseInvoiceText({ text: pages[0].text, engine: pages[0].engine, words: [] });
      ocrText = pages[0].text;
      ocrEngine = pages[0].engine;
    } else {
      // Многостраничная: сшиваем как в processFile — объединённый текст всех
      // страниц → analyzeMultiPageText → единый structured (все позиции + общий
      // итог с последнего листа). Каждая страница читается тем же путём, что и
      // при загрузке, поэтому улучшения распознавания применяются к обеим.
      ocrText = pages.map(p => p.text).join('\n\n--- СТРАНИЦА ---\n\n');
      const pageCount = pages.length;
      logger.info('Reprocess multi-page: merging pages', { invoiceId, pageCount });
      const multi = await this.ocrManager.analyzeMultiPageText(ocrText, pageCount, mappingOwnerId);
      parsed = multi.structured;
      ocrEngine = multi.engine;
    }
    if (!parsed) {
      throw new Error('Failed to parse invoice — neither structured analyzer nor regex parser produced data');
    }
    parsed = await ocrCorrectionRepo.apply(
      parsed as unknown as Record<string, unknown>, mappingOwnerId,
    ) as unknown as ParsedInvoiceData;

    // Заменяем metadata + raw_text + items
    await invoiceRepo.deleteItems(invoiceId);
    await invoiceRepo.updateInvoiceData(invoiceId, {
      invoice_number: parsed.invoice_number,
      invoice_date: parsed.invoice_date,
      supplier: await this.resolveSupplier(parsed.supplier, parsed.supplier_inn, invoice.owner_user_id),
      total_sum: parsed.total_sum,
      vat_sum: parsed.vat_sum,
      invoice_type: parsed.invoice_type,
      supplier_inn: parsed.supplier_inn,
      supplier_kpp: parsed.supplier_kpp,
      supplier_bik: parsed.supplier_bik,
      supplier_account: parsed.supplier_account,
      supplier_corr_account: parsed.supplier_corr_account,
      supplier_address: parsed.supplier_address,
      raw_text: ocrText,
      ocr_engine: ocrEngine,
    });
    // Сбрасываем флаг дубликата — после rescan'а это уже потенциально другая
    // картина. Если новые реквизиты опять совпадут с другой накладной,
    // ручной флаг ставится через UI «Пересопоставить» либо повторным rescan'ом.
    if (invoice.duplicate_of != null) {
      await invoiceRepo.unmarkAsDuplicate(invoiceId);
    }

    // VAT sanity passes (как в processFile)
    const vatSanity = sanitizeInvoiceVat(
      parsed.items.map(i => ({
        quantity: i.quantity, unit: i.unit, price: i.price, total: i.total,
      })),
      parsed.total_sum,
      parsed.vat_sum,
    );
    if (vatSanity.report.scaled) {
      logger.info('Reprocess: invoice VAT sanity scaled', vatSanity.report);
    }
    const perItemVat = sanitizeItemVatPerItem(
      vatSanity.items.map((i, k) => ({
        quantity: i.quantity, unit: i.unit, price: i.price, total: i.total,
        vat_rate: parsed.items[k]?.vat_rate,
      })),
      parsed.total_sum,
    );
    const parsedItems = parsed.items.map((orig, i) => ({
      ...orig,
      price: perItemVat.items[i]?.price ?? orig.price,
      total: perItemVat.items[i]?.total ?? orig.total,
    }));

    // Mapping pipeline
    const analyzerCfg = await invoiceRepo.getAnalyzerConfig();
    const catalog = analyzerCfg.llm_mapper_enabled
      ? await onecNomenclatureRepo.listItems({ ownerUserId: mappingOwnerId, excludeFolders: true })
      : null;

    for (const item of parsedItems) {
      if (!item.name) continue;
      const sanity = sanitizeItemArithmetic({
        quantity: item.quantity, unit: item.unit, price: item.price, total: item.total,
      });

      const llmPicked = this.resolveCatalogIdx(item.catalog_idx, catalog);
      let mapping: MappingResult;
      const mappingContext = { supplierInn: parsed.supplier_inn, supplierName: parsed.supplier };
      const supplierOverride = await this.mapper.mapSupplierOverride(item.name, mappingOwnerId, mappingContext);
      if (supplierOverride) {
        mapping = supplierOverride;
      } else if (llmPicked) {
        const existingMapping = await mappingRepo.getByScannedName(item.name, mappingOwnerId);
        mapping = {
          original_name: item.name,
          mapped_name: llmPicked.name,
          onec_guid: llmPicked.guid,
          confidence: 1,
          source: 'learned',
          mapping_id: existingMapping?.id ?? null,
          pack_size: existingMapping?.pack_size ?? null,
          pack_unit: existingMapping?.pack_unit ?? null,
        };
        try {
          await mappingRepo.upsert({
            scanned_name: item.name,
            mapped_name_1c: llmPicked.name,
            onec_guid: llmPicked.guid,
            approved: false,
          }, mappingOwnerId);
        } catch (e) {
          logger.warn('Reprocess: failed to persist learned mapping', {
            name: item.name, error: (e as Error).message,
          });
        }
        this.mapper.invalidateCache();
      } else {
        mapping = await this.mapper.map(item.name, mappingOwnerId, mappingContext);
      }

      // packTransform runs unconditionally — even for unmapped items, the
      // pack_size hint expands qty correctly AND coerce relabels supplier
      // packs (уп/кор/банка) to "шт" so 1С never sees non-{шт,кг,л} units.
      const resolved = await (async () => {
        const onec1cUnit = mapping.onec_guid
          ? (await onecNomenclatureRepo.getByGuid(mapping.onec_guid, mappingOwnerId))?.unit ?? null
          : null;
        const hintedPackSize = item.pack_size ?? mapping.pack_size ?? null;
        const hintedPackUnit = item.pack_size ? 'шт' : (mapping.pack_unit ?? null);
        const r = resolveAndApplyPackTransform(
          sanity.item,
          item.name,
          hintedPackSize,
          hintedPackUnit,
          mapping.mapped_name,
          onec1cUnit,
        );
        if (mapping.mapping_id) await this.persistPackFallback(mapping.mapping_id, r, mappingOwnerId);
        return r;
      })();

      await invoiceRepo.addItem({
        invoice_id: invoiceId,
        original_name: item.name,
        mapped_name: mapping.mapped_name,
        quantity: resolved.item.quantity,
        unit: resolved.item.unit,
        price: resolved.item.price,
        total: resolved.item.total,
        vat_rate: item.vat_rate,
        mapping_confidence: mapping.confidence,
        onec_guid: mapping.onec_guid,
      });
    }

    await invoiceRepo.recalculateTotal(invoiceId);
    await invoiceRepo.updateStatus(invoiceId, 'processed');

    // The invoice is 'processed' now — relocate any page photos still sitting in
    // failedDir into processedDir so the file location matches the status and
    // photo-retention can eventually reclaim them (handles all pages).
    if (!config.dryRun) {
      for (const name of files) {
        const failedPath = path.join(config.failedDir, name);
        if (!fs.existsSync(failedPath)) continue;
        try {
          const dest = path.join(config.processedDir, name);
          if (!fs.existsSync(dest)) fs.renameSync(failedPath, dest);
        } catch (e) {
          logger.warn('Reprocess: could not move file failed→processed', { invoiceId, name, error: (e as Error).message });
        }
      }
    }

    logger.info('Invoice reprocessed successfully', {
      id: invoiceId,
      itemsCount: parsedItems.length,
      engine: ocrEngine,
    });
  }

  /**
   * Append a freshly-photographed page to an EXISTING invoice ("дофоткать"):
   * OCR the page, map + pack-transform its items, APPEND them to the invoice,
   * add the photo to the gallery, backfill header fields the invoice is still
   * missing, and bump total_sum if the page carries a bigger grand total.
   * The invoice's number/supplier/date stay canonical (first page wins) — only
   * empty fields are filled. Items are appended, never replaced.
   */
  async addPageToInvoice(invoiceId: number, filePath: string, fileName: string): Promise<number> {
    const invoice = await invoiceRepo.getById(invoiceId);
    if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);

    // Каталог, сопоставления и подсказка каталога для Claude — пер-тенантные:
    // весь разбор идёт в области владельца этой накладной. У «ничьей» накладной
    // каталога нет, сопоставление вернёт «не найдено» — это корректно.
    const mappingOwnerId = invoice.owner_user_id ?? -1;

    // OCR — respect analyzer_config.mode (как в processFile/reprocessInvoice).
    const analyzerConfig = await invoiceRepo.getAnalyzerConfig();
    let ocrResult;
    if (analyzerConfig.mode === 'claude_api') {
      ocrResult = await this.ocrManager.recognizeWithClaudeApi(filePath, mappingOwnerId);
    } else if (config.useClaudeAnalyzer) {
      ocrResult = await this.ocrManager.recognizeHybrid(filePath, mappingOwnerId, true);
    } else {
      ocrResult = await this.ocrManager.recognize(filePath);
    }
    const parsed = await ocrCorrectionRepo.apply(
      (ocrResult.structured ?? parseInvoiceText(ocrResult)) as unknown as Record<string, unknown>, mappingOwnerId,
    ) as unknown as ParsedInvoiceData;
    if (!parsed) throw new Error('Failed to parse the added page');

    // Photo → gallery; move file from inbox to processed so it serves and the
    // watcher never re-ingests it (best-effort — the move may already be done).
    try {
      const processedPath = path.join(config.processedDir, fileName);
      if (fs.existsSync(filePath) && !fs.existsSync(processedPath)) {
        fs.renameSync(filePath, processedPath);
      }
    } catch (e) {
      logger.warn('add-page: file move failed', { invoiceId, fileName, error: (e as Error).message });
    }
    await invoiceRepo.appendFileName(invoiceId, fileName);

    const added = await this.appendParsedPage(invoiceId, parsed);
    logger.info('Page added to invoice', { invoiceId, fileName, itemsAdded: added, engine: ocrResult.engine });
    return added;
  }

  /**
   * Fold an ALREADY-PARSED page into an existing invoice: append its items
   * (mapped + pack-transformed), backfill only the header fields the invoice is
   * still missing, bump total_sum to the bigger grand total, and recompute
   * total/VAT from the FULL item set (recalculateTotal derives vat_sum from
   * per-item rates). Items are appended, never replaced — nothing is lost.
   *
   * Deterministic, no OCR/Claude call. Shared by «дофоткать» (addPageToInvoice)
   * and the multi-page merge fallback, so a failed combined re-analysis still
   * keeps this page's data instead of dropping it.
   */
  private async appendParsedPage(targetInvoiceId: number, parsed: ParsedInvoiceData): Promise<number> {
    const target = await invoiceRepo.getById(targetInvoiceId);
    if (!target) throw new Error(`Invoice ${targetInvoiceId} not found`);

    // Каталог и сопоставления пер-тенантные: страница присоединяется к чужой
    // накладной, поэтому и сопоставляется в области ЕЁ владельца.
    const mappingOwnerId = target.owner_user_id ?? -1;

    let added = 0;
    for (const item of parsed.items) {
      if (!item.name) continue;
      const sanity = sanitizeItemArithmetic({
        quantity: item.quantity, unit: item.unit, price: item.price, total: item.total,
      });
      const mapping = await this.mapper.map(item.name, mappingOwnerId, { supplierInn: target.supplier_inn, supplierName: target.supplier });
      const onec1cUnit = mapping.onec_guid
        ? (await onecNomenclatureRepo.getByGuid(mapping.onec_guid, mappingOwnerId))?.unit ?? null
        : null;
      const hintedPackSize = item.pack_size ?? mapping.pack_size ?? null;
      const hintedPackUnit = item.pack_size ? 'шт' : (mapping.pack_unit ?? null);
      const r = resolveAndApplyPackTransform(
        sanity.item, item.name, hintedPackSize, hintedPackUnit, mapping.mapped_name, onec1cUnit,
      );
      await invoiceRepo.addItem({
        invoice_id: targetInvoiceId,
        original_name: item.name,
        mapped_name: mapping.mapped_name,
        quantity: r.item.quantity,
        unit: r.item.unit,
        price: r.item.price,
        total: r.item.total,
        vat_rate: item.vat_rate,
        mapping_confidence: mapping.confidence,
        onec_guid: mapping.onec_guid,
      });
      added++;
    }

    // Backfill only empty header fields; take the bigger grand total (the last
    // page prints the running total). recalculateTotal re-derives vat_sum and
    // re-checks the mismatch flag from the combined item set.
    await invoiceRepo.updateInvoiceData(targetInvoiceId, {
      supplier: target.supplier ? undefined : await this.resolveSupplier(parsed.supplier, parsed.supplier_inn, target.owner_user_id),
      invoice_number: target.invoice_number ? undefined : (parsed.invoice_number ?? undefined),
      invoice_date: target.invoice_date ? undefined : (parsed.invoice_date ?? undefined),
      supplier_inn: target.supplier_inn ? undefined : (parsed.supplier_inn ?? undefined),
      total_sum: (parsed.total_sum != null && (target.total_sum == null || parsed.total_sum > target.total_sum))
        ? parsed.total_sum : undefined,
    });
    // forceDerive: the stored vat_sum is the parent page's partial — after adding
    // this page's items it's stale, so recompute VAT from the full item set.
    await invoiceRepo.recalculateTotal(targetInvoiceId, { forceDerive: true });
    return added;
  }

  async processFile(filePath: string, fileName: string, forceEngine?: string, meta?: UploadMeta): Promise<number> {
    // 0. Content-based deduplication via SHA-256.
    // Hash is stored DURING the invoice INSERT under a UNIQUE partial index
    // on file_hash, which makes the dedup atomic: two concurrent uploads of
    // the same content race on the INSERT, and the loser gets back the winner's
    // invoice id via DuplicateFileHashError.
    let fileHash: string | null = null;
    try {
      fileHash = sha256File(filePath);
    } catch (e) {
      logger.warn('Failed to compute file hash, continuing without dedup', {
        filePath,
        error: (e as Error).message,
      });
    }

    // Cheap up-front check (cuts most obvious duplicates without hitting
    // the INSERT path at all). The UNIQUE index still protects us from races.
    if (fileHash) {
      const duplicate = await invoiceRepo.findByFileHash(fileHash);
      if (duplicate) {
        logger.info('Duplicate file detected by hash, returning existing invoice', {
          filePath,
          hash: fileHash.substring(0, 12),
          existingInvoiceId: duplicate.id,
        });
        if (!config.dryRun) {
          try {
            const destPath = path.join(config.processedDir, fileName);
            if (fs.existsSync(filePath)) fs.renameSync(filePath, destPath);
          } catch (err) {
            logger.debug('Could not move duplicate file', { filePath, error: (err as Error).message });
          }
        }
        return duplicate.id;
      }
    }

    // 1. Create invoice record (atomic dedup via UNIQUE partial index).
    let invoice;
    try {
      invoice = await invoiceRepo.create({
        file_name: fileName,
        file_path: filePath,
        file_hash: fileHash,
        upload_source: meta?.source ?? 'inbox',
        upload_user_agent: meta?.userAgent ?? null,
        owner_user_id: meta?.ownerUserId ?? null,
      });
    } catch (err) {
      if (err instanceof DuplicateFileHashError) {
        logger.info('Race: duplicate file hash hit on INSERT, reusing existing invoice', {
          filePath,
          hash: fileHash?.substring(0, 12),
          existingInvoiceId: err.existing.id,
        });
        if (!config.dryRun) {
          try {
            const destPath = path.join(config.processedDir, fileName);
            if (fs.existsSync(filePath)) fs.renameSync(filePath, destPath);
          } catch (moveErr) {
            logger.debug('Could not move racing duplicate file', { filePath, error: (moveErr as Error).message });
          }
        }
        return err.existing.id;
      }
      throw err;
    }

    // Каталог и сопоставления пер-тенантные: весь разбор этого файла идёт в
    // области владельца созданной накладной. Объявлено здесь, а не ниже, потому
    // что ветка многостраничного слияния обращается к каталогу раньше обычной.
    // У «ничьей» накладной каталога нет — сопоставление вернёт «не найдено», и
    // это корректно: претендента на неё не существует.
    const mappingOwnerId = invoice.owner_user_id ?? -1;

    // Fire-and-forget: notify that a new invoice row was created.
    emitNotification('photo_uploaded', {
      invoice_id: invoice.id,
      invoice_number: invoice.invoice_number,
      supplier: invoice.supplier,
      total_sum: invoice.total_sum,
    }, null).catch(() => {});

    try {
      // 2. OCR (hybrid mode: Google Vision + Claude analyzer if enabled)
      await invoiceRepo.updateStatus(invoice.id, 'ocr_processing');
      let ocrResult;
      if (path.extname(filePath).toLowerCase() === '.pdf') {
        // Anthropic supports native PDF document blocks. Other OCR engines in
        // the chain are image-only, so inbound/uploaded PDFs always take the
        // same structured Claude path as production images.
        ocrResult = await this.ocrManager.recognizeWithClaudeApi(filePath, mappingOwnerId);
      } else if (forceEngine) {
        ocrResult = await this.ocrManager.recognizeWithEngine(filePath, forceEngine);
      } else {
        // Check analyzer mode from DB config. Known values: 'claude_api', 'hybrid'.
        // Anything else is a misconfig — log loudly and fall back to hybrid so
        // we never silently downgrade to regex parsing without visibility.
        const analyzerConfig = await invoiceRepo.getAnalyzerConfig();
        const KNOWN_MODES = ['claude_api', 'hybrid', 'dispatcher'] as const;
        if (!KNOWN_MODES.includes(analyzerConfig.mode as typeof KNOWN_MODES[number])) {
          logger.error('Unknown analyzer_config.mode — falling back to hybrid', {
            mode: analyzerConfig.mode,
            knownModes: KNOWN_MODES,
            invoiceId: invoice.id,
          });
        }

        if (analyzerConfig.mode === 'dispatcher') {
          // Dispatcher mode: create task in ProjectsFlow, await async callback.
          // Don't run any local OCR — the dispatcher Claude Code session does it.
          // Move the file from inbox → processed BEFORE dispatching so the
          // photo endpoint can serve it (we won't reach the normal move-on-success
          // path below since we early-return).
          const processedPath = path.join(config.processedDir, fileName);
          try {
            if (fs.existsSync(filePath) && !fs.existsSync(processedPath)) {
              fs.renameSync(filePath, processedPath);
            }
          } catch (e) {
            // Watcher race / antivirus lock — log and proceed with whatever path exists.
            logger.warn('Dispatcher mode: file move failed, continuing', {
              from: filePath, to: processedPath, error: (e as Error).message,
            });
          }
          await invoiceRepo.updateFilePath(invoice.id, processedPath);
          const { dispatchInvoice } = await import('../dispatcher/createTask');
          await dispatchInvoice(invoice.id, fileName);
          logger.info('Dispatcher task created, awaiting callback', { invoiceId: invoice.id });
          return invoice.id; // status stays 'ocr_processing'; callback handler completes it
        }

        if (analyzerConfig.mode === 'claude_api') {
          // Claude API mode: send image directly to Anthropic API
          ocrResult = await this.ocrManager.recognizeWithClaudeApi(filePath, mappingOwnerId);
        } else if (config.useClaudeAnalyzer) {
          // Hybrid mode: Google Vision OCR + Claude API text analyzer
          ocrResult = await this.ocrManager.recognizeHybrid(filePath, mappingOwnerId, true);
        } else {
          // Last-resort fallback: Google Vision only + regex parser
          ocrResult = await this.ocrManager.recognize(filePath);
        }
      }

      await invoiceRepo.updateInvoiceData(invoice.id, {
        raw_text: ocrResult.text,
        ocr_engine: ocrResult.engine,
      });

      // 3. Parse: use Claude's structured data if available, else regex parser
      await invoiceRepo.updateStatus(invoice.id, 'parsing');
      const parsed = await ocrCorrectionRepo.apply(
        (ocrResult.structured ?? parseInvoiceText(ocrResult)) as unknown as Record<string, unknown>, mappingOwnerId,
      ) as unknown as ParsedInvoiceData;

      if (ocrResult.structured) {
        logger.info('Using Claude analyzer structured data', {
          itemsCount: parsed.items.length,
          invoiceNumber: parsed.invoice_number,
        });
      }

      // 4. Check for multi-page invoice
      let targetInvoiceId = invoice.id;
      let isMergedPage = false;

      // Concurrency guard: if THIS page looks like a continuation (no number, or
      // its first row_no > 1), wait for any earlier page that's still scanning to
      // finish — otherwise its supplier/items aren't committed yet and the merge
      // strategies below can't see it, forking one document into two (205/206).
      const firstRowNo0 = parsed.items[0]?.row_no;
      const looksLikeContinuation = !parsed.invoice_number
        || (firstRowNo0 != null && firstRowNo0 > 1);
      if (looksLikeContinuation) {
        await this.awaitInFlightPredecessors(invoice.id, 5);
      }

      // Strategy A: match by invoice_number (within last 10 minutes).
      // Supplier is passed through so that the digit-sequence fallback inside
      // findRecentByNumber can fuzzy-match supplier names that OCR read
      // differently across pages (e.g. "ООО МС ЛОГИСТИК" vs full legal form).
      let existingInvoice: Awaited<ReturnType<typeof invoiceRepo.findRecentByNumber>> = undefined;
      if (parsed.invoice_number) {
        existingInvoice = await invoiceRepo.findRecentByNumber(
          parsed.invoice_number,
          parsed.supplier ?? undefined,
          10
        );
      }

      // Strategy B: match by filename pattern (photo_1_... and photo_2_... with same timestamp)
      if (!existingInvoice) {
        const pageMatch = fileName.match(/^photo_(\d+)_(.+)$/);
        if (pageMatch && parseInt(pageMatch[1]) > 1) {
          const timestamp = pageMatch[2];
          existingInvoice = await invoiceRepo.findRecentByFileNamePattern(
            `photo_%_${timestamp}`,
            invoice.id,
            10
          );
          if (existingInvoice && existingInvoice.id !== invoice.id) {
            logger.info('Multi-page: matched by filename pattern', {
              currentFile: fileName,
              existingFile: existingInvoice.file_name,
            });
          }
        }
      }

      // Strategy B2: row-number continuation (works in BOTH directions).
      //
      // УПД pages can arrive in either order — sometimes page 2 is processed
      // before page 1 (concurrent reprocess, network jitter, etc.). We detect
      // continuation by checking the row_no column on both sides.
      //
      // Case A — current page is a "tail" (first row_no > 1):
      //   existing invoice should have exactly (first_row_no − 1) items.
      //   Example: current has row_no=10; existing has 9 items (rows 1-9).
      //
      // Case B — current page is a "head" (last row_no == items.length):
      //   existing invoice's first item should have row_no = current.items.length + 1.
      //   Example: current has 9 items with rows 1-9; existing has 1 item
      //   with row_no=10. (This fires when reprocess ran pages out of order.)
      //
      // Both rely on supplier match + 5 min window, so they won't accidentally
      // merge invoices from unrelated deliveries.
      if (!existingInvoice && parsed.supplier && parsed.items.length > 0) {
        const firstRowNo = parsed.items[0].row_no;
        const lastRowNo = parsed.items[parsed.items.length - 1].row_no;
        const candidate = await invoiceRepo.findRecentBySupplier(
          parsed.supplier,
          invoice.id,
          5,
        );
        if (candidate) {
          const existingItems = await invoiceRepo.getItems(candidate.id);

          // Case A: current is a continuation
          if (firstRowNo != null && firstRowNo > 1) {
            const gap = firstRowNo - (existingItems.length + 1);
            if (Math.abs(gap) <= 1) {
              existingInvoice = candidate;
              logger.info('Multi-page: matched by row_no continuation (current is tail)', {
                currentFile: fileName,
                existingFile: candidate.file_name,
                supplier: parsed.supplier,
                firstRowOnThisPage: firstRowNo,
                existingItemsCount: existingItems.length,
              });
            }
          }

          // Case B: current is the head; existing was processed first but is
          // really the tail. Only attempt if Case A didn't already match.
          if (!existingInvoice
            && lastRowNo != null && lastRowNo === parsed.items.length
            && existingItems.length > 0) {
            const existingFirstRow = await getFirstRowNo(candidate.id);
            if (existingFirstRow != null) {
              const gap = existingFirstRow - (lastRowNo + 1);
              if (Math.abs(gap) <= 1) {
                existingInvoice = candidate;
                logger.info('Multi-page: matched by row_no continuation (current is head, existing is tail)', {
                  currentFile: fileName,
                  existingFile: candidate.file_name,
                  supplier: parsed.supplier,
                  lastRowOnThisPage: lastRowNo,
                  existingFirstRowNo: existingFirstRow,
                });
              }
            }
          }
        }
      }

      // Strategy C: match by supplier within 5 minutes (camera rapid capture).
      //
      // Only merge if the CURRENT page lacks an invoice_number. If both pages
      // have numbers and they differ, these are TWO separate invoices from
      // the same supplier (common with back-to-back deliveries) — merging
      // them would silently concatenate items from unrelated documents.
      //
      // If the current page has a number that DOES match a recent invoice
      // (normalised), Strategy A above would've already caught it.
      if (!existingInvoice && parsed.supplier && !parsed.invoice_number) {
        existingInvoice = await invoiceRepo.findRecentBySupplier(
          parsed.supplier,
          invoice.id,
          5  // within last 5 minutes
        );
        if (existingInvoice && existingInvoice.id !== invoice.id) {
          logger.info('Multi-page: matched by supplier within 5 min (current page has no invoice_number)', {
            currentFile: fileName,
            existingFile: existingInvoice.file_name,
            supplier: parsed.supplier,
          });
        }
      }

      // Strategy D: temporal proximity fallback. If this page has no
      // invoice_number AND no supplier extracted (typical of the bottom
      // half of a УПД/ТОРГ-12 that shows only the end of the table and
      // signatures), treat it as a continuation of the most recent
      // processed invoice uploaded within the last 2 minutes. Without
      // this fallback, page 2 becomes an orphan row with empty metadata.
      //
      // Safety: only consults 'processed' rows (not 'parsing'), so we
      // never merge two concurrently-uploading invoices into each other.
      if (!existingInvoice && !parsed.invoice_number && !parsed.supplier) {
        existingInvoice = await invoiceRepo.findMostRecentProcessedForContinuation(invoice.id, 2);
        if (existingInvoice) {
          logger.info('Multi-page: matched by temporal proximity (no metadata on this page)', {
            currentFile: fileName,
            existingFile: existingInvoice.file_name,
            existingId: existingInvoice.id,
            parsedItemsCount: parsed.items.length,
          });
        }
      }

      // Предохранитель: если у обеих накладных есть непустой номер и они РАЗНЫЕ —
      // это заведомо разные документы. Мердж запрещён, какой бы эвристике (row_no,
      // supplier, время) он ни показался продолжением. Номер сильнее row_no —
      // инцидент 287/288, где две накладные ОМЕГА случайно подошли под B2 и №288
      // была проглочена combined re-analysis. См. src/services/mergeDecision.ts.
      if (existingInvoice && mergeBlockedByNumber(parsed, existingInvoice)) {
        logger.info('Multi-page merge blocked: different invoice numbers', {
          currentId: invoice.id,
          currentNumber: parsed.invoice_number,
          existingId: existingInvoice.id,
          existingNumber: existingInvoice.invoice_number,
        });
        existingInvoice = undefined;
      }

      if (existingInvoice && existingInvoice.id !== invoice.id) {
          // This is an additional page of an existing invoice
          logger.info('Multi-page invoice detected, merging into existing', {
            existingId: existingInvoice.id,
            newPageId: invoice.id,
            invoiceNumber: parsed.invoice_number,
          });

          targetInvoiceId = existingInvoice.id;
          isMergedPage = true;

          // Snapshot the existing invoice's raw_text BEFORE appending, so we
          // can build the correct "combined" text for re-analysis later. If
          // we read it back from DB after appendRawText, we'd double the new
          // page. This also captures the OCR text for the early-delete case
          // where the temp row is gone before re-analysis runs.
          const existingTextSnapshot = existingInvoice.raw_text || '';

          // Snapshot the two pages' footprints BEFORE any mutation — inputs to the
          // lost-data post-check after combined re-analysis. `parsed` holds THIS
          // page's items in memory, so even though the temp row is deleted early,
          // rollback (lossless append) needs nothing from the DB. See mergeDecision.ts.
          const existingItemsBefore = await invoiceRepo.getItems(existingInvoice.id);
          const mergePagesBefore = [
            { itemCount: existingItemsBefore.length, totalSum: existingInvoice.total_sum },
            { itemCount: parsed.items.length, totalSum: parsed.total_sum ?? null },
          ];

          // Append file name and raw text to existing invoice.
          await invoiceRepo.appendFileName(existingInvoice.id, fileName);
          await invoiceRepo.appendRawText(existingInvoice.id, ocrResult.text);

          // Move the page file into processedDir NOW, before the slow combined
          // re-analysis (a 10–60s Claude call). Otherwise the photo endpoint
          // serves from processedDir and 404s for the whole merge window — the
          // "can't view the 2nd photo" symptom. The later move-on-success/fallback
          // becomes a harmless no-op (guarded by existsSync).
          if (!config.dryRun) {
            try {
              const destPath = path.join(config.processedDir, fileName);
              if (fs.existsSync(filePath) && !fs.existsSync(destPath)) fs.renameSync(filePath, destPath);
            } catch { /* watcher race / already moved */ }
          }

          // Связь «страница → накладная» пишем ДО удаления: по ней потом
          // резолвится ссылка из бота. Уведомление photo_uploaded со ссылкой
          // /#/invoices/<id> ушло ещё до OCR, и без этой записи оно навсегда
          // указывало бы в никуда (инцидент 16.07 с накладной №654).
          await invoiceRepo.recordMerge(invoice.id, targetInvoiceId);
          // Пузыри читаем тоже до удаления: invoice_telegram_messages висит на
          // ON DELETE CASCADE и исчезнет вместе со строкой.
          const mergedBubbles = await invoiceRepo.getTelegramMessageIds(invoice.id);
          logger.info('Page merged into parent invoice', {
            sourceId: invoice.id,
            targetId: targetInvoiceId,
            ownerUserId: invoice.owner_user_id ?? null,
          });

          // CRITICAL: delete the temp invoice row NOW, before any failable
          // async work. Previously this delete happened at the end of the
          // merge path — if the process crashed / was restarted during the
          // multi-page re-analysis (a 10–60s Claude API call), or if any
          // intermediate step threw, the temp row stayed behind as an orphan
          // stuck in status 'parsing'. Early delete makes the merge atomic
          // from the moment append succeeds: either the page is folded into
          // the parent, or nothing happens (the parent is unchanged).
          await invoiceRepo.delete(invoice.id);

          // Переписываем осиротевший пузырь: иначе в чате навсегда остаётся
          // «Накладная №654 · Загружена» с мёртвой ссылкой. Ошибки глотаем —
          // уведомления не имеют права ломать конвейер (правило 9).
          void notifyPageMerged(invoice.owner_user_id ?? null, invoice.id, targetInvoiceId, mergedBubbles);

          // Re-process ALL pages together: combine OCR texts and send to Claude
          try {
            // Use the pre-append snapshot so combinedText is not doubled up
            const separator = '\n\n--- СТРАНИЦА ---\n\n';
            const combinedText = existingTextSnapshot + separator + ocrResult.text;
            const pageCount = combinedText.split('--- СТРАНИЦА ---').length;

            logger.info('Multi-page: re-analyzing combined OCR text', {
              pageCount,
              combinedTextLength: combinedText.length,
            });

            const multiResult = await this.ocrManager.analyzeMultiPageText(combinedText, pageCount, mappingOwnerId);
            if (multiResult.structured) {
              const unifiedParsed = await ocrCorrectionRepo.apply(
                multiResult.structured as unknown as Record<string, unknown>, mappingOwnerId,
              ) as unknown as ParsedInvoiceData;

              // Пост-проверка (Секция 2 спеки). Если объединённый разбор вернул
              // МЕНЬШЕ позиций или МЕНЬШУЮ сумму, чем было суммарно на страницах
              // до склейки — Claude схлопнул документы и потерял содержимое (ровно
              // симптом инцидента №288: unified 8900 при проглоченной 9000). Не
              // коммитим такой результат: бросаем — и lossless append-fallback ниже
              // детерминированно сложит ЭТУ страницу в родителя (у которого исходные
              // позиции ещё целы, deleteItems ещё не выполнен), все позиции сохранны.
              if (mergeLostData(mergePagesBefore, {
                itemCount: unifiedParsed.items.length,
                totalSum: unifiedParsed.total_sum ?? null,
              })) {
                logger.warn('Multi-page merge post-check: unified re-analysis lost data — folding via lossless append instead', {
                  targetInvoiceId,
                  before: mergePagesBefore,
                  unified: { itemCount: unifiedParsed.items.length, totalSum: unifiedParsed.total_sum },
                });
                throw new Error('multi-page unified result lost data (post-check)');
              }

              // Delete old items and re-save all from unified result
              await invoiceRepo.deleteItems(targetInvoiceId);

              // Update invoice metadata from unified result
              await invoiceRepo.updateInvoiceData(targetInvoiceId, {
                invoice_number: unifiedParsed.invoice_number,
                invoice_date: unifiedParsed.invoice_date,
                supplier: await this.resolveSupplier(unifiedParsed.supplier, unifiedParsed.supplier_inn, invoice.owner_user_id),
                total_sum: unifiedParsed.total_sum,
                vat_sum: unifiedParsed.vat_sum,
                invoice_type: unifiedParsed.invoice_type,
                supplier_inn: unifiedParsed.supplier_inn,
                supplier_kpp: unifiedParsed.supplier_kpp,
                ocr_engine: multiResult.engine,
                raw_text: combinedText,
              });

              // VAT sanity on the unified (post-merge) invoice.
              const mergedVatSanity = sanitizeInvoiceVat(
                unifiedParsed.items.map(i => ({
                  quantity: i.quantity, unit: i.unit, price: i.price, total: i.total,
                })),
                unifiedParsed.total_sum,
                unifiedParsed.vat_sum,
              );
              if (mergedVatSanity.report.scaled) {
                logger.info('Merged invoice VAT sanity: items scaled', mergedVatSanity.report);
              }
              const mergedPerItemVat = sanitizeItemVatPerItem(
                mergedVatSanity.items.map((i, k) => ({
                  quantity: i.quantity, unit: i.unit, price: i.price, total: i.total,
                  vat_rate: unifiedParsed.items[k]?.vat_rate,
                })),
                unifiedParsed.total_sum,
              );
              if (mergedPerItemVat.report.inflated > 0) {
                logger.info('Merged invoice per-item VAT sanity: lines inflated', mergedPerItemVat.report);
              }
              const mergedItems = unifiedParsed.items.map((orig, i) => ({
                ...orig,
                price: mergedPerItemVat.items[i]?.price ?? orig.price,
                total: mergedPerItemVat.items[i]?.total ?? orig.total,
              }));

              // Save unified items
              const mergedAnalyzerCfg = await invoiceRepo.getAnalyzerConfig();
              const mergedCatalog = mergedAnalyzerCfg.llm_mapper_enabled
                ? await onecNomenclatureRepo.listItems({ ownerUserId: mappingOwnerId, excludeFolders: true })
                : null;

              for (const item of mergedItems) {
                if (!item.name) continue;
                const sanity = sanitizeItemArithmetic({
                  quantity: item.quantity, unit: item.unit, price: item.price, total: item.total,
                });
                if (sanity.corrected) {
                  logger.info('Merged-item arithmetic sanitized', { name: item.name, reason: sanity.reason });
                }

                // LLM-mapper path (see normal flow below for full comment).
                const llmPicked = this.resolveCatalogIdx(item.catalog_idx, mergedCatalog);
                let mapping: MappingResult;
                const mappingContext = { supplierInn: parsed.supplier_inn, supplierName: parsed.supplier };
                const supplierOverride = await this.mapper.mapSupplierOverride(item.name, mappingOwnerId, mappingContext);
                if (supplierOverride) {
                  mapping = supplierOverride;
                } else if (llmPicked) {
                  mapping = {
                    original_name: item.name,
                    mapped_name: llmPicked.name,
                    onec_guid: llmPicked.guid,
                    confidence: 1,
                    source: 'learned',
                    mapping_id: null,
                    pack_size: null,
                    pack_unit: null,
                  };
                  try {
                    await mappingRepo.upsert({
                      scanned_name: item.name,
                      mapped_name_1c: llmPicked.name,
                      onec_guid: llmPicked.guid,
                      approved: false,
                    }, mappingOwnerId);
                  } catch (e) {
                    logger.warn('LLM-mapper (merge): failed to persist learned mapping', {
                      name: item.name, error: (e as Error).message,
                    });
                  }
                  this.mapper.invalidateCache();
                } else {
                  mapping = await this.mapper.map(item.name, mappingOwnerId, mappingContext);
                }

                // packTransform unconditionally: container/looksLikeContainer
                // guard inside protects against false anchors like "500мл" in
                // "К-139, 500мл 139х102х56мм (х50/500)". For mapped items
                // 1С unit drives the conversion; for unmapped, coerce still
                // relabels supplier packs (уп/кор/банка) to "шт".
                const mergedResolved = await (async () => {
                  const onec1cUnit = mapping.onec_guid
                    ? (await onecNomenclatureRepo.getByGuid(mapping.onec_guid, mappingOwnerId))?.unit ?? null
                    : null;
                  const hintedPackSize = item.pack_size ?? mapping.pack_size ?? null;
                  const hintedPackUnit = item.pack_size ? 'шт' : (mapping.pack_unit ?? null);
                  const r = resolveAndApplyPackTransform(
                    sanity.item,
                    item.name,
                    hintedPackSize,
                    hintedPackUnit,
                    mapping.mapped_name,
                    onec1cUnit,
                  );
                  if (mapping.mapping_id) await this.persistPackFallback(mapping.mapping_id, r, mappingOwnerId);
                  return r;
                })();
                await invoiceRepo.addItem({
                  invoice_id: targetInvoiceId,
                  original_name: item.name,
                  mapped_name: mapping.mapped_name,
                  quantity: mergedResolved.item.quantity,
                  unit: mergedResolved.item.unit,
                  price: mergedResolved.item.price,
                  total: mergedResolved.item.total,
                  vat_rate: item.vat_rate,
                  mapping_confidence: mapping.confidence,
                  onec_guid: mapping.onec_guid,
                });
              }

              await invoiceRepo.recalculateTotal(targetInvoiceId);
              await invoiceRepo.updateStatus(targetInvoiceId, 'processed');

              const totalItems = await invoiceRepo.getItems(targetInvoiceId);
              logger.info('Multi-page invoice merged via combined OCR text', {
                id: targetInvoiceId,
                totalItemsCount: totalItems.length,
                totalSum: unifiedParsed.total_sum,
              });

              // Fire-and-forget notifications for recognised invoice.
              const finalInvoice = await invoiceRepo.getById(targetInvoiceId);
              if (finalInvoice) {
                emitNotification('invoice_recognized', {
                  invoice_id: finalInvoice.id,
                  invoice_number: finalInvoice.invoice_number,
                  supplier: finalInvoice.supplier,
                  total_sum: finalInvoice.total_sum,
                }, null).catch(() => {});
                emitElevatedPricesIfAny(finalInvoice.id).catch(() => {});
                if (finalInvoice.items_total_mismatch === 1) {
                  const finalItems = await invoiceRepo.getItems(finalInvoice.id);
                  const itemsTotal = finalItems.reduce((sum, it) => sum + (it.total ?? 0), 0);
                  emitNotification('suspicious_total', {
                    invoice_id: finalInvoice.id,
                    invoice_number: finalInvoice.invoice_number,
                    supplier: finalInvoice.supplier,
                    total_sum: finalInvoice.total_sum,
                    items_total: itemsTotal,
                  }, null).catch(() => {});
                }
              }

              // Move file to processed
              if (!config.dryRun) {
                try {
                  const destPath = path.join(config.processedDir, fileName);
                  fs.renameSync(filePath, destPath);
                } catch { /* may already be moved */ }
              }

              return targetInvoiceId;
            }
            // Re-analysis returned no structured data — fall through to the
            // append fallback below so this page's items aren't lost.
            throw new Error('multi-page re-analysis returned no structured data');
          } catch (err) {
            // The combined re-analysis is a SECOND Claude call — it can time
            // out or error, and the temp page row was already deleted above.
            // Without a real fallback, this page's items/total/VAT vanish
            // (the bug behind invoice #194 looking half-merged). Fold THIS
            // page's already-parsed data into the parent deterministically.
            logger.warn('Multi-page re-analysis failed — folding page in via lossless append', {
              error: (err as Error).message, targetInvoiceId, newPageId: invoice.id,
            });
            try {
              const appended = await this.appendParsedPage(targetInvoiceId, parsed);
              logger.info('Multi-page merged via append fallback', { targetInvoiceId, itemsAppended: appended });
            } catch (appendErr) {
              logger.error('Multi-page append fallback ALSO failed — page data may be incomplete', {
                targetInvoiceId, newPageId: invoice.id, error: (appendErr as Error).message,
              });
            }
            if (!config.dryRun) {
              try {
                const destPath = path.join(config.processedDir, fileName);
                if (fs.existsSync(filePath)) fs.renameSync(filePath, destPath);
              } catch { /* may already be moved */ }
            }
            return targetInvoiceId;
          }
        }

      if (!isMergedPage) {
        // Normal flow: update the new invoice with parsed data
        await invoiceRepo.updateInvoiceData(invoice.id, {
          invoice_number: parsed.invoice_number,
          invoice_date: parsed.invoice_date,
          supplier: await this.resolveSupplier(parsed.supplier, parsed.supplier_inn, invoice.owner_user_id),
          total_sum: parsed.total_sum,
          vat_sum: parsed.vat_sum,
          invoice_type: parsed.invoice_type,
          supplier_inn: parsed.supplier_inn,
          supplier_kpp: parsed.supplier_kpp,
          supplier_bik: parsed.supplier_bik,
          supplier_account: parsed.supplier_account,
          supplier_corr_account: parsed.supplier_corr_account,
          supplier_address: parsed.supplier_address,
        });

        // Duplicate detector: 30-day window, matches by invoice_number +
        // supplier (INN preferred, name fallback) + invoice_date + total_sum.
        // Only fires on non-merged invoices — multi-page pages are already
        // unified by Strategy A/B/C/D above. If detected, we mark this row
        // as duplicate and SKIP the items pipeline below — there's nothing
        // to add (the original already has the items).
        const dupOriginal = await invoiceRepo.findDuplicateOriginal(
          invoice.id,
          parsed.invoice_number ?? null,
          parsed.supplier_inn ?? null,
          parsed.supplier ? canonicalizeSupplierName(parsed.supplier) : null,
          parsed.invoice_date ?? null,
          parsed.total_sum ?? null,
          30,
          parsed.items,
          { account: parsed.supplier_account, bic: parsed.supplier_bik },
        );
        if (dupOriginal) {
          logger.info('Duplicate invoice detected', {
            newId: invoice.id,
            originalId: dupOriginal.id,
            invoiceNumber: parsed.invoice_number,
            supplier: parsed.supplier,
            totalSum: parsed.total_sum,
          });
          await invoiceRepo.markAsDuplicate(
            invoice.id,
            dupOriginal.id,
            dupOriginal.duplicate_score,
            dupOriginal.duplicate_reasons,
          );

          // Move file to processed before returning, как в normal flow ниже
          if (!config.dryRun) {
            try {
              const destPath = path.join(config.processedDir, fileName);
              fs.renameSync(filePath, destPath);
            } catch { /* may already be moved */ }
          }
          return invoice.id;
        }
      }

      // 5. VAT sanity: if Claude put pre-VAT numbers into items but post-VAT
      // into total_sum, scale items up to be consistent. See itemSanitizer.
      const vatSanity = sanitizeInvoiceVat(
        parsed.items.map(i => ({
          quantity: i.quantity, unit: i.unit, price: i.price, total: i.total,
        })),
        parsed.total_sum,
        parsed.vat_sum,
      );
      if (vatSanity.report.scaled) {
        logger.info('Invoice VAT sanity: items scaled', vatSanity.report);
      }
      // 5b. Per-item VAT fix: Claude sometimes mixes "сумма без НДС" and
      // "сумма с НДС" columns between rows (caught in ТОРГ-12 invoices with
      // many items). Invoice-level sanitizer above only handles all-pre-VAT
      // or all-post-VAT. This pass targets individual clean-pre-VAT lines.
      const perItemVat = sanitizeItemVatPerItem(
        vatSanity.items.map((i, k) => ({
          quantity: i.quantity, unit: i.unit, price: i.price, total: i.total,
          vat_rate: parsed.items[k]?.vat_rate,
        })),
        parsed.total_sum,
      );
      if (perItemVat.report.inflated > 0) {
        logger.info('Invoice per-item VAT sanity: lines inflated', perItemVat.report);
      }
      // Merge sanitised numbers back into parsed.items (preserve name, vat_rate).
      const parsedItems = parsed.items.map((orig, i) => ({
        ...orig,
        price: perItemVat.items[i]?.price ?? orig.price,
        total: perItemVat.items[i]?.total ?? orig.total,
      }));

      // 6. Map nomenclature and save items (to target invoice)
      // If LLM-mapper is on, Claude has already chosen catalog_idx per item.
      // Resolve those first; fall back to fuzzy mapper only when LLM missed.
      const analyzerCfg = await invoiceRepo.getAnalyzerConfig();
      const catalog = analyzerCfg.llm_mapper_enabled
        ? await onecNomenclatureRepo.listItems({ ownerUserId: mappingOwnerId, excludeFolders: true })
        : null;

      for (const item of parsedItems) {
        if (!item.name) continue; // skip items without a name
        const sanity = sanitizeItemArithmetic({
          quantity: item.quantity, unit: item.unit, price: item.price, total: item.total,
        });
        if (sanity.corrected) {
          logger.info('Item arithmetic sanitized', { name: item.name, reason: sanity.reason });
        }

        // LLM-mapper path: Claude returned a catalog_idx → use it as the
        // source of truth. This beats fuzzy because Claude understands
        // context (brand/OCR garbage) that Jaccard tokens can't.
        const llmPicked = this.resolveCatalogIdx(item.catalog_idx, catalog);
        let mapping: MappingResult;
        const mappingContext = { supplierInn: parsed.supplier_inn, supplierName: parsed.supplier };
        const supplierOverride = await this.mapper.mapSupplierOverride(item.name, mappingOwnerId, mappingContext);
        if (supplierOverride) {
          mapping = supplierOverride;
        } else if (llmPicked) {
          // Preserve any previously-learned pack transform on the existing
          // mapping (if any) so pack-transform still fires even when LLM
          // picked the GUID. Look up by scanned_name.
          const existingMapping = await mappingRepo.getByScannedName(item.name, mappingOwnerId);
          mapping = {
            original_name: item.name,
            mapped_name: llmPicked.name,
            onec_guid: llmPicked.guid,
            confidence: 1,
            source: 'learned',
            mapping_id: existingMapping?.id ?? null,
            pack_size: existingMapping?.pack_size ?? null,
            pack_unit: existingMapping?.pack_unit ?? null,
          };
          // Teach the fuzzy mapper for future invoices where LLM might be off.
          try {
            await mappingRepo.upsert({
              scanned_name: item.name,
              mapped_name_1c: llmPicked.name,
              onec_guid: llmPicked.guid,
              approved: false,
            }, mappingOwnerId);
          } catch (e) {
            logger.warn('LLM-mapper: failed to persist learned mapping', {
              name: item.name, error: (e as Error).message,
            });
          }
          this.mapper.invalidateCache();
        } else {
          mapping = await this.mapper.map(item.name, mappingOwnerId, mappingContext);
        }

        // packTransform unconditionally: Claude's pack_size hint ("*48",
        // "1/12") expands qty even for unmapped rows, and coerce relabels
        // supplier packs to "шт" so 1С never sees уп/кор/банка.
        const resolved = await (async () => {
          const onec1cUnit = mapping.onec_guid
            ? (await onecNomenclatureRepo.getByGuid(mapping.onec_guid, mappingOwnerId))?.unit ?? null
            : null;
          const hintedPackSize = item.pack_size ?? mapping.pack_size ?? null;
          const hintedPackUnit = item.pack_size ? 'шт' : (mapping.pack_unit ?? null);
          const r = resolveAndApplyPackTransform(
            sanity.item,
            item.name,
            hintedPackSize,
            hintedPackUnit,
            mapping.mapped_name,
            onec1cUnit,
          );
          if (mapping.mapping_id) await this.persistPackFallback(mapping.mapping_id, r, mappingOwnerId);
          return r;
        })();
        await invoiceRepo.addItem({
          invoice_id: targetInvoiceId,
          original_name: item.name,
          mapped_name: mapping.mapped_name,
          quantity: resolved.item.quantity,
          unit: resolved.item.unit,
          price: resolved.item.price,
          total: resolved.item.total,
          vat_rate: item.vat_rate,
          mapping_confidence: mapping.confidence,
          onec_guid: mapping.onec_guid,
        });
      }

      // 6. If merged, recalculate total. (The temp invoice row was already
      //    deleted above, immediately after appendFileName/appendRawText, so
      //    we don't need to delete it again here.)
      if (isMergedPage) {
        await invoiceRepo.recalculateTotal(targetInvoiceId);

        const existingItems = await invoiceRepo.getItems(targetInvoiceId);
        logger.info('Invoice pages merged successfully (append mode)', {
          id: targetInvoiceId,
          totalItemsCount: existingItems.length,
          addedItemsCount: parsed.items.length,
        });
      } else {
        // 7. Recalculate total + flag mismatch, then mark processed.
        // Without this, single-page invoices never got validated — a Claude
        // OCR blunder (e.g. reading "165 229,2" as 1652292) would slip
        // straight into total_sum with items_total_mismatch=0.
        await invoiceRepo.recalculateTotal(invoice.id);
        await invoiceRepo.updateStatus(invoice.id, 'processed');
        logger.info('Invoice processed successfully', {
          id: invoice.id,
          fileName,
          itemsCount: parsed.items.length,
          engine: ocrResult.engine,
        });

        // Fire-and-forget notifications for recognised invoice.
        const finalInvoice = await invoiceRepo.getById(invoice.id);
        if (finalInvoice) {
          emitNotification('invoice_recognized', {
            invoice_id: finalInvoice.id,
            invoice_number: finalInvoice.invoice_number,
            supplier: finalInvoice.supplier,
            total_sum: finalInvoice.total_sum,
          }, null).catch(() => {});
          emitElevatedPricesIfAny(finalInvoice.id).catch(() => {});
          if (finalInvoice.items_total_mismatch === 1) {
            const finalItems = await invoiceRepo.getItems(finalInvoice.id);
            const itemsTotal = finalItems.reduce((sum, it) => sum + (it.total ?? 0), 0);
            emitNotification('suspicious_total', {
              invoice_id: finalInvoice.id,
              invoice_number: finalInvoice.invoice_number,
              supplier: finalInvoice.supplier,
              total_sum: finalInvoice.total_sum,
              items_total: itemsTotal,
            }, null).catch(() => {});
          }
        }
      }

      // 8. Auto-send hooks (если включены в Настройках). Skip для duplicate
      // и error статусов, чтобы не отправлять кривое.
      try {
        const finalInv = await invoiceRepo.getById(targetInvoiceId);
        const cfg = await invoiceRepo.getAnalyzerConfig();
        const quality = await evaluateInvoiceQuality(targetInvoiceId);
        const canAutoSend = !!finalInv && quality.allowed;
        if (!quality.allowed && (cfg.auto_send_1c || cfg.auto_send_sber)) {
          logger.info('Autopilot quality gate held invoice', {
            id: targetInvoiceId,
            score: quality.score,
            reasons: quality.reasons.map(reason => reason.code),
          });
        }

        // Legacy webhook flag — оставляем для back-compat. ИЛИ с новым analyzer_config.
        // Настройка вебхука пер-тенантная: читаем её от имени владельца накладной,
        // у «ничьей» строки легаси-флага просто нет (остаётся analyzer_config).
        const legacyAuto1c = finalInv?.owner_user_id != null
          && await webhookConfigRepo.autoSend1cEnabled(finalInv.owner_user_id);
        const wantAuto1c = legacyAuto1c || cfg.auto_send_1c;

        if (canAutoSend && wantAuto1c) {
          await invoiceRepo.approveForOneC(targetInvoiceId);
          logger.info('Auto-approved for 1C', { id: targetInvoiceId });
        }

        // Auto-send Sber через loopback HTTP (переиспользует всю логику
        // /send-sber endpoint: check supplier verified, payer details,
        // create payment row, call Sber API). API key админа берётся из БД.
        if (canAutoSend && cfg.auto_send_sber) {
          await autoSendSberForInvoice(targetInvoiceId);
        }
      } catch (e) {
        logger.warn('Auto-send hooks failed', { id: targetInvoiceId, error: (e as Error).message });
      }

      // 9. Move file to processed
      if (!config.dryRun) {
        try {
          const destPath = path.join(config.processedDir, fileName);
          fs.renameSync(filePath, destPath);
          logger.debug('File moved to processed', { from: filePath, to: destPath });
        } catch {
          // File may already be moved by another process or watcher event
          logger.warn('Could not move file to processed (may already be moved)', { filePath });
        }
      }

      return targetInvoiceId;
    } catch (err) {
      const errorMsg = (err as Error).message;
      await invoiceRepo.updateStatus(invoice.id, 'error', errorMsg);
      logger.error('Invoice processing failed', { id: invoice.id, fileName, error: errorMsg });

      // Fire-and-forget notification for recognition failure.
      emitNotification('recognition_error', {
        invoice_id: invoice.id,
        invoice_number: invoice.invoice_number,
        supplier: invoice.supplier,
        total_sum: invoice.total_sum,
        error_message: errorMsg,
      }, null).catch(() => {});

      // Email notification
      sendErrorEmail(
        `Ошибка обработки накладной: ${fileName}`,
        `Файл: ${fileName}\nID: ${invoice.id}\n\nОшибка:\n${errorMsg}\n\nStack:\n${(err as Error).stack || '—'}`
      ).catch(() => {});

      // Move to failed
      if (!config.dryRun) {
        try {
          const destPath = path.join(config.failedDir, fileName);
          fs.renameSync(filePath, destPath);
          logger.debug('File moved to failed', { from: filePath, to: destPath });
        } catch {
          // File might already be moved or deleted
        }
      }

      throw err;
    }
  }
}
