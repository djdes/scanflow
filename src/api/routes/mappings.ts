import { Router, Request, Response } from 'express';
import { mappingRepo } from '../../database/repositories/mappingRepo';
import { NomenclatureMapper } from '../../mapping/nomenclatureMapper';
import { requireAdmin } from '../middleware/auth';
import { rejectionRepo } from '../../database/repositories/rejectionRepo';
import { restoreMappings, type RestoreRow } from '../../services/mappingRestore';

const router = Router();
let mapper: NomenclatureMapper;

// Владелец сопоставлений — всегда текущий пользователь. Значения по умолчанию
// нет: роут под apiKeyAuth, запрос без пользователя сюда не доходит.
function ownerOf(req: Request): number {
  const id = req.user?.id;
  if (id == null) throw new Error('mappings route reached without an authenticated user');
  return id;
}

export function setMapper(m: NomenclatureMapper): void {
  mapper = m;
}

// GET /api/mappings — grouped by 1C item
router.get('/', async (req: Request, res: Response) => {
  const grouped = await mappingRepo.getAllGrouped(ownerOf(req));
  const unmapped = await mappingRepo.getUnmapped(ownerOf(req));
  res.json({ data: { grouped, unmapped } });
});

// Normalize pack_size / pack_unit from a request body. Accepts the fields
// in either form (number or numeric string), coerces to valid pack_size > 0,
// non-empty trimmed pack_unit, else null. Returns an object suitable for
// merging into CreateMappingData — only includes the keys the caller passed
// explicitly so partial updates don't clobber existing values.
function parsePackFields(body: unknown): { pack_size?: number | null; pack_unit?: string | null } {
  const out: { pack_size?: number | null; pack_unit?: string | null } = {};
  if (!body || typeof body !== 'object') return out;
  const b = body as { pack_size?: unknown; pack_unit?: unknown };
  if ('pack_size' in b) {
    const raw = b.pack_size;
    if (raw == null || raw === '') {
      out.pack_size = null;
    } else {
      const n = Number(raw);
      out.pack_size = isFinite(n) && n > 0 ? n : null;
    }
  }
  if ('pack_unit' in b) {
    const raw = b.pack_unit;
    out.pack_unit = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
  }
  return out;
}

// POST /api/mappings — create mapping
router.post('/', async (req: Request, res: Response) => {
  const { scanned_name, mapped_name_1c, category, default_unit, approved, onec_guid } = req.body;

  if (!scanned_name || !mapped_name_1c) {
    res.status(400).json({ error: 'scanned_name and mapped_name_1c are required' });
    return;
  }

  const pack = parsePackFields(req.body);
  const mapping = await mappingRepo.upsert({
    scanned_name,
    mapped_name_1c,
    category,
    default_unit,
    approved: approved ?? false,
    onec_guid: onec_guid ?? null,
    ...pack,
  }, ownerOf(req));

  if (mapper) mapper.invalidateCache(ownerOf(req));
  res.status(201).json({ data: mapping });
});

// PUT /api/mappings/:id — update mapping
router.put('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const existing = await mappingRepo.getById(id, ownerOf(req));

  if (!existing) {
    res.status(404).json({ error: 'Mapping not found' });
    return;
  }

  const { scanned_name, mapped_name_1c, category, default_unit, approved, onec_guid } = req.body;
  const pack = parsePackFields(req.body);
  await mappingRepo.update(id, ownerOf(req), { scanned_name, mapped_name_1c, category, default_unit, approved, onec_guid, ...pack });
  if (mapper) mapper.invalidateCache(ownerOf(req));

  const updated = await mappingRepo.getById(id, ownerOf(req));
  res.json({ data: updated });
});

// DELETE /api/mappings/:id
router.delete('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const existing = await mappingRepo.getById(id, ownerOf(req));

  if (!existing) {
    res.status(404).json({ error: 'Mapping not found' });
    return;
  }

  await mappingRepo.delete(id, ownerOf(req));
  if (mapper) mapper.invalidateCache(ownerOf(req));
  res.json({ message: 'Deleted' });
});

// POST /api/mappings/:id/confirm — подтвердить правило (важнее выбора ИИ, пакет v2).
router.post('/:id/confirm', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  const existing = await mappingRepo.getById(id, ownerOf(req));
  if (!existing || !existing.onec_guid) return res.status(404).json({ error: 'Mapping not found' });
  await mappingRepo.confirm(existing.scanned_name, existing.onec_guid, existing.mapped_name_1c, ownerOf(req), req.user?.id ?? null);
  if (mapper) mapper.invalidateCache(ownerOf(req));
  return res.json({ data: await mappingRepo.getById(id, ownerOf(req)) });
});

// GET /api/mappings/rejections/list — «не это»: отклонённые позиции для товаров.
router.get('/rejections/list', async (req: Request, res: Response) => {
  res.json({ data: await rejectionRepo.list(ownerOf(req)) });
});

// DELETE /api/mappings/rejections/:id — снять отклонение.
router.delete('/rejections/:id', async (req: Request, res: Response) => {
  await rejectionRepo.remove(ownerOf(req), parseInt(req.params.id as string, 10));
  if (mapper) mapper.invalidateCache(ownerOf(req));
  res.json({ success: true });
});

// POST /api/mappings/import — bulk import
router.post('/import', requireAdmin, async (req: Request, res: Response) => {
  const { items } = req.body;

  if (!Array.isArray(items)) {
    res.status(400).json({ error: 'items array is required' });
    return;
  }

  const count = await mappingRepo.importBulk(items, ownerOf(req));
  if (mapper) mapper.invalidateCache(ownerOf(req));
  res.json({ message: `Imported ${count} mappings`, count });
});

// POST /api/mappings/restore — admin: вернуть сопоставления из резервной копии
// (п.7 пакета v2: правила, стёртые выгрузкой каталога до v2, и откат).
// body { rows: [{scanned_name, onec_guid, pack_size?, pack_unit?, ...}],
//        dry_run (по умолчанию true!), label? }. Только в область вызывающего.
// Что именно вернётся и почему остальное — нет, см. src/services/mappingRestore.ts.
router.post('/restore', requireAdmin, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { rows?: unknown; dry_run?: unknown; label?: unknown };
  if (!Array.isArray(body.rows)) return res.status(400).json({ error: 'rows array is required' });
  const owner = ownerOf(req);
  const result = await restoreMappings(owner, body.rows as RestoreRow[], {
    dryRun: body.dry_run !== false,
    actorUserId: req.user?.id ?? null,
    label: typeof body.label === 'string' ? body.label.slice(0, 120) : undefined,
  });
  if (!result.dry_run && result.counts.restore > 0 && mapper) mapper.invalidateCache(owner);
  return res.json({ data: result });
});

// GET /api/mappings/suggest?name=... — suggest mappings for a name
router.get('/suggest', async (req: Request, res: Response) => {
  const name = req.query.name as string;
  if (!name) {
    res.status(400).json({ error: 'name query parameter is required' });
    return;
  }

  const suggestions = mapper ? await mapper.getSuggestions(name, ownerOf(req)) : [];
  res.json({ data: suggestions });
});

export default router;
