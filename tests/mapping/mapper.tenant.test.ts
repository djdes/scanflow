import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { onecNomenclatureRepo } from '../../src/database/repositories/onecNomenclatureRepo';
import { NomenclatureMapper } from '../../src/mapping/nomenclatureMapper';

// Утечка, которую фильтрация в SQL НЕ ловит.
//
// Маппер строит индекс каталога (Fuse + токены + IDF) и держит его в памяти
// между запросами. Пока индекс был один на процесс, первый же запрос прогревал
// его каталогом одной компании, и дальше он отвечал всем остальным — сколько бы
// WHERE owner_user_id ни стояло в запросах.
//
// Порядок вызовов в тестах важен: компания А обращается ПЕРВОЙ, чтобы индекс
// успел прогреться. Без этого тест прошёл бы и на сломанном коде.
describe.runIf((process.env.DB_NAME || '').includes('test'))('маппер: кэш каталога не протекает между компаниями', () => {
  let companyA = 0;
  let companyB = 0;
  let mapper: NomenclatureMapper;

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
    mapper = new NomenclatureMapper();
  });
  afterAll(async () => { await closeTestDb(); });

  it('прогретый каталог компании А не отвечает на запросы компании Б', async () => {
    await onecNomenclatureRepo.bulkUpsert(
      [{ guid: 'g-a-1', name: 'Молоко Домик в деревне 3.2%', unit: 'шт' }],
      companyA,
    );

    // 1. Компания А — индекс строится и остаётся в памяти.
    const hitA = await mapper.map('Молоко Домик в деревне 3.2%', companyA);
    expect(hitA.onec_guid).toBe('g-a-1');

    // 2. Тот же запрос от компании Б: её каталог пуст, попадания быть не должно.
    const hitB = await mapper.map('Молоко Домик в деревне 3.2%', companyB);
    expect(hitB.onec_guid).toBeNull();
    expect(hitB.source).toBe('none');
  });

  it('подсказки не выдают позиции чужого каталога', async () => {
    await onecNomenclatureRepo.bulkUpsert(
      [{ guid: 'g-a-2', name: 'Сахар песок 1кг', unit: 'кг' }],
      companyA,
    );

    const suggestA = await mapper.getSuggestions('Сахар песок', companyA);
    expect(suggestA.length).toBeGreaterThan(0);

    const suggestB = await mapper.getSuggestions('Сахар песок', companyB);
    expect(suggestB).toHaveLength(0);
  });

  it('каждая компания видит свою позицию под одним и тем же GUID', async () => {
    const GUID = 'shared-guid';
    await onecNomenclatureRepo.bulkUpsert([{ guid: GUID, name: 'Творог зернёный' }], companyA);
    await onecNomenclatureRepo.bulkUpsert([{ guid: GUID, name: 'Кефир нежирный' }], companyB);

    const a = await mapper.map('Творог зернёный', companyA);
    const b = await mapper.map('Кефир нежирный', companyB);

    expect(a.mapped_name).toBe('Творог зернёный');
    expect(b.mapped_name).toBe('Кефир нежирный');
    // Перекрёстно попаданий быть не должно.
    expect((await mapper.map('Кефир нежирный', companyA)).onec_guid).toBeNull();
    expect((await mapper.map('Творог зернёный', companyB)).onec_guid).toBeNull();
  });

  it('сброс кэша одной компании не роняет индекс другой', async () => {
    await onecNomenclatureRepo.bulkUpsert([{ guid: 'g-a-3', name: 'Масло сливочное 82%' }], companyA);
    await onecNomenclatureRepo.bulkUpsert([{ guid: 'g-b-3', name: 'Сметана 20%' }], companyB);

    await mapper.map('Масло сливочное 82%', companyA);
    await mapper.map('Сметана 20%', companyB);

    mapper.invalidateCache(companyB);

    // Индекс А остался валидным, индекс Б перестроится с нуля — оба корректны.
    expect((await mapper.map('Масло сливочное 82%', companyA)).onec_guid).toBe('g-a-3');
    expect((await mapper.map('Сметана 20%', companyB)).onec_guid).toBe('g-b-3');
  });
});
