import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';
import { isStatedVatConsistent } from '../../src/parser/itemSanitizer';

describe('isStatedVatConsistent', () => {
  it('accepts a clean 22% VAT-included amount (#198: 7097.91 of 39361.10)', () => {
    expect(isStatedVatConsistent(7097.91, 39361.10)).toBe(true);
  });
  it('accepts 20% and ~10%', () => {
    expect(isStatedVatConsistent(6560.18, 39361.10)).toBe(true);  // 20%
    expect(isStatedVatConsistent(1000, 11000)).toBe(true);         // 10% incl. (1000 of 11000)
  });
  it('accepts a MIXED-rate blended VAT (#202: 5101.43 of 40507.62 → ~14.4%)', () => {
    expect(isStatedVatConsistent(5101.43, 40507.62)).toBe(true);
  });
  it('rejects a stale partial matching no standard rate', () => {
    expect(isStatedVatConsistent(2700, 44478.20)).toBe(false);     // ~6.46%
  });
  it('rejects null / out-of-range', () => {
    expect(isStatedVatConsistent(null, 100)).toBe(false);
    expect(isStatedVatConsistent(100, null)).toBe(false);
    expect(isStatedVatConsistent(100, 100)).toBe(false);
  });
});

describe.runIf((process.env.DB_NAME || '').includes('test'))('recalculateTotal — VAT source of truth', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  async function mk(total: number, vat: number | null, items: Array<[number, number]>): Promise<number> {
    const id = Number((await getDb().prepare(
      `INSERT INTO invoices (file_name, file_path, status, total_sum, vat_sum) VALUES ('f','/f','processed', ?, ?)`
    ).run(total, vat)).lastInsertRowid);
    for (const [tot, rate] of items) {
      await getDb().prepare(
        `INSERT INTO invoice_items (invoice_id, original_name, total, vat_rate) VALUES (?, 'x', ?, ?)`
      ).run(id, tot, rate);
    }
    return id;
  }

  it('keeps the stated 22% VAT even when items are mis-tagged 20% (#198)', async () => {
    const id = await mk(39361.10, 7097.91, [[39361.10, 20]]);
    await invoiceRepo.recalculateTotal(id);
    expect(Number((await invoiceRepo.getById(id))?.vat_sum)).toBeCloseTo(7097.91, 2);
  });

  it('derives from per-item rates when the stated VAT is missing', async () => {
    const id = await mk(39361.10, null, [[39361.10, 20]]);
    await invoiceRepo.recalculateTotal(id);
    expect(Number((await invoiceRepo.getById(id))?.vat_sum)).toBeCloseTo(6560.18, 2);  // 20% extraction
  });

  it('derives when the stated VAT is a stale multi-page partial', async () => {
    const id = await mk(44478.20, 2700, [[44478.20, 10]]);
    await invoiceRepo.recalculateTotal(id);
    // 10% extraction of the grand total, NOT the stale 2700.
    expect(Number((await invoiceRepo.getById(id))?.vat_sum)).toBeCloseTo(44478.20 * 10 / 110, 1);
  });

  it('keeps the stated MIXED-rate VAT over a slightly-off per-item derivation (#202)', async () => {
    // Stated 5101.43; per-item rates derive ~5112 (one line rate misread). The
    // document figure must win.
    const id = await mk(40507.62, 5101.43, [[3213.6, 22], [2849.88, 10], [4398.10, 22], [30045.84, 10]]);
    await invoiceRepo.recalculateTotal(id);
    expect(Number((await invoiceRepo.getById(id))?.vat_sum)).toBeCloseTo(5101.43, 2);
  });

  it('forceDerive ignores the stated VAT (used by дофоткать/merge append)', async () => {
    const id = await mk(39361.10, 7097.91, [[39361.10, 20]]);
    await invoiceRepo.recalculateTotal(id, { forceDerive: true });
    expect(Number((await invoiceRepo.getById(id))?.vat_sum)).toBeCloseTo(6560.18, 2);  // derived 20%, stated ignored
  });
});
