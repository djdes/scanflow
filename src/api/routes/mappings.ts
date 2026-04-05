import { Router, Request, Response } from 'express';
import { mappingRepo } from '../../database/repositories/mappingRepo';
import { NomenclatureMapper } from '../../mapping/nomenclatureMapper';

const router = Router();
let mapper: NomenclatureMapper;

export function setMapper(m: NomenclatureMapper): void {
  mapper = m;
}

// GET /api/mappings — list mappings.
// Query params:
//   supplier: filter by supplier name (via mapping_supplier_usage)
//   unmapped: "true" to only return mappings with no onec_guid
router.get('/', (req: Request, res: Response) => {
  const supplier = req.query.supplier as string | undefined;
  const unmapped = req.query.unmapped === 'true';
  const mappings = (supplier || unmapped)
    ? mappingRepo.getAllFiltered({ supplier, unmapped })
    : mappingRepo.getAll();
  res.json({ data: mappings, count: mappings.length });
});

// POST /api/mappings — create mapping
router.post('/', (req: Request, res: Response) => {
  const { scanned_name, mapped_name_1c, category, default_unit, approved, onec_guid } = req.body;

  if (!scanned_name || !mapped_name_1c) {
    res.status(400).json({ error: 'scanned_name and mapped_name_1c are required' });
    return;
  }

  const mapping = mappingRepo.upsert({
    scanned_name,
    mapped_name_1c,
    category,
    default_unit,
    approved: approved ?? false,
    onec_guid: onec_guid ?? null,
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
  mappingRepo.update(id, { scanned_name, mapped_name_1c, category, default_unit, approved, onec_guid });
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
