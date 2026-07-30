import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';

// getNeighbours powers the ←/→ in-detail navigation. List order is created_at
// DESC (newest on top), so "next" = the immediately NEWER invoice and "prev" =
// the immediately OLDER one, scoped to the owner.
describe.runIf((process.env.DB_NAME || '').includes('test'))('getNeighbours (prev/next)', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  async function mk(minutesAgo: number, owner: number | null = 1): Promise<number> {
    const r = await getDb().prepare(
      `INSERT INTO invoices (file_name, file_path, status, owner_user_id, created_at)
       VALUES ('f','/f','processed', ?, (NOW() - INTERVAL ? MINUTE))`
    ).run(owner, minutesAgo);
    return Number(r.lastInsertRowid);
  }

  it('middle invoice: prev = older, next = newer', async () => {
    const older = await mk(30);
    const mid = await mk(20);
    const newer = await mk(10);
    const n = await invoiceRepo.getNeighbours(mid, 1);
    expect(n.prev?.id).toBe(older);
    expect(n.next?.id).toBe(newer);
  });

  it('newest invoice has no next', async () => {
    const older = await mk(20);
    const newest = await mk(10);
    const n = await invoiceRepo.getNeighbours(newest, 1);
    expect(n.next).toBeNull();
    expect(n.prev?.id).toBe(older);
  });

  it('oldest invoice has no prev', async () => {
    const oldest = await mk(20);
    const newer = await mk(10);
    const n = await invoiceRepo.getNeighbours(oldest, 1);
    expect(n.prev).toBeNull();
    expect(n.next?.id).toBe(newer);
  });

  it('skips other tenants — neighbours stay within the owner', async () => {
    const mine1 = await mk(30, 1);
    await mk(20, 2); // foreign invoice sitting between mine1 and mine2 by time
    const mine2 = await mk(10, 1);
    const n = await invoiceRepo.getNeighbours(mine1, 1);
    expect(n.next?.id).toBe(mine2); // foreign one skipped
  });

  it('returns nulls for a non-existent id', async () => {
    const n = await invoiceRepo.getNeighbours(999999, 1);
    expect(n).toEqual({ prev: null, next: null });
  });
});
