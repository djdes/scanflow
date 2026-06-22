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

  // recognized_at aged 30 min so the multi-page freshness hold never applies —
  // these tests isolate the reservation/onec_pulled_at behaviour. The hold
  // itself is covered in the separate suite below.
  async function mkApproved(): Promise<number> {
    const r = await getDb().prepare(
      `INSERT INTO invoices (file_name, file_path, status, approved_for_1c, approved_at, recognized_at)
       VALUES ('f','/f','processed', 1, NOW(), (NOW() - INTERVAL 30 MINUTE))`
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

// Multi-page freshness hold: a just-recognized approved invoice is withheld from
// /pending so a second photographed page can still auto-merge before 1C pulls
// page 1. Default hold is 5 min (ONEC_MULTIPAGE_HOLD_MINUTES). Context: #424
// (ids 143/145) split because page 1 reached 1C 33s after upload.
describe.runIf((process.env.DB_NAME || '').includes('test'))('getPendingWithItems multi-page hold', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  async function mkApprovedRecognizedAgo(minutesAgo: number): Promise<number> {
    // minutesAgo is a trusted in-test integer; inline it (MySQL is finicky about
    // a placeholder inside INTERVAL ... MINUTE).
    const mins = Math.trunc(minutesAgo);
    const r = await getDb().prepare(
      `INSERT INTO invoices (file_name, file_path, status, approved_for_1c, approved_at, recognized_at)
       VALUES ('f','/f','processed', 1, NOW(), (NOW() - INTERVAL ${mins} MINUTE))`
    ).run();
    return Number(r.lastInsertRowid);
  }

  it('withholds a freshly-recognized invoice (within the hold window)', async () => {
    const id = await mkApprovedRecognizedAgo(1); // 1 min ago < 5 min hold
    const res = await invoiceRepo.getPendingWithItems({});
    expect(res.rows.map(r => r.id)).not.toContain(id);
    expect(res.total).toBe(0);
  });

  it('releases the invoice once the hold window has passed', async () => {
    const id = await mkApprovedRecognizedAgo(10); // 10 min ago > 5 min hold
    const res = await invoiceRepo.getPendingWithItems({});
    expect(res.rows.map(r => r.id)).toContain(id);
  });

  it('falls back to created_at when recognized_at is NULL (legacy rows are not stuck)', async () => {
    // No recognized_at; created_at defaults to NOW() → still within the hold,
    // so it is withheld now but would release once created_at ages out.
    const r = await getDb().prepare(
      `INSERT INTO invoices (file_name, file_path, status, approved_for_1c, approved_at)
       VALUES ('f','/f','processed', 1, NOW())`
    ).run();
    const id = Number(r.lastInsertRowid);
    expect((await invoiceRepo.getPendingWithItems({})).rows.map(r => r.id)).not.toContain(id);

    await getDb().prepare(
      `UPDATE invoices SET created_at = (NOW() - INTERVAL 10 MINUTE) WHERE id = ?`
    ).run(id);
    expect((await invoiceRepo.getPendingWithItems({})).rows.map(r => r.id)).toContain(id);
  });
});
