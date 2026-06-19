import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';

const DRIFT_A = 'ООО "ВЕСЕЛОФФ и ГКОМПАНИЙ"';
const DRIFT_B = 'ООО "ВЕСЕЛОФФ и ГКОМПАНИ"';

describe.runIf((process.env.DB_NAME || '').includes('test'))('supplier fuzzy dedup', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  async function mk(supplier: string, inn: string | null, n = 1): Promise<void> {
    for (let i = 0; i < n; i++) {
      await getDb().prepare(
        `INSERT INTO invoices (file_name, file_path, status, supplier, supplier_inn) VALUES ('f','/f','processed', ?, ?)`
      ).run(supplier, inn);
    }
  }

  it('snaps a drifted name to the existing spelling by ИНН', async () => {
    await mk(DRIFT_A, '5018202085', 3);
    expect(await invoiceRepo.findCanonicalSupplier(DRIFT_B, '5018202085')).toBe(DRIFT_A);
  });

  it('snaps by fuzzy name ≥70% when ИНН is absent', async () => {
    await mk(DRIFT_A, null, 2);
    expect(await invoiceRepo.findCanonicalSupplier(DRIFT_B, null)).toBe(DRIFT_A);
  });

  it('does NOT merge across two different ИНН', async () => {
    await mk(DRIFT_A, '5018202085', 2);
    expect(await invoiceRepo.findCanonicalSupplier(DRIFT_B, '9999999999')).toBeNull();
  });

  it('returns null for a genuinely new supplier', async () => {
    await mk(DRIFT_A, '5018202085', 2);
    expect(await invoiceRepo.findCanonicalSupplier('ИП Кнутова Александра', '7701234567')).toBeNull();
  });

  it('renameSupplier rewrites matching invoices and merges counts', async () => {
    await mk('ВариантА Полное Имя', null, 1);
    await mk('ВариантБ Полное Имя', null, 1);
    const n = await invoiceRepo.renameSupplier(['ВариантБ Полное Имя'], 'ВариантА Полное Имя');
    expect(n).toBe(1);
    const d = await invoiceRepo.distinctSuppliers();
    expect(d.find(x => x.supplier === 'ВариантБ Полное Имя')).toBeUndefined();
    expect(d.find(x => x.supplier === 'ВариантА Полное Имя')?.count).toBe(2);
  });
});
