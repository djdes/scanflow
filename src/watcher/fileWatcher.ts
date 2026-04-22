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
import { sendErrorEmail } from '../utils/mailer';
import { canonicalizeSupplierName } from '../utils/invoiceNumber';
import { sha256File } from '../utils/fileHash';
import { resolveAndApplyPackTransform } from '../mapping/packTransform';
import { sanitizeItemArithmetic, sanitizeInvoiceVat, sanitizeItemVatPerItem } from '../parser/itemSanitizer';

const SUPPORTED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.webp'];

/**
 * Extract the row_no of the FIRST item from a persisted invoice's raw_text.
 *
 * We never migrated row_no into the invoice_items table (it's only useful at
 * merge-time), so we re-parse it from the JSON Claude returned and that we
 * stored verbatim in invoices.raw_text. Tolerant to jsonrepair cases where
 * the text contains fenced markdown — we scan for the first /"row_no":\s*(\d+)/.
 */
function getFirstRowNo(invoiceId: number): number | null {
  const row = invoiceRepo.getById(invoiceId);
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
      .on('add', (filePath: string) => this.onFileAdded(filePath))
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
    const recentDuplicate = invoiceRepo.findRecentByFileName(fileName, 5);
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
   * When a pack transform was resolved via name-based fallback (i.e. the
   * learned mapping didn't carry pack_size / pack_unit), persist the detected
   * values back onto the mapping row so the next run skips the regex pass.
   */
  private persistPackFallback(
    mappingId: number | null,
    resolved: { usedFallback: boolean; packSize: number | null; packUnit: string | null },
  ): void {
    if (!mappingId || !resolved.usedFallback) return;
    if (!resolved.packSize || !resolved.packUnit) return;
    try {
      mappingRepo.update(mappingId, {
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
      const duplicate = invoiceRepo.findByFileHash(fileHash);
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
      invoice = invoiceRepo.create({
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

    try {
      // 2. OCR (hybrid mode: Google Vision + Claude analyzer if enabled)
      invoiceRepo.updateStatus(invoice.id, 'ocr_processing');
      let ocrResult;
      if (forceEngine) {
        ocrResult = await this.ocrManager.recognizeWithEngine(filePath, forceEngine);
      } else {
        // Check analyzer mode from DB config
        const analyzerConfig = invoiceRepo.getAnalyzerConfig();

        if (analyzerConfig.mode === 'claude_api') {
          // Claude API mode: send image directly to Anthropic API
          ocrResult = await this.ocrManager.recognizeWithClaudeApi(filePath);
        } else if (config.useClaudeAnalyzer) {
          // Hybrid mode: Google Vision OCR + Claude CLI text analysis
          ocrResult = await this.ocrManager.recognizeHybrid(filePath, true);
        } else {
          // Fallback: Google Vision only + regex parser
          ocrResult = await this.ocrManager.recognize(filePath);
        }
      }

      invoiceRepo.updateInvoiceData(invoice.id, {
        raw_text: ocrResult.text,
        ocr_engine: ocrResult.engine,
      });

      // 3. Parse: use Claude's structured data if available, else regex parser
      invoiceRepo.updateStatus(invoice.id, 'parsing');
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
      let existingInvoice: ReturnType<typeof invoiceRepo.findRecentByNumber> = undefined;
      if (parsed.invoice_number) {
        existingInvoice = invoiceRepo.findRecentByNumber(
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
          existingInvoice = invoiceRepo.findRecentByFileNamePattern(
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
        const candidate = invoiceRepo.findRecentBySupplier(
          parsed.supplier,
          invoice.id,
          5,
        );
        if (candidate) {
          const existingItems = invoiceRepo.getItems(candidate.id);

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
            const existingFirstRow = getFirstRowNo(candidate.id);
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
        existingInvoice = invoiceRepo.findRecentBySupplier(
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
        existingInvoice = invoiceRepo.findMostRecentProcessedForContinuation(invoice.id, 2);
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
          invoiceRepo.appendFileName(existingInvoice.id, fileName);
          invoiceRepo.appendRawText(existingInvoice.id, ocrResult.text);

          // CRITICAL: delete the temp invoice row NOW, before any failable
          // async work. Previously this delete happened at the end of the
          // merge path — if the process crashed / was restarted during the
          // multi-page re-analysis (a 10–60s Claude API call), or if any
          // intermediate step threw, the temp row stayed behind as an orphan
          // stuck in status 'parsing'. Early delete makes the merge atomic
          // from the moment append succeeds: either the page is folded into
          // the parent, or nothing happens (the parent is unchanged).
          invoiceRepo.delete(invoice.id);

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
              invoiceRepo.deleteItems(targetInvoiceId);

              // Update invoice metadata from unified result
              invoiceRepo.updateInvoiceData(targetInvoiceId, {
                invoice_number: unifiedParsed.invoice_number,
                invoice_date: unifiedParsed.invoice_date,
                supplier: unifiedParsed.supplier ? canonicalizeSupplierName(unifiedParsed.supplier) : undefined,
                total_sum: unifiedParsed.total_sum,
                vat_sum: unifiedParsed.vat_sum,
                invoice_type: unifiedParsed.invoice_type,
                supplier_inn: unifiedParsed.supplier_inn,
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
              for (const item of mergedItems) {
                if (!item.name) continue;
                const sanity = sanitizeItemArithmetic({
                  quantity: item.quantity, unit: item.unit, price: item.price, total: item.total,
                });
                if (sanity.corrected) {
                  logger.info('Merged-item arithmetic sanitized', { name: item.name, reason: sanity.reason });
                }
                const mapping = this.mapper.map(item.name);
                const resolved = resolveAndApplyPackTransform(
                  sanity.item,
                  item.name,
                  mapping.pack_size,
                  mapping.pack_unit,
                  mapping.mapped_name,
                );
                this.persistPackFallback(mapping.mapping_id, resolved);
                invoiceRepo.addItem({
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

              invoiceRepo.recalculateTotal(targetInvoiceId);
              invoiceRepo.updateStatus(targetInvoiceId, 'processed');

              const totalItems = invoiceRepo.getItems(targetInvoiceId);
              logger.info('Multi-page invoice merged via combined OCR text', {
                id: targetInvoiceId,
                totalItemsCount: totalItems.length,
                totalSum: unifiedParsed.total_sum,
              });

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
        invoiceRepo.updateInvoiceData(invoice.id, {
          invoice_number: parsed.invoice_number,
          invoice_date: parsed.invoice_date,
          supplier: parsed.supplier ? canonicalizeSupplierName(parsed.supplier) : undefined,
          total_sum: parsed.total_sum,
          vat_sum: parsed.vat_sum,
          invoice_type: parsed.invoice_type,
          supplier_inn: parsed.supplier_inn,
          supplier_bik: parsed.supplier_bik,
          supplier_account: parsed.supplier_account,
          supplier_corr_account: parsed.supplier_corr_account,
          supplier_address: parsed.supplier_address,
        });
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
      for (const item of parsedItems) {
        if (!item.name) continue; // skip items without a name
        // Per-row sanity: if qty × price still doesn't match total, trust
        // total+price and rewrite qty. Catches cases like "7000 шт × 959.09
        // = 7385" where Claude read a thousand-separator as digits.
        const sanity = sanitizeItemArithmetic({
          quantity: item.quantity, unit: item.unit, price: item.price, total: item.total,
        });
        if (sanity.corrected) {
          logger.info('Item arithmetic sanitized', { name: item.name, reason: sanity.reason });
        }
        const mapping = this.mapper.map(item.name);
        const resolved = resolveAndApplyPackTransform(
          sanity.item,
          item.name,
          mapping.pack_size,
          mapping.pack_unit,
          mapping.mapped_name,
        );
        this.persistPackFallback(mapping.mapping_id, resolved);
        invoiceRepo.addItem({
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
        invoiceRepo.recalculateTotal(targetInvoiceId);

        const existingItems = invoiceRepo.getItems(targetInvoiceId);
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
        invoiceRepo.recalculateTotal(invoice.id);
        invoiceRepo.updateStatus(invoice.id, 'processed');
        logger.info('Invoice processed successfully', {
          id: invoice.id,
          fileName,
          itemsCount: parsed.items.length,
          engine: ocrResult.engine,
        });
      }

      // 8. Auto-send to 1C if enabled
      try {
        const db = (await import('../database/db')).getDb();
        const whConfig = db.prepare('SELECT auto_send_1c FROM webhook_config WHERE id = 1').get() as { auto_send_1c: number } | undefined;
        if (whConfig?.auto_send_1c) {
          const finalId = targetInvoiceId;
          invoiceRepo.approveForOneC(finalId);
          logger.info('Auto-approved for 1C', { id: finalId });
        }
      } catch (e) {
        logger.warn('Auto-send check failed', { error: (e as Error).message });
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
      invoiceRepo.updateStatus(invoice.id, 'error', errorMsg);
      logger.error('Invoice processing failed', { id: invoice.id, fileName, error: errorMsg });

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
