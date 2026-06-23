import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';

// Backs the multi-page concurrency guard: a continuation page waits for any
// EARLIER page still scanning (ocr_processing/parsing) before deciding it's
// standalone — the 205/206 fork was two pages OCR'ing in parallel, each blind
// to the other because supplier/items commit only at the end of a run.
describe.runIf((process.env.DB_NAME || '').includes('test'))('countInFlightOlderThan', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  async function mk(status: string): Promise<number> {
    const r = await getDb().prepare(
      `INSERT INTO invoices (file_name, file_path, status) VALUES ('f','/f', ?)`
    ).run(status);
    return Number(r.lastInsertRowid);
  }

  it('counts an earlier still-scanning invoice, and stops once it settles', async () => {
    const older = await mk('ocr_processing');
    const current = await mk('parsing');
    expect(await invoiceRepo.countInFlightOlderThan(current, 5)).toBe(1);

    await getDb().prepare(`UPDATE invoices SET status='processed' WHERE id=?`).run(older);
    expect(await invoiceRepo.countInFlightOlderThan(current, 5)).toBe(0);
  });

  it('ignores NEWER in-flight invoices (only waits on earlier ids — no deadlock)', async () => {
    const current = await mk('parsing');
    await mk('ocr_processing');                 // newer id, in-flight
    expect(await invoiceRepo.countInFlightOlderThan(current, 5)).toBe(0);
  });

  it('ignores earlier invoices that are already terminal', async () => {
    await mk('processed');
    await mk('error');
    const current = await mk('parsing');
    expect(await invoiceRepo.countInFlightOlderThan(current, 5)).toBe(0);
  });

  it('ignores earlier in-flight invoices outside the time window', async () => {
    const older = await mk('ocr_processing');
    await getDb().prepare(`UPDATE invoices SET created_at = (NOW() - INTERVAL 30 MINUTE) WHERE id=?`).run(older);
    const current = await mk('parsing');
    expect(await invoiceRepo.countInFlightOlderThan(current, 5)).toBe(0);
  });
});
