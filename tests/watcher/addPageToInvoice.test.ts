import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';
import { FileWatcher } from '../../src/watcher/fileWatcher';
import { NomenclatureMapper } from '../../src/mapping/nomenclatureMapper';

describe.runIf((process.env.DB_NAME || '').includes('test'))('FileWatcher.addPageToInvoice', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  it('appends page items, backfills only-empty header fields, bumps total, adds photo', async () => {
    await getDb().prepare(`UPDATE analyzer_config SET mode='claude_api' WHERE id=1`).run();

    const inv = Number((await getDb().prepare(
      `INSERT INTO invoices (file_name, file_path, status, supplier, total_sum) VALUES ('p1.jpg','/x','processed','ООО Ромашка', 1000)`
    ).run()).lastInsertRowid);
    await getDb().prepare(
      `INSERT INTO invoice_items (invoice_id, original_name, quantity, unit, price, total) VALUES (?, 'Товар1', 1, 'шт', 1000, 1000)`
    ).run(inv);

    const stubOcr = {
      recognizeWithClaudeApi: async () => ({
        text: '', engine: 'claude_api',
        structured: {
          invoice_number: 'N-99', supplier: 'ООО Другая', supplier_inn: '7701234567',
          invoice_date: '2026-06-10', total_sum: 2500, vat_sum: null, invoice_type: null,
          items: [
            { name: 'Товар2', quantity: 2, unit: 'шт', price: 500, total: 1000, vat_rate: 10 },
            { name: 'Товар3', quantity: 1, unit: 'шт', price: 500, total: 500, vat_rate: 10 },
          ],
        },
      }),
    };

    const fw = new FileWatcher(stubOcr as never, new NomenclatureMapper());
    const added = await fw.addPageToInvoice(inv, '/nonexistent/p2.jpg', 'p2.jpg');
    expect(added).toBe(2);

    const d = await invoiceRepo.getWithItems(inv);
    expect(d?.items.length).toBe(3);                 // 1 original + 2 appended
    expect(d?.supplier).toBe('ООО Ромашка');         // existing kept, NOT overwritten
    expect(d?.invoice_number).toBe('N-99');          // backfilled (was empty)
    expect(d?.supplier_inn).toBe('7701234567');      // backfilled
    expect(d?.total_sum).toBe(2500);                 // bumped (2500 > 1000)
    expect(d?.file_name).toContain('p2.jpg');        // photo added to gallery
    expect(d?.items_total_mismatch).toBe(0);         // 1000+1000+500 == 2500
  });
});
