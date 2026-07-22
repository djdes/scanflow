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
  const defaultEvents = JSON.stringify(['photo_uploaded', 'invoice_recognized', 'recognition_error']);
  await getDb().prepare(
    `INSERT INTO users (id, username, password_hash, api_key, role, notify_events) VALUES (1, 'admin', 'x', 'k', 'admin', ?)`
  ).run(defaultEvents);
  return 'k';
}

async function createInvoice(date: string): Promise<number> {
  // Владелец обязателен: статистика цен и справочник пер-тенантные, и без него
  // накладная не найдёт ни медиану, ни карточку поставщика — как и на проде.
  const r = await getDb().prepare(
    `INSERT INTO invoices (file_name, file_path, status, invoice_date, owner_user_id) VALUES (?, ?, 'processed', ?, 1)`
  ).run(`f-${date}`, `/test/${date}`, date);
  return Number(r.lastInsertRowid);
}

async function addItem(
  invoiceId: number,
  opts: { price: number; unit: string; guid: string | null },
): Promise<void> {
  await getDb().prepare(
    `INSERT INTO invoice_items (invoice_id, original_name, quantity, unit, price, total, mapping_confidence, onec_guid)
     VALUES (?, 'x', 1, ?, ?, ?, 1, ?)`
  ).run(invoiceId, opts.unit, opts.price, opts.price, opts.guid);
}

// Skip in CI when DB_HOST is not set. Local dev: set DB_HOST=127.0.0.1 +
// DB_PASSWORD + DB_NAME=scanflow_test before running.
describe.runIf((process.env.DB_NAME || '').includes('test'))('GET /api/invoices/:id (price stats)', () => {
  const GUID = 'gid-flour';
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  it('returns median_price and price_deviation_pct when 3+ prior matched-unit samples exist', async () => {
    const key = await setupUser();
    for (const [i, p] of [90, 100, 110].entries()) {
      const inv = await createInvoice(`2026-01-0${i + 1}`);
      await addItem(inv, { price: p, unit: 'кг', guid: GUID });
    }

    const { backfillAllStats } = await import('../../src/pricing/priceStats');
    await backfillAllStats();

    const current = await createInvoice('2026-02-01');
    await addItem(current, { price: 200, unit: 'кг', guid: GUID });

    const res = await request(app).get(`/api/invoices/${current}`).set('X-API-Key', key);
    expect(res.status).toBe(200);
    const item = res.body.data.items[0];
    expect(item.median_price).toBe(100);
    expect(item.median_price_unit).toBe('кг');
    expect(item.median_samples).toBeGreaterThanOrEqual(3);
    expect(item.price_deviation_pct).toBe(100);
  });

  it('returns null deviation when samples < 3', async () => {
    const key = await setupUser();
    for (const [i, p] of [90, 110].entries()) {
      const inv = await createInvoice(`2026-01-0${i + 1}`);
      await addItem(inv, { price: p, unit: 'кг', guid: GUID });
    }
    const { backfillAllStats } = await import('../../src/pricing/priceStats');
    await backfillAllStats();

    const current = await createInvoice('2026-02-01');
    await addItem(current, { price: 200, unit: 'кг', guid: GUID });

    const res = await request(app).get(`/api/invoices/${current}`).set('X-API-Key', key);
    expect(res.status).toBe(200);
    const item = res.body.data.items[0];
    expect(item.median_price).toBeNull();
    expect(item.price_deviation_pct).toBeNull();
  });

  it('returns median but null deviation when item.unit differs from median_price_unit', async () => {
    const key = await setupUser();
    for (const [i, p] of [90, 100, 110].entries()) {
      const inv = await createInvoice(`2026-01-0${i + 1}`);
      await addItem(inv, { price: p, unit: 'кг', guid: GUID });
    }
    const { backfillAllStats } = await import('../../src/pricing/priceStats');
    await backfillAllStats();

    const current = await createInvoice('2026-02-01');
    await addItem(current, { price: 200, unit: 'шт', guid: GUID });

    const res = await request(app).get(`/api/invoices/${current}`).set('X-API-Key', key);
    expect(res.status).toBe(200);
    const item = res.body.data.items[0];
    expect(item.median_price).toBe(100);
    expect(item.median_price_unit).toBe('кг');
    expect(item.price_deviation_pct).toBeNull();
  });

  it('returns null for items without onec_guid', async () => {
    const key = await setupUser();
    const inv = await createInvoice('2026-02-01');
    await addItem(inv, { price: 200, unit: 'кг', guid: null });

    const res = await request(app).get(`/api/invoices/${inv}`).set('X-API-Key', key);
    expect(res.status).toBe(200);
    const item = res.body.data.items[0];
    expect(item.median_price).toBeNull();
    expect(item.price_deviation_pct).toBeNull();
  });
});
