import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';
import { invoiceCompleteness, incompleteInvoiceSql } from '../../src/ocr/invoiceCompleteness';
import { evaluateInvoiceQuality } from '../../src/automation/qualityGate';

vi.mock('../../src/watcher/fileWatcher', () => ({ FileWatcher: class {} }));
vi.mock('../../src/mapping/nomenclatureMapper', () => ({ NomenclatureMapper: class {} }));
import { createServer } from '../../src/api/server';
import { FileWatcher } from '../../src/watcher/fileWatcher';
import { NomenclatureMapper } from '../../src/mapping/nomenclatureMapper';

const app = createServer(new FileWatcher() as never, new NomenclatureMapper() as never);
const range = (first: number, last: number) => Array.from({ length: last - first + 1 }, (_, i) => first + i);

async function addRows(id: number, numbers: Array<number | null>) {
  for (const [index, rowNo] of numbers.entries()) {
    await getDb().prepare(`INSERT INTO invoice_items
      (invoice_id, original_name, mapped_name, onec_guid, quantity, unit, price, total, row_no, mapping_confidence)
      VALUES (?, ?, 'Test item', 'test-guid', 1, 'kg', 100, 100, ?, 1)`)
      .run(id, `Test item ${rowNo ?? index}`, rowNo);
  }
}

async function createInvoice(numbers: Array<number | null>, opts: { owner?: number; engine?: string; file?: string; approved?: number } = {}) {
  const result = await getDb().prepare(`INSERT INTO invoices
    (owner_user_id, file_name, file_path, status, invoice_number, invoice_date, supplier, supplier_inn,
     total_sum, ocr_engine, approved_for_1c, created_at, recognized_at)
    VALUES (?, ?, '/test/invoice.jpg', 'processed', 'TEST-001', '2026-01-01', 'Test supplier', '1234567890',
      3000, ?, ?, '2026-01-01', '2026-01-01')`)
    .run(opts.owner ?? 1, opts.file ?? 'invoice.jpg', opts.engine ?? 'gpt_api', opts.approved ?? 0);
  const id = Number(result.lastInsertRowid);
  await addRows(id, numbers);
  return id;
}

