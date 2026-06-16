import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { onecNomenclatureRepo } from '../../src/database/repositories/onecNomenclatureRepo';
import { NomenclatureMapper } from '../../src/mapping/nomenclatureMapper';

// Controlled catalog so we can assert exact normalized-name matching precisely.
const CATALOG = [
  { guid: 'g-vino', name: 'Лист винограда (ведро)' }, // unique normalized "лист винограда"
  { guid: 'g-lavr', name: 'Лавровый лист' },
  { guid: 'g-luk', name: 'Лук зеленый' },
  { guid: 'g-chai1', name: 'Чай листовой зеленый' },  // token distractor
  // ambiguous pair — both normalize to "творог"
  { guid: 'g-tvorog1', name: 'Творог' },
  { guid: 'g-tvorog2', name: 'Творог' },
];

describe.runIf((process.env.DB_NAME || '').includes('test'))('NomenclatureMapper exact normalized-name match', () => {
  let mapper: NomenclatureMapper;
  beforeAll(async () => {
    await resetDb();
    await onecNomenclatureRepo.bulkUpsert(CATALOG.map(c => ({
      guid: c.guid, code: null, name: c.name, full_name: null,
      unit: null, parent_guid: null, is_folder: false, is_weighted: false,
    })));
    mapper = new NomenclatureMapper();
    mapper.invalidateCache();
  });
  afterAll(async () => { await closeTestDb(); });

  it('maps a scan whose normalized name equals a catalog name — incl. "(ведро)" stripping', async () => {
    const r = await mapper.map('Лист винограда (ведро)');
    expect(r.source).toBe('onec_exact');
    expect(r.onec_guid).toBe('g-vino');
    expect(r.confidence).toBe(1);
  });

  it('matches across noise the normalizer removes (measures/case)', async () => {
    const r = await mapper.map('Лавровый Лист 50г');
    expect(r.onec_guid).toBe('g-lavr');
    expect(r.confidence).toBe(1);
  });

  it('skips exact when the normalized name is ambiguous (two catalog rows collide)', async () => {
    // Two catalog rows both named "Творог" collide on the normalized form → no
    // deterministic exact pick. Must NOT return source 'onec_exact' with an
    // arbitrary guid; falls through to scored stages instead.
    const r = await mapper.map('Творог');
    expect(r.source).not.toBe('onec_exact');
  });
});
