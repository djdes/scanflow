import { Router, Request, Response } from 'express';
import { mappingRepo } from '../../database/repositories/mappingRepo';
import { NomenclatureMapper } from '../../mapping/nomenclatureMapper';

const router = Router();
let mapper: NomenclatureMapper;

export function setMapper(m: NomenclatureMapper): void {
  mapper = m;
}

// GET /api/mappings — grouped by 1C item
router.get('/', (_req: Request, res: Response) => {
  const grouped = mappingRepo.getAllGrouped();
  const unmapped = mappingRepo.getUnmapped();
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
router.post('/', (req: Request, res: Response) => {
  const { scanned_name, mapped_name_1c, category, default_unit, approved, onec_guid } = req.body;

  if (!scanned_name || !mapped_name_1c) {
    res.status(400).json({ error: 'scanned_name and mapped_name_1c are required' });
    return;
  }

  const pack = parsePackFields(req.body);
  const mapping = mappingRepo.upsert({
    scanned_name,
    mapped_name_1c,
    category,
    default_unit,
    approved: approved ?? false,
    onec_guid: onec_guid ?? null,
    ...pack,
  });

  if (mapper) mapper.invalidateCache();
  res.status(201).json({ data: mapping });
});

// PUT /api/mappings/:id — update mapping
router.put('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const existing = mappingRepo.getById(id);

  if (!existing) {
    res.status(404).json({ error: 'Mapping not found' });
    return;
  }

  const { scanned_name, mapped_name_1c, category, default_unit, approved, onec_guid } = req.body;
  const pack = parsePackFields(req.body);
  mappingRepo.update(id, { scanned_name, mapped_name_1c, category, default_unit, approved, onec_guid, ...pack });
  if (mapper) mapper.invalidateCache();

  const updated = mappingRepo.getById(id);
  res.json({ data: updated });
});

// DELETE /api/mappings/:id
router.delete('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const existing = mappingRepo.getById(id);

  if (!existing) {
    res.status(404).json({ error: 'Mapping not found' });
    return;
  }

  mappingRepo.delete(id);
  if (mapper) mapper.invalidateCache();
  res.json({ message: 'Deleted' });
});

// POST /api/mappings/import — bulk import
router.post('/import', (req: Request, res: Response) => {
  const { items } = req.body;

  if (!Array.isArray(items)) {
    res.status(400).json({ error: 'items array is required' });
    return;
  }

  const count = mappingRepo.importBulk(items);
  if (mapper) mapper.invalidateCache();
  res.json({ message: `Imported ${count} mappings`, count });
});

// GET /api/mappings/suggest?name=... — suggest mappings for a name
router.get('/suggest', (req: Request, res: Response) => {
  const name = req.query.name as string;
  if (!name) {
    res.status(400).json({ error: 'name query parameter is required' });
    return;
  }

  const suggestions = mapper ? mapper.getSuggestions(name) : [];
  res.json({ data: suggestions });
});

export default router;
