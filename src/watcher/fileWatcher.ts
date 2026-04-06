import { watch, type FSWatcher } from 'chokidar';
import path from 'path';
import fs from 'fs';
import { config } from '../config';
import { logger } from '../utils/logger';
import { OcrManager } from '../ocr/ocrManager';
import { parseInvoiceText } from '../parser/invoiceParser';
import { NomenclatureMapper } from '../mapping/nomenclatureMapper';
import { invoiceRepo } from '../database/repositories/invoiceRepo';
import { mappingRepo } from '../database/repositories/mappingRepo';
import { sendErrorEmail } from '../utils/mailer';
import { canonicalizeSupplierName } from '../utils/invoiceNumber';

const SUPPORTED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.webp'];

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

  async processFile(filePath: string, fileName: string, forceEngine?: string): Promise<number> {
    // 1. Create invoice record
    const invoice = invoiceRepo.create({
      file_name: fileName,
      file_path: filePath,
    });

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

      // Strategy C: match by supplier within 2 minutes (camera rapid capture)
      // If this page has no invoice_number but same supplier as a recent invoice — merge
      if (!existingInvoice && parsed.supplier) {
        existingInvoice = invoiceRepo.findRecentBySupplier(
          parsed.supplier,
          invoice.id,
          2  // within last 2 minutes
        );
        if (existingInvoice && existingInvoice.id !== invoice.id) {
          logger.info('Multi-page: matched by supplier within 2 min', {
            currentFile: fileName,
            existingFile: existingInvoice.file_name,
            supplier: parsed.supplier,
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

          // Append file name and raw text to existing invoice
          invoiceRepo.appendFileName(existingInvoice.id, fileName);
          invoiceRepo.appendRawText(existingInvoice.id, ocrResult.text);

          // Re-process ALL pages together: combine OCR texts and send to Claude
          try {
            // Get combined OCR text (existing pages + new page)
            const existingText = existingInvoice.raw_text || '';
            const separator = '\n\n--- СТРАНИЦА ---\n\n';
            const combinedText = existingText + separator + ocrResult.text;
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

              // Save unified items
              for (const item of unifiedParsed.items) {
                if (!item.name) continue;
                const mapping = this.mapper.map(item.name);
                invoiceRepo.addItem({
                  invoice_id: targetInvoiceId,
                  original_name: item.name,
                  mapped_name: mapping.mapped_name,
                  quantity: item.quantity,
                  unit: item.unit,
                  price: item.price,
                  total: item.total,
                  vat_rate: item.vat_rate,
                  mapping_confidence: mapping.confidence,
                  onec_guid: mapping.onec_guid,
                });
                if (mapping.mapping_id !== null) {
                  mappingRepo.recordUsage(mapping.mapping_id, unifiedParsed.supplier ?? null);
                }
              }

              invoiceRepo.recalculateTotal(targetInvoiceId);
              invoiceRepo.delete(invoice.id);
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

      // 5. Map nomenclature and save items (to target invoice)
      for (const item of parsed.items) {
        if (!item.name) continue; // skip items without a name
        const mapping = this.mapper.map(item.name);
        invoiceRepo.addItem({
          invoice_id: targetInvoiceId,
          original_name: item.name,
          mapped_name: mapping.mapped_name,
          quantity: item.quantity,
          unit: item.unit,
          price: item.price,
          total: item.total,
          vat_rate: item.vat_rate,
          mapping_confidence: mapping.confidence,
          onec_guid: mapping.onec_guid,
        });
        if (mapping.mapping_id !== null) {
          mappingRepo.recordUsage(mapping.mapping_id, parsed.supplier ?? null);
        }
      }

      // 6. If merged, recalculate total and delete the temporary invoice record
      if (isMergedPage) {
        invoiceRepo.recalculateTotal(targetInvoiceId);
        invoiceRepo.delete(invoice.id);

        const existingItems = invoiceRepo.getItems(targetInvoiceId);
        logger.info('Invoice pages merged successfully (append mode)', {
          id: targetInvoiceId,
          totalItemsCount: existingItems.length,
          addedItemsCount: parsed.items.length,
        });
      } else {
        // 7. Update status for new invoice
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
