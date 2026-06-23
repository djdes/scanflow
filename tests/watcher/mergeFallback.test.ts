import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';
import { FileWatcher } from '../../src/watcher/fileWatcher';
import { NomenclatureMapper } from '../../src/mapping/nomenclatureMapper';

// Regression for #194: a multi-page merge re-analyzes the combined OCR text via
// a SECOND Claude call. The temp page row is deleted before that call, so if it
// throws the page used to vanish (no items, no total, no VAT). The merge must
// instead fold this page's already-parsed data into the parent losslessly.
describe.runIf((process.env.DB_NAME || '').includes('test'))('FileWatcher multi-page merge — lossless on re-analysis failure', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  it('appends page-2 items when the combined re-analysis fails (no data loss)', async () => {
    await getDb().prepare(`UPDATE analyzer_config SET mode='claude_api' WHERE id=1`).run();

    // Page 1 already processed: number 424, supplier set, one item, no total yet.
    const p1 = Number((await getDb().prepare(
      `INSERT INTO invoices (file_name, file_path, status, invoice_number, supplier, raw_text)
       VALUES ('p1.jpg','/x','processed','424','ООО Веселофф','{"items":[]}')`
    ).run()).lastInsertRowid);
    await getDb().prepare(
      `INSERT INTO invoice_items (invoice_id, original_name, quantity, unit, price, total, vat_rate)
       VALUES (?, 'Товар стр1', 1, 'шт', 10000, 10000, 10)`
    ).run(p1);

    const stubOcr = {
      // Page 2: same number 424, supplier null (header missing on page 2), 1 new item.
      recognizeWithClaudeApi: async () => ({
        text: '{"page2":true}', engine: 'claude_api',
        structured: {
          invoice_number: '424', supplier: null, supplier_inn: null,
          invoice_date: null, total_sum: 17693.40, vat_sum: 5421.40, invoice_type: null,
          items: [
            { name: 'Сычужный продукт Тильзитер', quantity: 166, unit: 'кг', price: 46.34, total: 7693.40, vat_rate: 10 },
          ],
        },
      }),
      // The 2nd Claude call (combined re-analysis) FAILS — the bug scenario.
      analyzeMultiPageText: async () => { throw new Error('Claude timeout (simulated)'); },
    };

    const fw = new FileWatcher(stubOcr as never, new NomenclatureMapper());

    // processFile needs a real file (sha256 dedup + move).
    const tmp = path.join(os.tmpdir(), `sf-merge-${Date.now()}.jpg`);
    fs.writeFileSync(tmp, 'dummy-bytes');

    const resultId = await fw.processFile(tmp, 'page2.jpg');

    // Folded into page 1 — NOT a new/forked invoice.
    expect(resultId).toBe(p1);

    const d = await invoiceRepo.getWithItems(p1);
    expect(d?.items.length).toBe(2);                                          // page-1 + page-2 item
    expect(d?.items.some(i => (i.original_name || '').includes('Тильзитер'))).toBe(true);
    expect(Number(d?.total_sum)).toBeCloseTo(17693.40, 1);                    // grand total carried over
    expect(d?.vat_sum).not.toBeNull();                                        // VAT derived from per-item rates
    expect(d?.items_total_mismatch).toBe(0);                                  // 10000 + 7693.40 == 17693.40

    // The temp page-2 row must be gone (folded in, not left as an orphan).
    const all = await getDb().prepare(`SELECT COUNT(*) c FROM invoices`).get<{ c: number }>();
    expect(Number(all?.c)).toBe(1);
  });
});
