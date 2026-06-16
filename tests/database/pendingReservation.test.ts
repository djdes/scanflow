import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';

// /pending reservation: an approved invoice handed to one 1C run must NOT be
// returned again to a concurrent/immediate second run (which would create a
// duplicate ПриходнаяНакладная). It reappears only after the reservation window.
describe.runIf((process.env.DB_NAME || '').includes('test'))('getPendingWithItems reservation', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  async function mkApproved(): Promise<number> {
    const r = await getDb().prepare(
      `INSERT INTO invoices (file_name, file_path, status, approved_for_1c, approved_at)
       VALUES ('f','/f','processed', 1, NOW())`
    ).run();
    return Number(r.lastInsertRowid);
  }

  it('first pull returns the invoice and stamps onec_pulled_at; second pull skips it', async () => {
    const id = await mkApproved();

    const first = await invoiceRepo.getPendingWithItems({});
    expect(first.rows.map(r => r.id)).toContain(id);

    const second = await invoiceRepo.getPendingWithItems({});
    expect(second.rows.map(r => r.id)).not.toContain(id);
    expect(second.total).toBe(0);
  });

  it('reappears after the reservation window expires (retry on failed confirm)', async () => {
    const id = await mkApproved();
    await invoiceRepo.getPendingWithItems({}); // reserve it

    // Age the reservation past the 3-min window.
    await getDb().prepare(
      `UPDATE invoices SET onec_pulled_at = (NOW() - INTERVAL 5 MINUTE) WHERE id = ?`
    ).run(id);

    const again = await invoiceRepo.getPendingWithItems({});
    expect(again.rows.map(r => r.id)).toContain(id);
  });

  it('approveForOneC clears the reservation so a re-approved invoice is immediately pullable', async () => {
    const id = await mkApproved();
    await invoiceRepo.getPendingWithItems({}); // reserve it
    expect((await invoiceRepo.getPendingWithItems({})).rows.map(r => r.id)).not.toContain(id);

    await invoiceRepo.approveForOneC(id); // clears onec_pulled_at
    expect((await invoiceRepo.getPendingWithItems({})).rows.map(r => r.id)).toContain(id);
  });
});
