import express from 'express';
import request from 'supertest';
import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { userRepo } from '../../src/database/repositories/userRepo';
import { onecNomenclatureRepo } from '../../src/database/repositories/onecNomenclatureRepo';
import { mappingRepo } from '../../src/database/repositories/mappingRepo';
import { supplierMappingRepo } from '../../src/database/repositories/supplierMappingRepo';
import { rejectionRepo } from '../../src/database/repositories/rejectionRepo';
import { itemNameKey } from '../../src/mapping/nameKey';
import { NomenclatureMapper } from '../../src/mapping/nomenclatureMapper';
import router, { setMapper } from '../../src/api/routes/nomenclature';

const scanned = 'Майонез Махеевъ Провансаль 50,5% 9,4кг Ведро';
const moscow = 'Майонез Московский Провансаль Классический 67% 10л/9,6кг';
const app = express(); app.use(express.json());
app.use((req, _res, next) => { req.user = { id: Number(req.headers['x-owner'] || 1), username: 'fixture', role: 'user' }; next(); });
app.use('/api/nomenclature', router);
app.use((error: Error, _req: unknown, res: express.Response, _next: unknown) => res.status(500).json({ error: error.message }));

describe.runIf((process.env.DB_NAME || '').includes('test'))('confirmed catalog aliases', () => {
  let mapper: NomenclatureMapper;
  beforeEach(async () => {
    await resetDb();
    await userRepo.create({ username: 'aliases-1', password_hash: 'x', api_key: 'aliases-1' });
    await userRepo.create({ username: 'aliases-2', password_hash: 'x', api_key: 'aliases-2' });
    await onecNomenclatureRepo.bulkUpsert([
      { guid: 'mayo-hot', name: 'Майонез недорогой 67% (гор цех. основной)', unit: 'кг' },
      { guid: 'mayo-cold', name: 'Майонез МЖК (хол.цех)', unit: 'кг' },
    ], 1);
    await onecNomenclatureRepo.bulkUpsert([{ guid: 'mayo-hot', name: 'Чужой товар' }, { guid: 'foreign', name: 'Чужая позиция' }], 2);
    mapper = new NomenclatureMapper(); setMapper(mapper);
  });
  afterAll(closeTestDb);

  it('confirms both distinct mayonnaise names and exposes them in the owner catalog', async () => {
    const invalidate = vi.spyOn(mapper, 'invalidateCache');
    for (const [guid, name] of [['mayo-hot', scanned], ['mayo-cold', moscow]]) {
      const response = await request(app).post(`/api/nomenclature/${guid}/aliases`).send({ aliases: [name], mapped_name_1c: 'Client cannot rename the catalog item' });
      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].confirmed_at).toBeTruthy();
    }
    expect(invalidate).toHaveBeenCalledWith(1);
    const catalog = await request(app).get('/api/nomenclature?exclude_folders=true');
    expect(catalog.body.data.find((row: any) => row.guid === 'mayo-hot').aliases).toEqual([scanned]);
    expect(catalog.body.data.find((row: any) => row.guid === 'mayo-cold').aliases).toEqual([moscow]);
    expect((await mappingRepo.getConfirmed(scanned, 1))?.mapped_name_1c).toBe('Майонез недорогой 67% (гор цех. основной)');
    expect(await mappingRepo.getConfirmed('Майонез другой марки 55%', 1)).toBeUndefined();
  });

  it('honours an explicit 50.5% -> 67% alias over an AI suggestion without a configured usage source', async () => {
    await request(app).post('/api/nomenclature/mayo-hot/aliases').send({ aliases: [scanned] });
    const ordinary = { original_name: scanned, mapped_name: 'Майонез МЖК (хол.цех)', onec_guid: 'mayo-cold', confidence: 1,
      source: 'learned' as const, mapping_id: null, pack_size: 10, pack_unit: 'кг' };
    const selected = await mapper.refineWithUsage(scanned, ordinary, 1);
    expect(selected).toMatchObject({ onec_guid: 'mayo-hot', confidence: 1, confirmed_by_user: true, pack_size: null, pack_unit: null });
    expect(selected.mapping_reason).toContain('подтверждённому человеком');
    expect((await mapper.map(scanned, 1)).onec_guid).toBe('mayo-hot');
    expect((await mapper.getCandidates(scanned, 1))[0]).toMatchObject({ guid: 'mayo-hot', confidence: 1, conflict: null });
    expect((await mapper.getSuggestions(scanned, 1))[0]).toMatchObject({ guid: 'mayo-hot', confidence: 1 });
    await mappingRepo.upsertLearned({ scanned_name: scanned, mapped_name_1c: 'wrong', onec_guid: 'mayo-cold', source: 'llm' }, 1);
    expect((await mappingRepo.getConfirmed(scanned, 1))?.onec_guid).toBe('mayo-hot');
  });

  it('does not expose or change another company aliases, even for the same GUID', async () => {
    await request(app).post('/api/nomenclature/mayo-hot/aliases').set('X-Owner', '2').send({ aliases: ['Чужой синоним'] });
    expect((await request(app).get('/api/nomenclature/mayo-hot/aliases')).body.data).toEqual([]);
    expect((await request(app).get('/api/nomenclature?exclude_folders=true')).body.data.every((row: any) => !row.aliases.includes('Чужой синоним'))).toBe(true);
    expect((await request(app).post('/api/nomenclature/foreign/aliases').send({ aliases: ['Не наш товар'] })).status).toBe(404);
    const id = (await mappingRepo.listAliases(2, 'mayo-hot'))[0].id;
    expect((await request(app).delete(`/api/nomenclature/mayo-hot/aliases/${id}`)).status).toBe(404);
    expect(await mappingRepo.listAliases(2, 'mayo-hot')).toHaveLength(1);
  });

  it('does not replace a conflicting confirmed rule or partially save a batch', async () => {
    await mappingRepo.confirm(scanned, 'mayo-cold', 'Майонез МЖК (хол.цех)', 1, 1);
    const response = await request(app).post('/api/nomenclature/mayo-hot/aliases').send({ aliases: ['Новый синоним', scanned] });
    expect(response.status).toBe(409);
    expect(await mappingRepo.getByScannedName('Новый синоним', 1)).toBeUndefined();
    expect((await mappingRepo.getConfirmed(scanned, 1))?.onec_guid).toBe('mayo-cold');
  });

  it('replaces an unconfirmed guess, clears its old pack and explicit rejection, and deduplicates repeats', async () => {
    await mappingRepo.create({ scanned_name: scanned, onec_guid: 'mayo-cold', mapped_name_1c: 'wrong', pack_size: 50, pack_unit: 'кг' }, 1);
    await rejectionRepo.add(1, itemNameKey(scanned), 'mayo-hot', scanned, 1);
    for (let i = 0; i < 2; i++) expect((await request(app).post('/api/nomenclature/mayo-hot/aliases').send({ aliases: [scanned, scanned] })).status).toBe(200);
    expect(await mappingRepo.listAliases(1, 'mayo-hot')).toHaveLength(1);
    expect(await mappingRepo.getConfirmed(scanned, 1)).toMatchObject({ pack_size: null, pack_unit: null, onec_guid: 'mayo-hot' });
    expect((await rejectionRepo.guidsFor(1, itemNameKey(scanned))).has('mayo-hot')).toBe(false);
  });

  it('forgets the alias and its exact supplier rule without deleting another alias', async () => {
    await request(app).post('/api/nomenclature/mayo-hot/aliases').send({ aliases: [scanned, 'Другой синоним'] });
    await supplierMappingRepo.upsert({ supplierKey: 'inn:123', scannedName: scanned, mappedName: 'Майонез', onecGuid: 'mayo-hot' }, 1);
    const alias = (await mappingRepo.listAliases(1, 'mayo-hot')).find(row => row.scanned_name === scanned)!;
    expect((await request(app).delete(`/api/nomenclature/mayo-hot/aliases/${alias.id}`)).status).toBe(200);
    expect(await mappingRepo.getConfirmed(scanned, 1)).toBeUndefined();
    expect(await supplierMappingRepo.get('inn:123', scanned, 1)).toBeNull();
    expect(await mappingRepo.listAliases(1, 'mayo-hot')).toHaveLength(1);
  });

  it.each([{}, { aliases: [] }, { aliases: [7] }, { aliases: [' '] }, { aliases: ['a'.repeat(501)] }])('rejects an invalid alias payload %j', async body => {
    expect((await request(app).post('/api/nomenclature/mayo-hot/aliases').send(body)).status).toBe(400);
  });
});
