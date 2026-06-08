import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';

vi.mock('../../src/watcher/fileWatcher', () => ({ FileWatcher: class {} }));
vi.mock('../../src/mapping/nomenclatureMapper', () => ({ NomenclatureMapper: class {} }));

import { createServer } from '../../src/api/server';
import { FileWatcher } from '../../src/watcher/fileWatcher';
import { NomenclatureMapper } from '../../src/mapping/nomenclatureMapper';

let app: express.Express;
beforeAll(() => {
  app = createServer(new FileWatcher() as never, new NomenclatureMapper() as never);
});

async function setupUser(): Promise<string> {
  await getDb().prepare(
    `INSERT INTO users (id, username, password_hash, api_key, role, notify_events) VALUES (1, 'admin', 'x', 'k', 'admin', '[]')`
  ).run();
  return 'k';
}

async function createInvoiceWithItems(
  opts: { file: string; supplier: string; number: string | null; total: number; items: Array<{ total: number; row_no: number }> },
): Promise<number> {
  const r = await getDb().prepare(
    `INSERT INTO invoices (file_name, file_path, status, supplier, invoice_number, invoice_date, total_sum)
     VALUES (?, ?, 'processed', ?, ?, '2026-05-26', ?)`
  ).run(opts.file, `/t/${opts.file}`, opts.supplier, opts.number, opts.total);
  const id = Number(r.lastInsertRowid);
  for (const it of opts.items) {
    await getDb().prepare(
      `INSERT INTO invoice_items (invoice_id, original_name, quantity, unit, price, total, mapping_confidence, row_no)
       VALUES (?, 'Товар', 1, 'шт', ?, ?, 0, ?)`
    ).run(id, it.total, it.total, it.row_no);
  }
  return id;
}

async function getInvoice(id: number) {
  return getDb().prepare('SELECT * FROM invoices WHERE id = ?').get<{ status: string; total_sum: number | null; items_total_mismatch: number; file_name: string }>(id);
}
async function itemCount(id: number): Promise<number> {
  const r = await getDb().prepare('SELECT COUNT(*) c FROM invoice_items WHERE invoice_id = ?').get<{ c: number }>(id);
  return Number(r?.c ?? 0);
}

describe.runIf((process.env.DB_NAME || '').includes('test'))('POST /api/invoices/:id/merge-into/:targetId', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  it('folds the source page into the target: moves items, carries the photo, sets grand total, deletes source', async () => {
    const key = await setupUser();
    // target = page 1 (rows 1-10, items sum 40603)
    const target = await createInvoiceWithItems({
      file: 'p1.jpg', supplier: 'АО "ОПТИКОМ"', number: '1/236534', total: 40603,
      items: Array.from({ length: 10 }, (_, i) => ({ total: 4060.3, row_no: i + 1 })),
    });
    // source = page 2 (row 11, one item 2359.28, total_sum is the grand 42962.28)
    const source = await createInvoiceWithItems({
      file: 'p2.jpg', supplier: 'АО "ОПТТОРГ"', number: null, total: 42962.28,
      items: [{ total: 2359.28, row_no: 11 }],
    });

    const res = await request(app)
      .post(`/api/invoices/${source}/merge-into/${target}`)
      .set('X-API-Key', key);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(target);

    expect(await getInvoice(source)).toBeUndefined();        // source folded away
    expect(await itemCount(target)).toBe(11);                // 10 + 1
    const t = await getInvoice(target);
    expect(t?.total_sum).toBe(42962.28);                     // grand = max(totals)
    expect(t?.items_total_mismatch).toBe(0);                 // 40603 + 2359.28 == 42962.28
    expect(t?.file_name).toContain('p2.jpg');               // source photo carried over
  });

  it('returns 404 when source or target does not exist', async () => {
    const key = await setupUser();
    const target = await createInvoiceWithItems({ file: 'p1.jpg', supplier: 'X', number: 'N', total: 100, items: [{ total: 100, row_no: 1 }] });
    const res = await request(app).post(`/api/invoices/999999/merge-into/${target}`).set('X-API-Key', key);
    expect(res.status).toBe(404);
  });

  it('rejects merging an invoice into itself with 400', async () => {
    const key = await setupUser();
    const id = await createInvoiceWithItems({ file: 'p1.jpg', supplier: 'X', number: 'N', total: 100, items: [{ total: 100, row_no: 1 }] });
    const res = await request(app).post(`/api/invoices/${id}/merge-into/${id}`).set('X-API-Key', key);
    expect(res.status).toBe(400);
  });
});
