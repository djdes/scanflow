import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getDb } from '../../src/database/db';
import { resetDb, closeTestDb } from '../helpers/db';
import { NomenclatureMapper } from '../../src/mapping/nomenclatureMapper';

// Каталог и сопоставления пер-тенантные. В тестах заводим одну компанию-владельца
// и работаем в её области — так же, как это делает боевой код.
const OWNER = 1;


// Empty catalog + empty mappings → map() falls through to source 'none',
// where mapped_name must now be the cleaned name.
describe.runIf((process.env.DB_NAME || '').includes('test'))('NomenclatureMapper.map none-branch cleaning', () => {
  beforeEach(async () => { await resetDb();
    await getDb().prepare(
      `INSERT INTO users (id, username, password_hash, api_key, role, notify_events)
       VALUES (1, 'owner', 'x', 'k-owner', 'admin', '[]')`
    ).run();
 });
  afterAll(async () => { await closeTestDb(); });

  it('returns a cleaned mapped_name for unmatched items', async () => {
    const mapper = new NomenclatureMapper();
    const r = await mapper.map('Ветчина с бедром индейки вареная 3-4кг d120', OWNER);
    expect(r.source).toBe('none');
    expect(r.onec_guid).toBeNull();
    expect(r.mapped_name).toBe('Ветчина с бедром индейки вареная');
    expect(r.original_name).toBe('Ветчина с бедром индейки вареная 3-4кг d120');
  });
});
