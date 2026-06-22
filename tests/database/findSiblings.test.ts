import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';

describe.runIf((process.env.DB_NAME || '').includes('test'))('invoiceRepo.findSiblings', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  // Insert a fully-controlled invoice row. `ageMin` backdates created_at so we
  // prove findSiblings ignores any time window.
  async function mkInvoice(opts: {
    number?: string | null; date?: string | null; supplier?: string | null;
    total?: number | null; status?: string; approved?: number; duplicateOf?: number | null;
    ageMin?: number; items?: number;
  }): Promise<number> {
    const r = await getDb().prepare(
      `INSERT INTO invoices
         (file_name, file_path, invoice_number, invoice_date, supplier, total_sum,
          status, approved_for_1c, duplicate_of, created_at)
       VALUES ('f','/f', :num, :date, :sup, :total, :status, :appr, :dup,
          (NOW() - INTERVAL :age MINUTE))`
    ).run({
      num: opts.number ?? null, date: opts.date ?? null, sup: opts.supplier ?? null,
      total: opts.total ?? null, status: opts.status ?? 'processed',
      appr: opts.approved ?? 0, dup: opts.duplicateOf ?? null, age: opts.ageMin ?? 0,
    });
    const id = Number(r.lastInsertRowid);
    for (let i = 0; i < (opts.items ?? 0); i++) {
      await getDb().prepare(
        `INSERT INTO invoice_items (invoice_id, original_name) VALUES (?, ?)`
      ).run(id, `item-${i}`);
    }
    return id;
  }

  const SUP = 'ООО "Свит Лайф Фудсервис"';

  it('finds a sibling with same number+supplier+date regardless of age/status', async () => {
    const a = await mkInvoice({ number: '17-0348232', date: '2026-06-09', supplier: SUP, total: 54217.6, status: 'sent_to_1c', ageMin: 120, items: 8 });
    const b = await mkInvoice({ number: '17-0348232', date: '2026-06-09', supplier: SUP, total: 50761.6, status: 'sent_to_1c', ageMin: 90, items: 5 });

    const sibsOfB = await invoiceRepo.findSiblings(b);
    expect(sibsOfB.map(s => s.id)).toEqual([a]);
    expect(sibsOfB[0].items_count).toBe(8);
    expect(sibsOfB[0].status).toBe('sent_to_1c');
  });

  it('does NOT match when both have a date and the dates differ', async () => {
    const a = await mkInvoice({ number: '17-0348232', date: '2026-06-09', supplier: SUP });
    const b = await mkInvoice({ number: '17-0348232', date: '2026-07-09', supplier: SUP });
    expect(await invoiceRepo.findSiblings(b)).toHaveLength(0);
    expect(await invoiceRepo.findSiblings(a)).toHaveLength(0);
  });

  it('matches when one side has no date (number+supplier is enough)', async () => {
    const a = await mkInvoice({ number: '17-0348232', date: '2026-06-09', supplier: SUP });
    const b = await mkInvoice({ number: '17-0348232', date: null, supplier: SUP });
    expect((await invoiceRepo.findSiblings(b)).map(s => s.id)).toEqual([a]);
    expect((await invoiceRepo.findSiblings(a)).map(s => s.id)).toEqual([b]);
  });

  it('ignores rows flagged as exact duplicates and number-less rows, and itself', async () => {
    const orig = await mkInvoice({ number: '17-0348232', date: '2026-06-09', supplier: SUP });
    await mkInvoice({ number: '17-0348232', date: '2026-06-09', supplier: SUP, duplicateOf: orig });
    await mkInvoice({ number: null, date: '2026-06-09', supplier: SUP });
    expect(await invoiceRepo.findSiblings(orig)).toHaveLength(0);
  });

  it('does NOT match a different supplier', async () => {
    await mkInvoice({ number: '17-0348232', date: '2026-06-09', supplier: SUP });
    const b = await mkInvoice({ number: '17-0348232', date: '2026-06-09', supplier: 'ООО "Другой Поставщик"' });
    expect(await invoiceRepo.findSiblings(b)).toHaveLength(0);
  });

  it('returns [] when the invoice has no number', async () => {
    const a = await mkInvoice({ number: null, date: '2026-06-09', supplier: SUP });
    expect(await invoiceRepo.findSiblings(a)).toHaveLength(0);
  });
});
