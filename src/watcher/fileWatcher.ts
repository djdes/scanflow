import { watch, type FSWatcher } from 'chokidar';
import path from 'path';
import fs from 'fs';
import { config } from '../config';
import { logger } from '../utils/logger';
import { OcrManager } from '../ocr/ocrManager';
import { parseInvoiceText } from '../parser/invoiceParser';
import { NomenclatureMapper } from '../mapping/nomenclatureMapper';
import { invoiceRepo, DuplicateFileHashError } from '../database/repositories/invoiceRepo';
import { mappingRepo } from '../database/repositories/mappingRepo';
import { onecNomenclatureRepo, OnecNomenclatureRow } from '../database/repositories/onecNomenclatureRepo';
import type { MappingResult } from '../mapping/nomenclatureMapper';
import { sendErrorEmail } from '../utils/mailer';
import { canonicalizeSupplierName } from '../utils/invoiceNumber';
import { sha256File } from '../utils/fileHash';
import { resolveAndApplyPackTransform } from '../mapping/packTransform';
import { sanitizeItemArithmetic, sanitizeInvoiceVat, sanitizeItemVatPerItem } from '../parser/itemSanitizer';
import { emit as emitNotification, emitElevatedPricesIfAny } from '../notifications/events';

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

    try {
      await this.processFile(filePath, fileName);
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
  ): Promise<void> {
    if (!mappingId || !resolved.usedFallback) return;
    if (!resolved.packSize || !resolved.packUnit) return;
    try {
      await mappingRepo.update(mappingId, {
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
   * Отправить накладную в Сбер.Бизнес через loopback HTTP — переиспользуем
   * всю валидацию /send-sber endpoint без дублирования кода. API-ключ берётся
   * у первого админа (single-tenant система). Если что-то не получилось
   * (нет supplier verified, нет sber_token, Sber API вернул 4xx) — log warn
   * и продолжаем; накладная остаётся доступной для ручной отправки через UI.
   */
  private async autoSendSber(invoiceId: number): Promise<void> {
    try {
      const adminId = await (await import('../database/repositories/userRepo')).userRepo.firstUserId();
      if (!adminId) {
        logger.warn('Auto-send Sber: no admin user', { invoiceId });
        return;
      }
      const db = (await import('../database/db')).getDb();
      const row = await db.prepare('SELECT api_key FROM users WHERE id = ?').get<{ api_key: string }>(adminId);
      const apiKey = row?.api_key;
      if (!apiKey) {
        logger.warn('Auto-send Sber: admin has no api_key', { invoiceId });
        return;
      }

      const url = `http://127.0.0.1:${config.apiPort}/api/invoices/${invoiceId}/send-sber`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({})) as { payment_number?: string };
        logger.info('Auto-sent to Sber', { invoiceId, paymentNumber: data.payment_number ?? null });
      } else {
        const text = await res.text().catch(() => '');
        logger.warn('Auto-send Sber rejected', {
          invoiceId, status: res.status, body: text.slice(0, 300),
        });
      }
    } catch (err) {
      logger.warn('Auto-send Sber error', {
        invoiceId, error: (err as Error).message,
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
  async reprocessInvoice(invoiceId: number): Promise<void> {
    const invoice = await invoiceRepo.getById(invoiceId);
    if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);

    const firstFile = (invoice.file_name || '').split(',')[0].trim();
    if (!firstFile) throw new Error(`Invoice ${invoiceId} has no file_name`);

    const candidates = [
      path.join(config.processedDir, firstFile),
      path.join(config.inboxDir, firstFile),
      invoice.file_path || '',
    ].filter(Boolean);
    const filePath = candidates.find(p => fs.existsSync(p));
    if (!filePath) {
      throw new Error(`Original file not found in any of: ${candidates.join(', ')}`);
    }

    logger.info('Reprocessing invoice from existing file', { invoiceId, filePath });

    // OCR + structured parse — RESPECT analyzer_config.mode (как в processFile).
    // Без этого rescan скатывался в OCR-chain (Tesseract) и regex-парсер
    // даже при mode='claude_api', давая 0.00 сумм.
    const analyzerConfig = await invoiceRepo.getAnalyzerConfig();
    let ocrResult;
    if (analyzerConfig.mode === 'claude_api') {
      ocrResult = await this.ocrManager.recognizeWithClaudeApi(filePath);
    } else if (config.useClaudeAnalyzer) {
      ocrResult = await this.ocrManager.recognizeHybrid(filePath, true);
    } else {
      ocrResult = await this.ocrManager.recognize(filePath);
    }
    let parsed = ocrResult.structured;
    if (!parsed) {
      parsed = parseInvoiceText(ocrResult);
    }
    if (!parsed) {
      throw new Error('Failed to parse invoice — neither structured analyzer nor regex parser produced data');
    }

    // Заменяем metadata + raw_text + items
    await invoiceRepo.deleteItems(invoiceId);
    await invoiceRepo.updateInvoiceData(invoiceId, {
      invoice_number: parsed.invoice_number,
      invoice_date: parsed.invoice_date,
      supplier: parsed.supplier ? canonicalizeSupplierName(parsed.supplier) : undefined,
      total_sum: parsed.total_sum,
      vat_sum: parsed.vat_sum,
      invoice_type: parsed.invoice_type,
      supplier_inn: parsed.supplier_inn,
      supplier_kpp: parsed.supplier_kpp,
      supplier_bik: parsed.supplier_bik,
      supplier_account: parsed.supplier_account,
      supplier_corr_account: parsed.supplier_corr_account,
      supplier_address: parsed.supplier_address,
      raw_text: ocrResult.text,
      ocr_engine: ocrResult.engine,
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
      ? await onecNomenclatureRepo.listItems({ excludeFolders: true })
      : null;

    for (const item of parsedItems) {
      if (!item.name) continue;
      const sanity = sanitizeItemArithmetic({
        quantity: item.quantity, unit: item.unit, price: item.price, total: item.total,
      });

      const llmPicked = this.resolveCatalogIdx(item.catalog_idx, catalog);
      let mapping: MappingResult;
      if (llmPicked) {
        const existingMapping = await mappingRepo.getByScannedName(item.name);
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
          });
        } catch (e) {
          logger.warn('Reprocess: failed to persist learned mapping', {
            name: item.name, error: (e as Error).message,
          });
        }
        this.mapper.invalidateCache();
      } else {
        mapping = await this.mapper.map(item.name);
      }

      const resolved = mapping.onec_guid
        ? await (async () => {
            const onec1cUnit = (await onecNomenclatureRepo.getByGuid(mapping.onec_guid!))?.unit ?? null;
            const hintedPackSize = item.pack_size ?? mapping.pack_size;
            const hintedPackUnit = item.pack_size ? 'шт' : mapping.pack_unit;
            const r = resolveAndApplyPackTransform(
              sanity.item,
              item.name,
              hintedPackSize,
              hintedPackUnit,
              mapping.mapped_name,
              onec1cUnit,
            );
            await this.persistPackFallback(mapping.mapping_id, r);
            return r;
          })()
        : { item: sanity.item, packSize: null, packUnit: null, usedFallback: false };

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

    logger.info('Invoice reprocessed successfully', {
      id: invoiceId,
      itemsCount: parsedItems.length,
      engine: ocrResult.engine,
    });
  }

  async processFile(filePath: string, fileName: string, forceEngine?: string): Promise<number> {
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
      if (forceEngine) {
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
          ocrResult = await this.ocrManager.recognizeWithClaudeApi(filePath);
        } else if (config.useClaudeAnalyzer) {
          // Hybrid mode: Google Vision OCR + Claude API text analyzer
          ocrResult = await this.ocrManager.recognizeHybrid(filePath, true);
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
      const parsed = ocrResult.structured ?? parseInvoiceText(ocrResult);

      if (ocrResult.structured) {
        logger.info('Using Claude analyzer structured data', {
          itemsCount: parsed.items.length,
          invoiceNumber: parsed.invoice_number,
        });
      }

      // 4. Check for multi-page invoice
      let targetInvoiceId = invoice.id;
      let isMergedPage = false;

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

          // Append file name and raw text to existing invoice.
          await invoiceRepo.appendFileName(existingInvoice.id, fileName);
          await invoiceRepo.appendRawText(existingInvoice.id, ocrResult.text);

          // CRITICAL: delete the temp invoice row NOW, before any failable
          // async work. Previously this delete happened at the end of the
          // merge path — if the process crashed / was restarted during the
          // multi-page re-analysis (a 10–60s Claude API call), or if any
          // intermediate step threw, the temp row stayed behind as an orphan
          // stuck in status 'parsing'. Early delete makes the merge atomic
          // from the moment append succeeds: either the page is folded into
          // the parent, or nothing happens (the parent is unchanged).
          await invoiceRepo.delete(invoice.id);

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

            const multiResult = await this.ocrManager.analyzeMultiPageText(combinedText, pageCount);
            if (multiResult.structured) {
              const unifiedParsed = multiResult.structured;

              // Delete old items and re-save all from unified result
              await invoiceRepo.deleteItems(targetInvoiceId);

              // Update invoice metadata from unified result
              await invoiceRepo.updateInvoiceData(targetInvoiceId, {
                invoice_number: unifiedParsed.invoice_number,
                invoice_date: unifiedParsed.invoice_date,
                supplier: unifiedParsed.supplier ? canonicalizeSupplierName(unifiedParsed.supplier) : undefined,
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
                ? await onecNomenclatureRepo.listItems({ excludeFolders: true })
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
                if (llmPicked) {
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
                    });
                  } catch (e) {
                    logger.warn('LLM-mapper (merge): failed to persist learned mapping', {
                      name: item.name, error: (e as Error).message,
                    });
                  }
                  this.mapper.invalidateCache();
                } else {
                  mapping = await this.mapper.map(item.name);
                }

                // Pack-transform only runs when we KNOW where the row maps.
                // For unmapped rows we'd be guessing at the 1C unit, which
                // historically blew up quantities (e.g. packaging names like
                // "К-139, 500мл 139х102х56мм (х50/500)" had "500мл" mistaken
                // as a pack-size anchor). Better to let llm-remap handle them
                // later with an explicit pack_size hint.
                const mergedResolved = mapping.onec_guid
                  ? await (async () => {
                      const onec1cUnit = (await onecNomenclatureRepo.getByGuid(mapping.onec_guid!))?.unit ?? null;
                      const hintedPackSize = item.pack_size ?? mapping.pack_size;
                      const hintedPackUnit = item.pack_size ? 'шт' : mapping.pack_unit;
                      const r = resolveAndApplyPackTransform(
                        sanity.item,
                        item.name,
                        hintedPackSize,
                        hintedPackUnit,
                        mapping.mapped_name,
                        onec1cUnit,
                      );
                      await this.persistPackFallback(mapping.mapping_id, r);
                      return r;
                    })()
                  : { item: sanity.item, packSize: null, packUnit: null, usedFallback: false };
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
          } catch (err) {
            logger.warn('Multi-page text re-analysis failed, falling back to append mode', {
              error: (err as Error).message,
            });
          }
        }

      if (!isMergedPage) {
        // Normal flow: update the new invoice with parsed data
        await invoiceRepo.updateInvoiceData(invoice.id, {
          invoice_number: parsed.invoice_number,
          invoice_date: parsed.invoice_date,
          supplier: parsed.supplier ? canonicalizeSupplierName(parsed.supplier) : undefined,
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
        );
        if (dupOriginal) {
          logger.info('Duplicate invoice detected', {
            newId: invoice.id,
            originalId: dupOriginal.id,
            invoiceNumber: parsed.invoice_number,
            supplier: parsed.supplier,
            totalSum: parsed.total_sum,
          });
          await invoiceRepo.markAsDuplicate(invoice.id, dupOriginal.id);

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
        ? await onecNomenclatureRepo.listItems({ excludeFolders: true })
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
        if (llmPicked) {
          // Preserve any previously-learned pack transform on the existing
          // mapping (if any) so pack-transform still fires even when LLM
          // picked the GUID. Look up by scanned_name.
          const existingMapping = await mappingRepo.getByScannedName(item.name);
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
            });
          } catch (e) {
            logger.warn('LLM-mapper: failed to persist learned mapping', {
              name: item.name, error: (e as Error).message,
            });
          }
          this.mapper.invalidateCache();
        } else {
          mapping = await this.mapper.map(item.name);
        }

        // Pack-transform only runs when we KNOW where the row maps.
        // Unmapped rows go in as-is — llm-remap will handle them later with
        // an explicit pack_size hint, which is safer than regex-guessing.
        const resolved = mapping.onec_guid
          ? await (async () => {
              const onec1cUnit = (await onecNomenclatureRepo.getByGuid(mapping.onec_guid!))?.unit ?? null;
              // Prefer the pack_size Claude extracted from the scan name
              // ("*48", "1/12", etc.) — it's ground-truth from the invoice,
              // far more reliable than the legacy regex fallback inside
              // resolveAndApplyPackTransform.
              const hintedPackSize = item.pack_size ?? mapping.pack_size;
              const hintedPackUnit = item.pack_size ? 'шт' : mapping.pack_unit;
              const r = resolveAndApplyPackTransform(
                sanity.item,
                item.name,
                hintedPackSize,
                hintedPackUnit,
                mapping.mapped_name,
                onec1cUnit,
              );
              await this.persistPackFallback(mapping.mapping_id, r);
              return r;
            })()
          : { item: sanity.item, packSize: null, packUnit: null, usedFallback: false };
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
        const canAutoSend = finalInv && finalInv.status === 'processed' && finalInv.duplicate_of == null;

        // Legacy webhook flag — оставляем для back-compat. ИЛИ с новым analyzer_config.
        const db = (await import('../database/db')).getDb();
        const whCfg = await db.prepare('SELECT auto_send_1c FROM webhook_config WHERE id = 1').get<{ auto_send_1c: number }>();
        const wantAuto1c = (whCfg?.auto_send_1c === 1) || cfg.auto_send_1c;

        if (canAutoSend && wantAuto1c) {
          await invoiceRepo.approveForOneC(targetInvoiceId);
          logger.info('Auto-approved for 1C', { id: targetInvoiceId });
        }

        // Auto-send Sber через loopback HTTP (переиспользует всю логику
        // /send-sber endpoint: check supplier verified, payer details,
        // create payment row, call Sber API). API key админа берётся из БД.
        if (canAutoSend && cfg.auto_send_sber) {
          await this.autoSendSber(targetInvoiceId);
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
