import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { onecNomenclatureRepo, OnecNomenclatureInput } from '../../database/repositories/onecNomenclatureRepo';
import { mappingRepo } from '../../database/repositories/mappingRepo';
import { logger } from '../../utils/logger';
import { NomenclatureMapper } from '../../mapping/nomenclatureMapper';
import { logIntegrationEvent } from '../../integration/integrationLog';
import { requireAdmin } from '../middleware/auth';
import { parseCatalogSpreadsheet } from '../../integration/catalogSpreadsheet';

const router = Router();
const catalogUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

function receiveCatalogFile(req: Request, res: Response, next: NextFunction): void {
  catalogUpload.single('file')(req, res, error => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'Файл больше 5 МБ. Оставьте только нужные колонки или разделите каталог.' });
      return;
    }
    if (error) {
      res.status(400).json({ error: 'Не удалось принять файл: ' + error.message });
      return;
    }
    next();
  });
}

// Optional mapper injection so we can invalidate the cache after sync
let mapper: NomenclatureMapper | null = null;
export function setMapper(m: NomenclatureMapper): void {
  mapper = m;
}

// POST /api/nomenclature/import — one-time XLSX/CSV/TSV import for a simple
// first start without installing the 1C external processing.
router.post('/import', requireAdmin, receiveCatalogFile, async (req: Request, res: Response) => {
  if (!req.file?.buffer?.length) return res.status(400).json({ error: 'Выберите XLSX, CSV или вставьте таблицу из буфера' });
  const mode = req.body?.mode === 'replace' ? 'replace' : 'merge';
  let parsed: Awaited<ReturnType<typeof parseCatalogSpreadsheet>>;
  try {
    // Parse and validate the complete workbook before touching the catalog.
    parsed = await parseCatalogSpreadsheet(req.file.buffer, req.file.originalname || 'catalog.csv');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось прочитать таблицу';
    logger.warn('Nomenclature spreadsheet import rejected', { error: message });
    return res.status(400).json({ error: message });
  }
  try {
    let deleted = 0;
    let upserted = 0;
    if (mode === 'replace') {
      ({ deleted, upserted } = await onecNomenclatureRepo.replaceAll(parsed.items));
    } else {
      upserted = await onecNomenclatureRepo.bulkUpsert(parsed.items);
    }
    const orphaned = await mappingRepo.removeOrphaned();
    mapper?.invalidateCache();
    logger.info('Nomenclature spreadsheet import completed', {
      mode, upserted, deleted, skipped: parsed.skippedRows, generatedIds: parsed.generatedIds,
    });
    void logIntegrationEvent({
      integration: 'nomenclature', event_type: 'catalog_imported',
      summary: `Каталог загружен из таблицы: ${upserted} позиций (${mode === 'replace' ? 'замена' : 'добавление'})`,
      detail: { source: 'spreadsheet', generated_ids: parsed.generatedIds, skipped: parsed.skippedRows },
    });
    res.json({
      data: {
        mode,
        upserted,
        deleted_before_import: deleted,
        orphaned_removed: orphaned,
        source_rows: parsed.sourceRows,
        skipped_rows: parsed.skippedRows,
        duplicate_rows: parsed.duplicateRows,
        generated_ids: parsed.generatedIds,
        sheet: parsed.sheet,
        header_row: parsed.headerRow,
        detected_columns: parsed.detectedColumns,
        warnings: parsed.warnings,
      },
    });
  } catch (error) {
    logger.error('Nomenclature spreadsheet import failed', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Не удалось сохранить каталог. Повторите загрузку позже.' });
  }
});

// POST /api/nomenclature/sync — bulk upsert from 1C
router.post('/sync', requireAdmin, async (req: Request, res: Response) => {
  const items = req.body?.items as OnecNomenclatureInput[] | undefined;
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'items must be a non-empty array' });
    return;
  }
  // Basic validation: each item needs a non-empty guid + name (reject whitespace-only too)
  for (const item of items) {
    if (!item.guid || !String(item.guid).trim() || !item.name || !String(item.name).trim()) {
      res.status(400).json({ error: 'each item must have a non-empty guid and name' });
      return;
    }
  }
  try {
    const upserted = await onecNomenclatureRepo.bulkUpsert(items);
    // Clean up mappings that point to deleted 1C items
    const orphaned = await mappingRepo.removeOrphaned();
    if (orphaned > 0) {
      logger.info('Removed orphaned mappings after sync', { orphaned });
    }
    // CRITICAL: invalidate the Fuse index used by NomenclatureMapper so the
    // next map() call rebuilds from fresh onec_nomenclature rows.
    if (mapper) mapper.invalidateCache();
    logger.info('Nomenclature sync completed', { upserted });
    void logIntegrationEvent({
      integration: 'nomenclature', event_type: 'catalog_synced',
      summary: `Справочник 1С синхронизирован: ${upserted} позиц. из ${items.length}`,
    });
    res.json({ data: { upserted, total: items.length, orphaned_removed: orphaned } });
  } catch (err) {
    logger.error('Nomenclature sync failed', { error: (err as Error).message });
    res.status(500).json({ error: 'Sync failed: ' + (err as Error).message });
  }
});

// DELETE /api/nomenclature — clear catalog before a full re-sync from 1C.
// Called by the BSL "Выгрузить номенклатуру" command to evict stale rows
// (e.g. finished products after switching to a purchase-documents-only query).
router.delete('/', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const deleted = await onecNomenclatureRepo.clearAll();
    // Don't removeOrphaned here — catalog is temporarily empty,
    // POST /sync will refill it and clean orphans after.
    if (mapper) mapper.invalidateCache();
    logger.info('Nomenclature catalog cleared', { deleted });
    res.json({ data: { deleted } });
  } catch (err) {
    logger.error('Nomenclature clear failed', { error: (err as Error).message });
    res.status(500).json({ error: 'Clear failed: ' + (err as Error).message });
  }
});

// GET /api/nomenclature — list catalog items
router.get('/', async (req: Request, res: Response) => {
  const excludeFolders = req.query.exclude_folders === 'true';
  const search = req.query.search as string | undefined;
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
  const items = await onecNomenclatureRepo.listItems({ excludeFolders, search, limit });
  const stats = await onecNomenclatureRepo.stats();
  res.json({ data: items, count: items.length, last_synced_at: stats.last_synced_at });
});

// GET /api/nomenclature/stats
router.get('/stats', async (_req: Request, res: Response) => {
  res.json({ data: await onecNomenclatureRepo.stats() });
});


export default router;
