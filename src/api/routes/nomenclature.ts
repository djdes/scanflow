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
  // Basic validation: each item needs guid + name
  for (const item of items) {
    if (!item.guid || !item.name) {
      res.status(400).json({ error: 'each item must have guid and name' });
      return;
    }
  }
  const upserted = onecNomenclatureRepo.bulkUpsert(items);
  // CRITICAL: invalidate the Fuse index used by NomenclatureMapper so the
  // next map() call rebuilds from fresh onec_nomenclature rows. Without this,
  // mapper.map() silently uses stale data until the server restarts.
  if (mapper) mapper.invalidateCache();
  logger.info('Nomenclature sync completed', { upserted });
  res.json({ data: { upserted, total: items.length } });
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

// GET /api/nomenclature/suppliers — aggregated list of suppliers across mappings
router.get('/suppliers', (_req: Request, res: Response) => {
  const suppliers = mappingRepo.getSupplierList();
  const unmapped = mappingRepo.getUnmappedCount();
  res.json({ data: { suppliers, unmapped_count: unmapped } });
});

export default router;
