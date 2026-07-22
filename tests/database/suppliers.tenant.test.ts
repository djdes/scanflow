import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { supplierRepo } from '../../src/database/repositories/supplierRepo';

// Справочник поставщиков пер-тенантный: в нём лежат расчётные счета, поэтому
// одна компания не должна ни видеть, ни менять карточки другой. Уникальность
// стоит на (owner_user_id, inn), поэтому один и тот же ИНН сосуществует у
// нескольких компаний со своими реквизитами.
describe.runIf((process.env.DB_NAME || '').includes('test'))('suppliers: изоляция между компаниями', () => {
  const INN = '7707083893';
  let companyA = 0;
  let companyB = 0;

  async function makeUser(username: string, role: string): Promise<number> {
    const res = await getDb()
      .prepare(
        `INSERT INTO users (username, password_hash, api_key, role, notify_events)
         VALUES (?, 'x', ?, ?, '[]')`
      )
      .run(username, `key-${username}`, role);
    return Number(res.lastInsertRowid);
  }

  beforeEach(async () => {
    await resetDb();
    companyA = await makeUser('company-a', 'admin');
    companyB = await makeUser('company-b', 'user');
  });

  afterAll(async () => { await closeTestDb(); });

  it('две компании держат свои карточки одного и того же ИНН независимо', async () => {
    await supplierRepo.create(
      { inn: INN, name: 'Поставщик глазами А', bank_bic: '044525225', account: '40702810000000000001' },
      companyA,
    );
    await supplierRepo.create(
      { inn: INN, name: 'Поставщик глазами Б', bank_bic: '044525225', account: '40702810000000000002' },
      companyB,
    );

    const a = await supplierRepo.findByInn(INN, companyA);
    const b = await supplierRepo.findByInn(INN, companyB);
    expect(a?.name).toBe('Поставщик глазами А');
    expect(b?.name).toBe('Поставщик глазами Б');
    expect(a?.account).not.toBe(b?.account);
  });

  it('компания Б не видит поставщика компании А', async () => {
    await supplierRepo.create({ inn: INN, name: 'Только у А', bank_bic: '044525225' }, companyA);

    expect(await supplierRepo.findByInn(INN, companyB)).toBeNull();
    const listB = await supplierRepo.list({ ownerUserId: companyB, limit: 100, offset: 0 });
    expect(listB).toHaveLength(0);
  });

  it('компания Б не может изменить или удалить поставщика компании А', async () => {
    await supplierRepo.create({ inn: INN, name: 'Только у А', bank_bic: '044525225' }, companyA);

    await supplierRepo.update(INN, companyB, { name: 'Взломано' });
    await supplierRepo.delete(INN, companyB);

    const stillThere = await supplierRepo.findByInn(INN, companyA);
    expect(stillThere?.name).toBe('Только у А');
  });

  it('роль admin не даёт доступа к справочнику другой компании', async () => {
    // companyA заведена с ролью admin — сквозного доступа всё равно быть не должно.
    await supplierRepo.create({ inn: INN, name: 'Только у Б', bank_bic: '044525225' }, companyB);
    expect(await supplierRepo.findByInn(INN, companyA)).toBeNull();
  });

  it('upsert не перетирает карточку другой компании', async () => {
    await supplierRepo.create(
      { inn: INN, name: 'Карточка А', bank_bic: '044525225', account: '40702810000000000001' },
      companyA,
    );

    await supplierRepo.upsert(
      { inn: INN, name: 'Карточка Б', bank_bic: '044525225', account: '40702810000000000002' },
      companyB,
    );

    const a = await supplierRepo.findByInn(INN, companyA);
    expect(a?.name).toBe('Карточка А');
    expect(a?.account).toBe('40702810000000000001');
  });
});