describe.runIf((process.env.DB_NAME || '').includes('test'))('invoice page completeness across API, lists and 1C', () => {
  beforeEach(async () => {
    await resetDb();
    await getDb().prepare(`INSERT INTO users (id, username, password_hash, api_key, role, notify_events)
      VALUES (1, 'completeness1', 'x', 'complete1', 'user', '[]'), (2, 'completeness2', 'x', 'complete2', 'user', '[]')`).run();
  });
  afterAll(closeTestDb);

  it('shows missing first page and holds both manual approval and autopilot despite checked totals', async () => {
    const id = await createInvoice(range(21, 30));
    await getDb().prepare('UPDATE invoices SET items_total_mismatch = 1, attr_checked_total = 1 WHERE id = ?').run(id);
    const detail = await request(app).get(`/api/invoices/${id}`).set('X-API-Key', 'complete1');
    expect(detail.status).toBe(200);
    expect(detail.body.data.completeness).toMatchObject({ checked: true, first_row: 21, missing_ranges: [{ from: 1, to: 20 }] });
    expect(detail.body.data.items[0].row_no).toBe(21);
    const attention = await request(app).get('/api/invoices?view=attention').set('X-API-Key', 'complete1');
    expect(attention.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ id, review_reason: 'incomplete_pages' })]));
    const sent = await request(app).post(`/api/invoices/${id}/send`).set('X-API-Key', 'complete1');
    expect(sent.status).toBe(409);
    expect(sent.body.code).toBe('incomplete_pages');
    expect((await invoiceRepo.getById(id))!.approved_for_1c).toBe(0);
    expect((await evaluateInvoiceQuality(id)).reasons.map(r => r.code)).toContain('incomplete_pages');
  });

  it('removes the warning after the first page is joined, regardless of insertion order', async () => {
    const id = await createInvoice(range(21, 30));
    await addRows(id, range(1, 20));
    const detail = await request(app).get(`/api/invoices/${id}`).set('X-API-Key', 'complete1');
    expect(detail.body.data.completeness).toMatchObject({ checked: true, first_row: 1, last_row: 30, message: null });
    expect((await invoiceRepo.getAll(undefined, 50, 0, 1))[0].review_reason).toBeNull();
    expect((await evaluateInvoiceQuality(id)).reasons.map(r => r.code)).not.toContain('incomplete_pages');
  });

  it('withholds already approved incomplete invoices from the 1C pull and respects company scope', async () => {
    const missing = await createInvoice(range(21, 30), { approved: 1 });
    const whole = await createInvoice(range(1, 30), { approved: 1 });
    await createInvoice(range(1, 30), { owner: 2, approved: 1 });
    const pending = await request(app).get('/api/invoices/pending').set('X-API-Key', 'complete1');
    expect(pending.status).toBe(200);
    expect(pending.body.total).toBe(1);
    expect(pending.body.data.map((i: { id: number }) => i.id)).toEqual([whole]);
    expect((await invoiceRepo.getById(missing))!.onec_pulled_at).toBeNull();
  });

  it('uses the same SQL and pure rule for gaps, duplicates, unknown numbers and XML documents', async () => {
    const cases = [
      { numbers: [1, 2, 5] }, { numbers: [1, 2, 2, 3] }, { numbers: [1, 1, 3] },
      { numbers: [21, null] }, { numbers: [0, 21] }, { numbers: [] },
      { numbers: [21, 22], engine: 'xml_upd' }, { numbers: [21], file: 'invoice.XML' },
      { numbers: [21], file: 'invoice.XML, other.xml' },
    ];
    for (const c of cases) {
      const id = await createInvoice(c.numbers, c);
      const result = await getDb().prepare(`SELECT ${incompleteInvoiceSql()} AS incomplete FROM invoices WHERE id = ?`)
        .get<{ incomplete: number }>(id);
      expect(Boolean(result!.incomplete)).toBe(Boolean(invoiceCompleteness({
        ocr_engine: c.engine, file_name: c.file, items: c.numbers.map(row_no => ({ row_no })),
      }).message));
    }
  });

  it('«все страницы на месте» снимает проверку: отправка, автопилот и выдача 1С; отметка в журнале и снимается', async () => {
    const id = await createInvoice([1, 2, 4, 5]);
    expect((await request(app).post(`/api/invoices/${id}/send`).set('X-API-Key', 'complete1')).status).toBe(409);

    const confirmed = await request(app).post(`/api/invoices/${id}/pages-confirmed`).set('X-API-Key', 'complete1').send({ value: true });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.completeness).toMatchObject({ message: null, confirmed: true, missing_ranges: [{ from: 3, to: 3 }] });
    const detail = await request(app).get(`/api/invoices/${id}`).set('X-API-Key', 'complete1');
    expect(detail.body.data.completeness).toMatchObject({ message: null, confirmed: true });
    expect((await evaluateInvoiceQuality(id)).reasons.map(r => r.code)).not.toContain('incomplete_pages');
    const sql = await getDb().prepare(`SELECT ${incompleteInvoiceSql()} AS incomplete FROM invoices WHERE id = ?`).get<{ incomplete: number }>(id);
    expect(Boolean(sql!.incomplete)).toBe(false);
    const log = await getDb().prepare(`SELECT field, old_value, new_value FROM edit_log WHERE invoice_id = ? AND field = 'pages_confirmed'`).all<{ field: string }>(id);
    expect(log).toHaveLength(1);

    const reverted = await request(app).post(`/api/invoices/${id}/pages-confirmed`).set('X-API-Key', 'complete1').send({ value: false });
    expect(reverted.body.data.completeness.message).toContain('3');
    expect((await request(app).post(`/api/invoices/${id}/send`).set('X-API-Key', 'complete1')).status).toBe(409);
  });

  it('отметку «все страницы на месте» не поставить на чужую накладную', async () => {
    const id = await createInvoice(range(21, 30), { owner: 2 });
    const result = await request(app).post(`/api/invoices/${id}/pages-confirmed`).set('X-API-Key', 'complete1').send({ value: true });
    expect(result.status).toBe(404);
    expect(Number((await invoiceRepo.getById(id))!.pages_confirmed)).toBe(0);
  });

  it('does not reveal missing-page details to another company', async () => {
    const id = await createInvoice(range(21, 30), { owner: 2 });
    const result = await request(app).get(`/api/invoices/${id}`).set('X-API-Key', 'complete1');
    expect(result.status).toBe(404);
  });
});
