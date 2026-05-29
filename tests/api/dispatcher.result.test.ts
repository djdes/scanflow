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

    // page-2 becomes a duplicate LINKED to page-1, no items of its own
    const p2 = await getInvoice(page2);
    expect(p2?.status).toBe('duplicate');
    expect(p2?.duplicate_of).toBe(page1);
    expect(await itemCount(page2)).toBe(0);

    // page-1 now holds both items and the recalculated total
    expect(await itemCount(page1)).toBe(2);
    const p1 = await getInvoice(page1);
    expect(p1?.total_sum).toBe(250);          // backfilled from page-2
    expect(p1?.items_total_mismatch).toBe(0); // 100 (page1) + 150 (page2) == 250 → no mismatch
  });

  // Seed a processed page that already has N items with row_no 1..N.
  async function seedHeadPage(opts: { n: number; supplier: string; number: string | null; date?: string | null; minutesAgo?: number }): Promise<number> {
    const ageExpr = opts.minutesAgo ? `NOW() - INTERVAL ${Math.floor(opts.minutesAgo)} MINUTE` : 'NOW()';
    const r = await getDb().prepare(
      `INSERT INTO invoices (file_name, file_path, status, supplier, invoice_number, invoice_date, total_sum, created_at)
       VALUES ('head.jpg','/t/head.jpg','processed', ?, ?, ?, ?, ${ageExpr})`
    ).run(opts.supplier, opts.number, opts.date ?? null, opts.n * 100);
    const id = Number(r.lastInsertRowid);
    for (let i = 1; i <= opts.n; i++) {
      await getDb().prepare(
        `INSERT INTO invoice_items (invoice_id, original_name, quantity, unit, price, total, mapping_confidence, row_no)
         VALUES (?, ?, 1, 'шт', 100, 100, 0, ?)`
      ).run(id, `Товар ${i}`, i);
    }
    return id;
  }

  it('row_no merge (forward): a page whose item is row #17 joins the page with rows 1-16', async () => {
    const head = await seedHeadPage({ n: 16, supplier: 'АО "ОПТИКОМ"', number: '1/236334', date: '2026-05-26' });

    // Continuation page calls back: a single item with row_no 17, no number.
    const tail = await createPending();
    const res = await request(app).post(`/api/dispatcher/result/${tail}`).send({
      token: TOKEN,
      success: true,
      data: {
        supplier: 'АО "ОПТИКОМ"',
        invoice_number: null,
        items: [{ name: 'Анчоусы', quantity: 6, unit: 'шт', price: 170, total: 1020, row_no: 17 }],
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('merged');
    expect(res.body.targetInvoiceId).toBe(head); // head canonical (has number+date)
    expect((await getInvoice(tail))?.duplicate_of).toBe(head);
    expect(await itemCount(head)).toBe(17); // 16 + the row-17 item
  });

  it('row_no merge (reverse): header with rows 1-16 reclaims a row-17 orphan that finalised first', async () => {
    // The row-17 continuation called back FIRST and finalised standalone.
    const orphanR = await getDb().prepare(
      `INSERT INTO invoices (file_name, file_path, status, supplier, invoice_number, total_sum)
       VALUES ('p2.jpg','/t/p2.jpg','processed','АО "ОПТИКОМ"', NULL, 1020)`
    ).run();
    const orphan = Number(orphanR.lastInsertRowid);
    await getDb().prepare(
      `INSERT INTO invoice_items (invoice_id, original_name, quantity, unit, price, total, mapping_confidence, row_no)
       VALUES (?, 'Анчоусы', 6, 'шт', 170, 1020, 0, 17)`
    ).run(orphan);

    // Now the header page (rows 1-16, with number) calls back.
    const header = await createPending();
    const items = Array.from({ length: 16 }, (_, i) => ({ name: `Товар ${i + 1}`, quantity: 1, unit: 'шт', price: 100, total: 100, row_no: i + 1 }));
    const res = await request(app).post(`/api/dispatcher/result/${header}`).send({
      token: TOKEN,
      success: true,
      data: { supplier: 'АО "ОПТИКОМ"', invoice_number: '1/236334', invoice_date: '2026-05-26', total_sum: 1600, items },
    });

    expect(res.status).toBe(200);
    expect((await getInvoice(orphan))?.status).toBe('duplicate');
    expect((await getInvoice(orphan))?.duplicate_of).toBe(header);
    expect(await itemCount(header)).toBe(17); // 16 + reclaimed row-17
  });

  it('upload-time proximity: merges a sibling uploaded 20 min ago (OCR latency), not just NOW-5min', async () => {
    // Sibling was uploaded 20 min ago — outside any NOW()-5min window, but the
    // current page shares its upload batch (created_at proximity).
    const head = await seedHeadPage({ n: 16, supplier: 'АО "ОПТИКОМ"', number: '1/236334', date: '2026-05-26', minutesAgo: 20 });

    const tail = await createPending();
    // make the tail's created_at line up with the old sibling's upload time
    await getDb().prepare(`UPDATE invoices SET created_at = NOW() - INTERVAL 20 MINUTE WHERE id = ?`).run(tail);

    const res = await request(app).post(`/api/dispatcher/result/${tail}`).send({
      token: TOKEN,
      success: true,
      data: { supplier: 'АО "ОПТИКОМ"', invoice_number: null, items: [{ name: 'Анчоусы', quantity: 6, unit: 'шт', price: 170, total: 1020, row_no: 17 }] },
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('merged');
    expect(res.body.targetInvoiceId).toBe(head);
    expect(await itemCount(head)).toBe(17);
  });

  it('cumulative-total merge: links pages with DIFFERENT OCR numbers via grand total', async () => {
    // Page 1 already processed: number 17-0315110, 2 items summing to 82261.77.
    const p1R = await getDb().prepare(
      `INSERT INTO invoices (file_name, file_path, status, supplier, invoice_number, invoice_date, total_sum)
       VALUES ('p1.jpg','/t/p1.jpg','processed','ООО "Свит Лайф"','17-0315110','2026-05-26', 82261.77)`
    ).run();
    const p1 = Number(p1R.lastInsertRowid);
    await getDb().prepare(
      `INSERT INTO invoice_items (invoice_id, original_name, quantity, unit, price, total, mapping_confidence)
       VALUES (?, 'Навага', 1, 'кг', 80261.77, 80261.77, 0), (?, 'Камбала', 1, 'кг', 2000, 2000, 0)`
    ).run(p1, p1);

    // Page 2 callback: DIFFERENT number 17-0315111, 1 item (1024.5), grand total 83286.27.
    const p2 = await createPending();
    const res = await request(app).post(`/api/dispatcher/result/${p2}`).send({
      token: TOKEN,
      success: true,
      data: {
        supplier: 'ООО "Свит Лайф"',
        invoice_number: '17-0315111',
        total_sum: 83286.27, // = 82261.77 + 1024.50 (cumulative)
        items: [{ name: 'Анчоусы', quantity: 6, unit: 'шт', price: 170.75, total: 1024.5 }],
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('merged');
    expect(res.body.targetInvoiceId).toBe(p1); // p1 canonical (has date)

    const page2 = await getInvoice(p2);
    expect(page2?.status).toBe('duplicate');
    expect(page2?.duplicate_of).toBe(p1);

    expect(await itemCount(p1)).toBe(3);
    const h = await getInvoice(p1);
    expect(h?.total_sum).toBe(83286.27);
    expect(h?.items_total_mismatch).toBe(0); // 80261.77+2000+1024.5 == 83286.27
  });

  it('does NOT merge two genuinely separate same-supplier invoices', async () => {
    // Two complete standalone invoices from the same supplier, each total ≈ own items.
    const aR = await getDb().prepare(
      `INSERT INTO invoices (file_name, file_path, status, supplier, invoice_number, invoice_date, total_sum)
       VALUES ('a.jpg','/t/a.jpg','processed','ООО "Свит Лайф"','17-0315110','2026-05-26', 5000)`
    ).run();
    const a = Number(aR.lastInsertRowid);
    await getDb().prepare(
      `INSERT INTO invoice_items (invoice_id, original_name, quantity, unit, price, total, mapping_confidence)
       VALUES (?, 'Товар A', 1, 'кг', 5000, 5000, 0)`
    ).run(a);

    const b = await createPending();
    const res = await request(app).post(`/api/dispatcher/result/${b}`).send({
      token: TOKEN,
      success: true,
      data: {
        supplier: 'ООО "Свит Лайф"',
        invoice_number: '17-0315111', // sequential but a DIFFERENT real invoice
        total_sum: 3000,
        items: [{ name: 'Товар B', quantity: 1, unit: 'кг', price: 3000, total: 3000 }],
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('processed'); // NOT merged
    expect(res.body.targetInvoiceId).toBe(b);
    expect((await getInvoice(a))?.status).toBe('processed');
    expect((await getInvoice(b))?.status).toBe('processed');
    expect((await getInvoice(b))?.duplicate_of).toBeNull();
    expect(await itemCount(a)).toBe(1);
    expect(await itemCount(b)).toBe(1);
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
