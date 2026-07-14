import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';

// "No Sber payment in 14 days" detection. A payable invoice (supplier_inn + sum,
// not duplicate, not error) older than the threshold with no non-failed
// sber_payments row is "Sber-overdue": highlighted in the list (sber_overdue
// flag) and alerted once (listNewlyOverdueForSber + markSberOverdueNotified).
describe.runIf((process.env.DB_NAME || '').includes('test'))('Sber-overdue detection', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  // Insert an invoice with a controllable age (days) and payability fields.
  async function mkInvoice(opts: {
    ageDays: number;
    supplierInn?: string | null;
    total?: number | null;
    status?: string;
    duplicateOf?: number | null;
  }): Promise<number> {
    const {
      ageDays, supplierInn = '7830002293', total = 1000,
      status = 'processed', duplicateOf = null,
    } = opts;
    const r = await getDb().prepare(
      `INSERT INTO invoices
         (file_name, file_path, status, supplier_inn, total_sum, duplicate_of, created_at)
       VALUES ('f','/f', ?, ?, ?, ?, (NOW() - INTERVAL ? DAY))`
    ).run(status, supplierInn, total, duplicateOf, ageDays);
    return Number(r.lastInsertRowid);
  }

  async function addPayment(invoiceId: number, status: 'created' | 'pending' | 'failed'): Promise<void> {
    await getDb().prepare(
      `INSERT INTO sber_payments
         (invoice_id, external_id, status, payment_purpose, amount, payer_account, payee_inn)
       VALUES (?, ?, ?, 'test', 1000, '40702810000000000001', '7830002293')`
    ).run(invoiceId, `ext-${invoiceId}-${status}`, status);
  }

  it('flags a payable invoice older than 14 days with no payment', async () => {
    const id = await mkInvoice({ ageDays: 20 });
    const inv = await invoiceRepo.getById(id);
    expect(inv?.sber_overdue).toBe(1);
    expect(inv?.sber_overdue_days).toBe(14);
    const overdue = await invoiceRepo.listNewlyOverdueForSber();
    expect(overdue.map(o => o.id)).toContain(id);
  });

  it('does NOT flag an invoice younger than 14 days', async () => {
    const id = await mkInvoice({ ageDays: 13 });
    expect((await invoiceRepo.getById(id))?.sber_overdue).toBe(0);
    expect((await invoiceRepo.listNewlyOverdueForSber()).map(o => o.id)).not.toContain(id);
  });

  it('does NOT flag when a non-failed payment exists', async () => {
    const created = await mkInvoice({ ageDays: 20 });
    await addPayment(created, 'created');
    const pending = await mkInvoice({ ageDays: 20 });
    await addPayment(pending, 'pending');
    expect((await invoiceRepo.getById(created))?.sber_overdue).toBe(0);
    expect((await invoiceRepo.getById(pending))?.sber_overdue).toBe(0);
    const ids = (await invoiceRepo.listNewlyOverdueForSber()).map(o => o.id);
    expect(ids).not.toContain(created);
    expect(ids).not.toContain(pending);
  });

  it('DOES flag when the only payment is failed', async () => {
    const id = await mkInvoice({ ageDays: 20 });
    await addPayment(id, 'failed');
    expect((await invoiceRepo.getById(id))?.sber_overdue).toBe(1);
    expect((await invoiceRepo.listNewlyOverdueForSber()).map(o => o.id)).toContain(id);
  });

  it('excludes non-payable / duplicate / error invoices', async () => {
    const noInn = await mkInvoice({ ageDays: 20, supplierInn: null });
    const zeroSum = await mkInvoice({ ageDays: 20, total: 0 });
    const dup = await mkInvoice({ ageDays: 20, duplicateOf: 999999 });
    const errored = await mkInvoice({ ageDays: 20, status: 'error' });
    for (const id of [noInn, zeroSum, dup, errored]) {
      expect((await invoiceRepo.getById(id))?.sber_overdue).toBe(0);
    }
    const ids = (await invoiceRepo.listNewlyOverdueForSber()).map(o => o.id);
    for (const id of [noInn, zeroSum, dup, errored]) expect(ids).not.toContain(id);
  });

  it('markSberOverdueNotified removes it from the newly-overdue list (alert once)', async () => {
    const id = await mkInvoice({ ageDays: 20 });
    expect((await invoiceRepo.listNewlyOverdueForSber()).map(o => o.id)).toContain(id);

    await invoiceRepo.markSberOverdueNotified(id);

    // Gone from the alert list, but still highlighted (flag stays true).
    expect((await invoiceRepo.listNewlyOverdueForSber()).map(o => o.id)).not.toContain(id);
    expect((await invoiceRepo.getById(id))?.sber_overdue).toBe(1);
  });
});
