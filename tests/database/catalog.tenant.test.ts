import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { onecNomenclatureRepo } from '../../src/database/repositories/onecNomenclatureRepo';
import { mappingRepo } from '../../src/database/repositories/mappingRepo';

// Каталог 1С и выученные сопоставления пер-тенантные: у каждой компании своя
// база 1С. Общий каталог не только показывал бы чужую номенклатуру, но и портил
// сопоставление — позиции цеплялись бы к чужим GUID.
describe.runIf((process.env.DB_NAME || '').includes('test'))('каталог и сопоставления: изоляция между компаниями', () => {
  const GUID = 'e0e16413-7c3e-11f1-bc9e-00155d647d01';
  let companyA = 0;
  let companyB = 0;

  async function mkUser(username: string, role: string): Promise<number> {
    const res = await getDb()
      .prepare(
        `INSERT INTO users (username, password_hash, api_key, role, notify_events)
         VALUES (?, 'x', ?, ?, '[]')`
      )
      .run(username, `k-${username}`, role);
    return Number(res.lastInsertRowid);
  }

  beforeEach(async () => {
    await resetDb();
    companyA = await mkUser('company-a', 'admin');
    companyB = await mkUser('company-b', 'user');
  });
  afterAll(async () => { await closeTestDb(); });

  it('один и тот же GUID живёт у двух компаний с разными названиями', async () => {
    await onecNomenclatureRepo.bulkUpsert([{ guid: GUID, name: 'Молоко у А', unit: 'шт' }], companyA);
    await onecNomenclatureRepo.bulkUpsert([{ guid: GUID, name: 'Сахар у Б', unit: 'кг' }], companyB);

    expect((await onecNomenclatureRepo.getByGuid(GUID, companyA))?.name).toBe('Молоко у А');
    expect((await onecNomenclatureRepo.getByGuid(GUID, companyB))?.name).toBe('Сахар у Б');
  });

  it('компания Б не видит каталог компании А', async () => {
    await onecNomenclatureRepo.bulkUpsert([{ guid: GUID, name: 'Только у А' }], companyA);

    expect(await onecNomenclatureRepo.getByGuid(GUID, companyB)).toBeUndefined();
    expect(await onecNomenclatureRepo.listItems({ ownerUserId: companyB })).toHaveLength(0);
    expect((await onecNomenclatureRepo.stats(companyB)).total).toBe(0);
    expect((await onecNomenclatureRepo.stats(companyA)).total).toBe(1);
  });

  // Самое опасное место: replaceAll делает DELETE перед вставкой. Без фильтра по
  // владельцу выгрузка каталога одной компании стёрла бы каталоги всех остальных.
  it('replaceAll компании Б НЕ стирает каталог компании А', async () => {
    await onecNomenclatureRepo.bulkUpsert([
      { guid: GUID, name: 'Каталог А, позиция 1' },
      { guid: 'guid-a-2', name: 'Каталог А, позиция 2' },
    ], companyA);

    await onecNomenclatureRepo.replaceAll([{ guid: 'guid-b-1', name: 'Каталог Б' }], companyB);

    expect((await onecNomenclatureRepo.stats(companyA)).total).toBe(2);
    expect((await onecNomenclatureRepo.stats(companyB)).total).toBe(1);
  });

  it('clearAll компании Б не трогает каталог компании А', async () => {
    await onecNomenclatureRepo.bulkUpsert([{ guid: GUID, name: 'Только у А' }], companyA);
    await onecNomenclatureRepo.bulkUpsert([{ guid: 'guid-b', name: 'Только у Б' }], companyB);

    await onecNomenclatureRepo.clearAll(companyB);

    expect((await onecNomenclatureRepo.stats(companyA)).total).toBe(1);
    expect((await onecNomenclatureRepo.stats(companyB)).total).toBe(0);
  });

  it('один и тот же scanned_name сопоставлен по-разному у двух компаний', async () => {
    await mappingRepo.upsert({ scanned_name: 'молоко', mapped_name_1c: 'Молоко А', onec_guid: 'g-a' }, companyA);
    await mappingRepo.upsert({ scanned_name: 'молоко', mapped_name_1c: 'Молоко Б', onec_guid: 'g-b' }, companyB);

    expect((await mappingRepo.getByScannedName('молоко', companyA))?.mapped_name_1c).toBe('Молоко А');
    expect((await mappingRepo.getByScannedName('молоко', companyB))?.mapped_name_1c).toBe('Молоко Б');
    expect(await mappingRepo.getAll(companyA)).toHaveLength(1);
  });

  it('компания Б не видит и не может удалить сопоставление компании А', async () => {
    const m = await mappingRepo.upsert(
      { scanned_name: 'сахар', mapped_name_1c: 'Сахар А', onec_guid: 'g-a' },
      companyA,
    );

    expect(await mappingRepo.getById(m.id, companyB)).toBeUndefined();
    await mappingRepo.delete(m.id, companyB);
    expect(await mappingRepo.getById(m.id, companyA)).toBeDefined();
  });

  // removeOrphaned сверяет onec_guid с каталогом. По ЧУЖОМУ каталогу вычистились
  // бы все сопоставления подряд — там этих GUID просто нет.
  it('removeOrphaned компании Б не вычищает сопоставления компании А', async () => {
    await onecNomenclatureRepo.bulkUpsert([{ guid: 'g-a', name: 'Позиция А' }], companyA);
    await mappingRepo.upsert({ scanned_name: 'сахар', mapped_name_1c: 'Сахар А', onec_guid: 'g-a' }, companyA);

    const removed = await mappingRepo.removeOrphaned(companyB);

    expect(removed).toBe(0);
    expect(await mappingRepo.getAll(companyA)).toHaveLength(1);
  });
});
