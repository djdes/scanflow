import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { NomenclatureMapper } from '../../src/mapping/nomenclatureMapper';

// Empty catalog + empty mappings → map() falls through to source 'none',
// where mapped_name must now be the cleaned name.
describe.runIf((process.env.DB_NAME || '').includes('test'))('NomenclatureMapper.map none-branch cleaning', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  it('returns a cleaned mapped_name for unmatched items', async () => {
    const mapper = new NomenclatureMapper();
    const r = await mapper.map('Ветчина с бедром индейки вареная 3-4кг d120');
    expect(r.source).toBe('none');
    expect(r.onec_guid).toBeNull();
    expect(r.mapped_name).toBe('Ветчина с бедром индейки вареная');
    expect(r.original_name).toBe('Ветчина с бедром индейки вареная 3-4кг d120');
  });
});
