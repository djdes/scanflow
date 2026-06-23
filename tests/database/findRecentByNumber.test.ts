import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';

// Multi-page merge: two pages of one invoice share the same number within the
// 10-min window, but OCR often misses the supplier on a continuation page (no
// header). A NULL supplier on either side must not block the merge. Real case:
// #190/#191 (number 424) — page 2 had no supplier and they forked into two.
describe.runIf((process.env.DB_NAME || '').includes('test'))('findRecentByNumber — multi-page supplier tolerance', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  async function mk(number: string | null, supplier: string | null, status = 'processed'): Promise<number> {
    const r = await getDb().prepare(
      `INSERT INTO invoices (file_name, file_path, status, invoice_number, supplier) VALUES ('f','/f', ?, ?, ?)`
    ).run(status, number, supplier);
    return Number(r.lastInsertRowid);
  }

  it('matches a sibling whose supplier is NULL (OCR missed the page-2 header)', async () => {
    const sib = await mk('424', null);
    const found = await invoiceRepo.findRecentByNumber('424', 'ООО "ВЕСЕЛОФФ и ГКОМПАНИЙ"', 10);
    expect(found?.id).toBe(sib);
  });

  it('matches when the current page has no supplier', async () => {
    const sib = await mk('424', 'ООО "ВЕСЕЛОФФ и ГКОМПАНИЙ"');
    const found = await invoiceRepo.findRecentByNumber('424', undefined, 10);
    expect(found?.id).toBe(sib);
  });

  it('matches when both suppliers are present and equal', async () => {
    const sib = await mk('424', 'ООО "Первый Поставщик Один"');
    const found = await invoiceRepo.findRecentByNumber('424', 'ООО "Первый Поставщик Один"', 10);
    expect(found?.id).toBe(sib);
  });

  it('does NOT merge two DIFFERENT suppliers that happen to share a number', async () => {
    await mk('424', 'ООО "Первый Поставщик Один"');
    const found = await invoiceRepo.findRecentByNumber('424', 'ЗАО "Второй Поставщик Совсем Другой"', 10);
    expect(found).toBeUndefined();
  });

  it('ignores rows outside the time window', async () => {
    const id = await mk('424', null);
    await getDb().prepare(`UPDATE invoices SET created_at = (NOW() - INTERVAL 30 MINUTE) WHERE id = ?`).run(id);
    const found = await invoiceRepo.findRecentByNumber('424', 'ООО "ВЕСЕЛОФФ и ГКОМПАНИЙ"', 10);
    expect(found).toBeUndefined();
  });
});
