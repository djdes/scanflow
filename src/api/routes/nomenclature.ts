import { Router, Request, Response } from 'express';
import { onecNomenclatureRepo, OnecNomenclatureInput } from '../../database/repositories/onecNomenclatureRepo';
import { mappingRepo } from '../../database/repositories/mappingRepo';
import { logger } from '../../utils/logger';
import { NomenclatureMapper } from '../../mapping/nomenclatureMapper';

const router = Router();

// Optional mapper injection so we can invalidate the cache after sync
let mapper: NomenclatureMapper | null = null;
export function setMapper(m: NomenclatureMapper): void {
  mapper = m;
}

// POST /api/nomenclature/sync — bulk upsert from 1C
router.post('/sync', (req: Request, res: Response) => {
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
    const upserted = onecNomenclatureRepo.bulkUpsert(items);
    // Clean up mappings that point to deleted 1C items
    const orphaned = mappingRepo.removeOrphaned();
    if (orphaned > 0) {
      logger.info('Removed orphaned mappings after sync', { orphaned });
    }
    // CRITICAL: invalidate the Fuse index used by NomenclatureMapper so the
    // next map() call rebuilds from fresh onec_nomenclature rows.
    if (mapper) mapper.invalidateCache();
    logger.info('Nomenclature sync completed', { upserted });
    res.json({ data: { upserted, total: items.length, orphaned_removed: orphaned } });
  } catch (err) {
    logger.error('Nomenclature sync failed', { error: (err as Error).message });
    res.status(500).json({ error: 'Sync failed: ' + (err as Error).message });
  }
});

// DELETE /api/nomenclature — clear catalog before a full re-sync from 1C.
// Called by the BSL "Выгрузить номенклатуру" command to evict stale rows
// (e.g. finished products after switching to a purchase-documents-only query).
router.delete('/', (_req: Request, res: Response) => {
  try {
    const deleted = onecNomenclatureRepo.clearAll();
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
router.get('/', (req: Request, res: Response) => {
  const excludeFolders = req.query.exclude_folders === 'true';
  const search = req.query.search as string | undefined;
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
  const items = onecNomenclatureRepo.listItems({ excludeFolders, search, limit });
  const stats = onecNomenclatureRepo.stats();
  res.json({ data: items, count: items.length, last_synced_at: stats.last_synced_at });
});

// GET /api/nomenclature/stats
router.get('/stats', (_req: Request, res: Response) => {
  res.json({ data: onecNomenclatureRepo.stats() });
});


export default router;
