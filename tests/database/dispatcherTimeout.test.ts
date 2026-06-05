import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';

// Queue-aware dispatcher timeout. The 15-min "stale" clock must measure from
// when the worker actually STARTED a task (first photo fetch = dispatcher_fetched_at),
// not from when it was dispatched (dispatcher_started_at). A single serial worker
// draining a batch leaves later tasks queued for >15 min before it ever starts
// them — those must NOT be swept while still queued (the production incident).
describe.runIf((process.env.DB_NAME || '').includes('test'))('markStaleDispatchersAsFailed (queue-aware)', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  async function mkInflight(startedMinAgo: number, fetchedMinAgo: number | null): Promise<number> {
    const r = await getDb().prepare(
      `INSERT INTO invoices (file_name, file_path, status, dispatcher_token)
       VALUES ('f','/f','ocr_processing', REPEAT('a',64))`
    ).run();
    const id = Number(r.lastInsertRowid);
    await getDb().prepare(
      `UPDATE invoices SET dispatcher_started_at = (NOW() - INTERVAL ? MINUTE) WHERE id = ?`
    ).run(startedMinAgo, id);
    if (fetchedMinAgo != null) {
      await getDb().prepare(
        `UPDATE invoices SET dispatcher_fetched_at = (NOW() - INTERVAL ? MINUTE) WHERE id = ?`
      ).run(fetchedMinAgo, id);
    }
    return id;
  }

  it('does NOT sweep a queued task (dispatched long ago, never fetched) within queue grace', async () => {
    const id = await mkInflight(20, null); // 20 min in queue, worker hasn't started it yet
    const n = await invoiceRepo.markStaleDispatchersAsFailed(15, 180);
    expect(n).toBe(0);
    expect((await invoiceRepo.getById(id))?.status).toBe('ocr_processing');
  });

  it('sweeps a task that was fetched (started) but hung past the processing grace', async () => {
    const id = await mkInflight(20, 18); // started, then silent for 18 min
    const n = await invoiceRepo.markStaleDispatchersAsFailed(15, 180);
    expect(n).toBe(1);
    expect((await invoiceRepo.getById(id))?.status).toBe('error');
  });

  it('does NOT sweep a freshly-fetched task still working', async () => {
    const id = await mkInflight(20, 3);
    expect(await invoiceRepo.markStaleDispatchersAsFailed(15, 180)).toBe(0);
    expect((await invoiceRepo.getById(id))?.status).toBe('ocr_processing');
  });

  it('sweeps a never-fetched task past the long queue grace (dead worker)', async () => {
    const id = await mkInflight(200, null);
    expect(await invoiceRepo.markStaleDispatchersAsFailed(15, 180)).toBe(1);
    expect((await invoiceRepo.getById(id))?.status).toBe('error');
  });
});
