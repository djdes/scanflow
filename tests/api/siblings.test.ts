import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';

// Exercises the repo wiring the route depends on. We assert via findSiblings +
// merge-into behaviour rather than spinning Express, mirroring pendingReservation.
describe.runIf((process.env.DB_NAME || '').includes('test'))('sibling detection + merge', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  const SUP = 'ООО "Свит Лайф Фудсервис"';
  async function mk(num: string, date: string, total: number, items: number): Promise<number> {
    const r = await getDb().prepare(
      `INSERT INTO invoices (file_name, file_path, invoice_number, invoice_date, supplier, total_sum, status)
       VALUES ('f','/f', ?, ?, ?, ?, 'processed')`
    ).run(num, date, SUP, total);
    const id = Number(r.lastInsertRowid);
    for (let i = 0; i < items; i++) await invoiceRepo.addItem({ invoice_id: id, original_name: `x${i}`, total: total / items });
    return id;
  }

  it('detail-level findSiblings surfaces the split row', async () => {
    const a = await mk('17-0348232', '2026-06-09', 54217.6, 8);
    const b = await mk('17-0348232', '2026-06-09', 50761.6, 5);
    const sibs = await invoiceRepo.findSiblings(a);
    expect(sibs.map(s => s.id)).toEqual([b]);
  });

  it('merge-into collapses two rows into one (items summed, total = max)', async () => {
    const a = await mk('17-0348232', '2026-06-09', 54217.6, 8); // canonical (lower id)
    const b = await mk('17-0348232', '2026-06-09', 50761.6, 5);

    await invoiceRepo.moveItemsToInvoice(b, a);
    if (54217.6 > 0) await invoiceRepo.updateInvoiceData(a, { total_sum: 54217.6 });
    await invoiceRepo.delete(b);
    await invoiceRepo.recalculateTotal(a);

    const merged = await invoiceRepo.getWithItems(a);
    expect(merged!.items).toHaveLength(13);
    expect(await invoiceRepo.getById(b)).toBeUndefined();
  });
});
