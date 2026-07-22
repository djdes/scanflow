import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { supplierRepo } from '../../src/database/repositories/supplierRepo';
import { resolveSupplierName } from '../../src/services/resolveSupplierName';

// ИНН is a far more reliable key than the OCR'd name: when a verified supplier
// card exists for the recognized ИНН, its canonical name must win at recognition
// time. Unverified (photo-extract) cards are NOT trusted — their names may
// themselves be OCR-garbled. Without a card we fall back to prior-invoice
// canonical spelling, then the raw name.
//
// The directory is per-tenant, so every lookup carries the owning company.
describe.runIf((process.env.DB_NAME || '').includes('test'))('resolveSupplierName — directory by ИНН', () => {
  let owner = 0;

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
    owner = await mkUser('owner', 'admin');
  });
  afterAll(async () => { await closeTestDb(); });

  async function mkInvoice(supplier: string, inn: string | null, n = 1): Promise<void> {
    for (let i = 0; i < n; i++) {
      await getDb().prepare(
        `INSERT INTO invoices (file_name, file_path, status, supplier, supplier_inn) VALUES ('f','/f','processed', ?, ?)`
      ).run(supplier, inn);
    }
  }

  it('uses the verified directory name when ИНН matches, over the OCR name', async () => {
    const CANON = 'ООО "Торговый дом "Нижегородский хлеб""';
    await supplierRepo.create({ inn: '7722316694', name: CANON, bank_bic: '044525225', verified: 1 }, owner);
    expect(await resolveSupplierName('ООО ТД НИЖЕГ ХЛЕБ', '7722316694', owner)).toBe(CANON);
  });

  it('fills the name from the directory even when OCR missed the name entirely', async () => {
    await supplierRepo.create({ inn: '7724400648', name: 'ООО "ГРОСС ФУД"', bank_bic: '044525225', verified: 1 }, owner);
    expect(await resolveSupplierName('', '7724400648', owner)).toBe('ООО "ГРОСС ФУД"');
    expect(await resolveSupplierName(null, '7724400648', owner)).toBe('ООО "ГРОСС ФУД"');
  });

  it('ignores an UNVERIFIED directory card (photo-extract names may be garbled)', async () => {
    await supplierRepo.create({ inn: '5018202085', name: 'ООО ГРЯЗНЫЙ OCR', bank_bic: '044525225', verified: 0 }, owner);
    const out = await resolveSupplierName('ООО "Чистый Поставщик"', '5018202085', owner);
    expect(out).not.toBe('ООО ГРЯЗНЫЙ OCR');
    expect(out).toBeTruthy();
  });

  it('falls back to prior-invoice canonical spelling when no directory card exists', async () => {
    const A = 'ООО "ВЕСЕЛОФФ и ГКОМПАНИЙ"';
    await mkInvoice(A, '5018202085', 2);
    expect(await resolveSupplierName('ООО "ВЕСЕЛОФФ и ГКОМПАНИ"', '5018202085', owner)).toBe(A);
  });

  it('returns undefined when there is neither a directory card nor a raw name', async () => {
    expect(await resolveSupplierName('', '9999999999', owner)).toBeUndefined();
    expect(await resolveSupplierName(null, null, owner)).toBeUndefined();
  });

  // Пер-тенантность: карточка другой компании не должна влиять на распознавание.
  it('ignores a directory card that belongs to another company', async () => {
    const other = await mkUser('other', 'user');
    await supplierRepo.create(
      { inn: '7722316694', name: 'ООО "ЧУЖАЯ КАРТОЧКА"', bank_bic: '044525225', verified: 1 },
      other,
    );

    const out = await resolveSupplierName('ООО МОЙ ПОСТАВЩИК', '7722316694', owner);
    expect(out).not.toBe('ООО "ЧУЖАЯ КАРТОЧКА"');
  });
});
