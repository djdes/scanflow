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

async function setupUser(): Promise<void> {
  const defaultEvents = JSON.stringify(['photo_uploaded', 'invoice_recognized', 'recognition_error', 'suspicious_total']);
  await getDb().prepare(
    `INSERT INTO users (id, username, password_hash, api_key, role, notify_events) VALUES (1, 'admin', 'x', 'k', 'admin', ?)`
  ).run(defaultEvents);
}

const TOKEN = 'a'.repeat(64);

// Create an invoice already in 'ocr_processing' with a dispatcher token —
// i.e. one awaiting a callback. Returns its id.
async function createPending(opts: { supplier?: string | null; number?: string | null } = {}): Promise<number> {
  const r = await getDb().prepare(
    `INSERT INTO invoices (file_name, file_path, status, supplier, invoice_number, dispatcher_token, dispatcher_started_at)
     VALUES (?, ?, 'ocr_processing', ?, ?, ?, NOW())`
  ).run('pending.jpg', '/test/pending.jpg', opts.supplier ?? null, opts.number ?? null, TOKEN);
  return Number(r.lastInsertRowid);
}

// Create an already-processed page-1 invoice with one item.
async function createProcessedPage1(supplier: string, number: string | null): Promise<number> {
  const r = await getDb().prepare(
    `INSERT INTO invoices (file_name, file_path, status, supplier, invoice_number, total_sum)
     VALUES (?, ?, 'processed', ?, ?, ?)`
  ).run('page1.jpg', '/test/page1.jpg', supplier, number, 100);
  const id = Number(r.lastInsertRowid);
  await getDb().prepare(
    `INSERT INTO invoice_items (invoice_id, original_name, quantity, unit, price, total, mapping_confidence)
     VALUES (?, 'Товар А', 1, 'шт', 100, 100, 0)`
  ).run(id);
  return id;
}

async function getInvoice(id: number) {
  return getDb().prepare('SELECT * FROM invoices WHERE id = ?').get<{ status: string; total_sum: number | null; items_total_mismatch: number; duplicate_of: number | null }>(id);
}
async function itemCount(id: number): Promise<number> {
  const r = await getDb().prepare('SELECT COUNT(*) c FROM invoice_items WHERE invoice_id = ?').get<{ c: number }>(id);
  return Number(r?.c ?? 0);
}

describe.runIf((process.env.DB_NAME || '').includes('test'))('POST /api/dispatcher/result/:id', () => {
  beforeEach(async () => { await resetDb(); await setupUser(); });
  afterAll(async () => { await closeTestDb(); });

  it('rejects an invalid token with 401', async () => {
    const id = await createPending();
    const res = await request(app).post(`/api/dispatcher/result/${id}`).send({ token: 'b'.repeat(64), success: true, data: { items: [] } });
    expect(res.status).toBe(401);
  });

  it('processes a standalone invoice, persists items and computes total', async () => {
    const id = await createPending({ supplier: null, number: null });
    const res = await request(app).post(`/api/dispatcher/result/${id}`).send({
      token: TOKEN,
      success: true,
      data: {
        supplier: 'ООО Поставщик',
        invoice_number: 'СФ-555',
        total_sum: 300,
        items: [
          { name: 'Молоко', quantity: 2, unit: 'шт', price: 100, total: 200 },
          { name: 'Хлеб', quantity: 1, unit: 'шт', price: 100, total: 100 },
        ],
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('processed');
    const inv = await getInvoice(id);
    expect(inv?.status).toBe('processed');
    expect(await itemCount(id)).toBe(2);
    expect(inv?.total_sum).toBe(300);
    expect(inv?.items_total_mismatch).toBe(0);
  });

  it('flags items_total_mismatch when Σitems diverges from total_sum >1%', async () => {
    const id = await createPending();
    const res = await request(app).post(`/api/dispatcher/result/${id}`).send({
      token: TOKEN,
      success: true,
      data: {
        supplier: 'ООО Поставщик',
        invoice_number: 'СФ-777',
        total_sum: 1000, // claimed
        items: [{ name: 'Сахар', quantity: 1, unit: 'шт', price: 200, total: 200 }], // actual 200
      },
    });
    expect(res.status).toBe(200);
    const inv = await getInvoice(id);
    expect(inv?.items_total_mismatch).toBe(1);
    expect(inv?.total_sum).toBe(1000); // keeps document total, just flags
  });

  it('merges a page-2 (same supplier, no number) into the recent page-1', async () => {
    const page1 = await createProcessedPage1('ООО Ромашка', 'НК-42');
    const page2 = await createPending({ supplier: null, number: null });

    const res = await request(app).post(`/api/dispatcher/result/${page2}`).send({
      token: TOKEN,
      success: true,
      data: {
        supplier: 'ООО Ромашка',   // same supplier
        invoice_number: null,       // page-2 has no number → strategy C
        total_sum: 250,             // total only on last page
        items: [{ name: 'Товар Б', quantity: 3, unit: 'шт', price: 50, total: 150 }],
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('merged');
    expect(res.body.targetInvoiceId).toBe(page1);

    // page-2 becomes a duplicate, no items of its own
    const p2 = await getInvoice(page2);
    expect(p2?.status).toBe('duplicate');
    expect(await itemCount(page2)).toBe(0);

    // page-1 now holds both items and the recalculated total
    expect(await itemCount(page1)).toBe(2);
    const p1 = await getInvoice(page1);
    expect(p1?.total_sum).toBe(250);          // backfilled from page-2
    expect(p1?.items_total_mismatch).toBe(0); // 100 (page1) + 150 (page2) == 250 → no mismatch
  });

  it('marks invoice as error and keeps no items on success=false', async () => {
    const id = await createPending();
    const res = await request(app).post(`/api/dispatcher/result/${id}`).send({ token: TOKEN, success: false, error: 'не распознал' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('error');
    const inv = await getInvoice(id);
    expect(inv?.status).toBe('error');
    expect(await itemCount(id)).toBe(0);
  });
});
