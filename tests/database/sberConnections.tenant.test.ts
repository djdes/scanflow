import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { sberTokenRepo } from '../../src/database/repositories/sberTokenRepo';

// Подключение к Сберу пер-тенантное: в нём лежат токены доступа к банку и
// реквизиты плательщика, то есть счёт списания. Общая строка означала бы, что
// платёж одной компании уходит со счёта другой.
describe.runIf((process.env.DB_NAME || '').includes('test'))('sber: изоляция подключений', () => {
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

  const conn = (n: string) => ({
    access_token: `at-${n}`,
    refresh_token: `rt-${n}`,
    expires_at: '2030-01-01 00:00:00',
    account_number: n === 'A' ? '40702810000000000001' : '40702810000000000002',
    org_name: `Компания ${n}`,
    payer_inn: '7707083893',
    payer_kpp: null,
    payer_bank_bic: '044525225',
    payer_bank_corr_account: '30101810400000000225',
  });

  beforeEach(async () => {
    await resetDb();
    companyA = await mkUser('company-a', 'admin');
    companyB = await mkUser('company-b', 'user');
  });
  afterAll(async () => { await closeTestDb(); });

  it('две компании держат независимые подключения', async () => {
    await sberTokenRepo.upsert(conn('A'), companyA);
    await sberTokenRepo.upsert(conn('B'), companyB);

    const a = await sberTokenRepo.get(companyA);
    const b = await sberTokenRepo.get(companyB);
    expect(a?.access_token).toBe('at-A');
    expect(b?.access_token).toBe('at-B');
    expect(a?.account_number).not.toBe(b?.account_number);
  });

  it('компания без подключения не видит чужое', async () => {
    await sberTokenRepo.upsert(conn('A'), companyA);
    expect(await sberTokenRepo.get(companyB)).toBeNull();
  });

  it('роль admin не даёт доступа к чужому подключению', async () => {
    // companyA заведена с ролью admin — сквозного доступа всё равно быть не должно.
    await sberTokenRepo.upsert(conn('B'), companyB);
    expect(await sberTokenRepo.get(companyA)).toBeNull();
  });

  it('отключение у одной компании не трогает другую', async () => {
    await sberTokenRepo.upsert(conn('A'), companyA);
    await sberTokenRepo.upsert(conn('B'), companyB);

    await sberTokenRepo.clear(companyB);

    expect(await sberTokenRepo.get(companyB)).toBeNull();
    expect((await sberTokenRepo.get(companyA))?.access_token).toBe('at-A');
  });

  it('обновление токенов не затрагивает чужое подключение', async () => {
    await sberTokenRepo.upsert(conn('A'), companyA);
    await sberTokenRepo.upsert(conn('B'), companyB);

    await sberTokenRepo.updateTokens(
      { access_token: 'at-A-new', refresh_token: 'rt-A-new', expires_at: '2031-01-01 00:00:00' },
      companyA,
    );

    expect((await sberTokenRepo.get(companyA))?.access_token).toBe('at-A-new');
    expect((await sberTokenRepo.get(companyB))?.access_token).toBe('at-B');
  });

  it('правка реквизитов плательщика не затрагивает чужое подключение', async () => {
    await sberTokenRepo.upsert(conn('A'), companyA);
    await sberTokenRepo.upsert(conn('B'), companyB);

    await sberTokenRepo.updatePayerDetails({ org_name: 'Переименованная А' }, companyA);

    expect((await sberTokenRepo.get(companyA))?.org_name).toBe('Переименованная А');
    expect((await sberTokenRepo.get(companyB))?.org_name).toBe('Компания B');
  });
});
