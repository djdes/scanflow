import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { resetDb, closeTestDb } from '../helpers/db';
import { onecNomenclatureRepo } from '../../src/database/repositories/onecNomenclatureRepo';
import { NomenclatureMapper } from '../../src/mapping/nomenclatureMapper';

// Real 1C catalog snapshot (705 items) so IDF weighting is realistic.
const catalog: Array<{ guid: string; name: string; full_name: string | null; is_folder: number }> =
  JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/onec-catalog.json'), 'utf8'));

describe.runIf((process.env.DB_NAME || '').includes('test'))('catalog token matching (Russian word-order/morphology)', () => {
  let mapper: NomenclatureMapper;

  beforeAll(async () => {
    await resetDb();
    await onecNomenclatureRepo.bulkUpsert(
      catalog.filter(c => !c.is_folder).map(c => ({
        guid: c.guid, code: null, name: c.name, full_name: c.full_name,
        unit: null, parent_guid: null, is_folder: false, is_weighted: false,
      })),
    );
    mapper = new NomenclatureMapper();
    mapper.invalidateCache();
  });
  afterAll(async () => { await closeTestDb(); });

  // Items from invoice #94 that the old Fuse matcher missed but DO exist in the
  // catalog under a reordered / morphologically different name.
  const shouldMap: Array<[string, RegExp]> = [
    ['Анчоусы Пряного Посола в Масле 145г', /Анчоус/i],
    ['Камбала потрошеная без головы индивидуальная', /Камбала/i],
    ['Тушка курицы без кости с кожей шаурма зам', /Тушка кур/i],
    ['Филе куриного окорочка с кожей', /Окороч/i],
    ['Филе грудки куриной охлажденное 13кг', /Филе грудки/i],
    ['Яйцо куриное пищевое отборной категории 36', /Яйцо/i],
  ];

  it.each(shouldMap)('maps "%s" to a catalog item', async (scanned, expected) => {
    const r = await mapper.map(scanned);
    expect(r.onec_guid, `expected a catalog guid for "${scanned}", got mapped_name="${r.mapped_name}" source=${r.source}`).not.toBeNull();
    expect(r.mapped_name).toMatch(expected);
  });

  it('maps "Бедро куриное" to a chicken item, NOT to "Сердце Говяжье" (no false positive on "замороженное")', async () => {
    const r = await mapper.map('Бедро куриное замороженное 600г');
    expect(r.onec_guid).not.toBeNull();
    expect(r.mapped_name).toMatch(/бедр/i);
    expect(r.mapped_name).not.toMatch(/сердце/i);
  });

  it('leaves a genuinely-absent item unmapped (no "Лопатка говяжья" in catalog)', async () => {
    const r = await mapper.map('Лопатка говяжья без кости замороженная 15-');
    expect(r.onec_guid).toBeNull();
    expect(r.source).toBe('none');
  });

  // Regression: items the old matcher already got right must stay right.
  const keep: Array<[string, RegExp]> = [
    ['Печень говяжья зам 4-5кг', /Печень говяж/i],
    ['Навага без головы замороженная 17-23см', /Навага/i],
  ];
  it.each(keep)('still maps "%s" correctly', async (scanned, expected) => {
    const r = await mapper.map(scanned);
    expect(r.onec_guid).not.toBeNull();
    expect(r.mapped_name).toMatch(expected);
  });
});
