import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { recomputeMedianForGuid, recomputeMedianForGuids } from '../../src/pricing/priceStats';

const GUID = 'aaaa-bbbb-cccc-dddd';

async function insertInvoice(date: string): Promise<number> {
  const r = await getDb().prepare(
    `INSERT INTO invoices (file_name, file_path, status, invoice_date) VALUES (?, ?, 'processed', ?)`,
  ).run(`f-${date}`, `/test/${date}`, date);
  return Number(r.lastInsertRowid);
}

async function insertItem(
  invoiceId: number,
  opts: { price: number; unit?: string; guid?: string | null } = { price: 0 },
): Promise<void> {
  await getDb().prepare(
    `INSERT INTO invoice_items (invoice_id, original_name, quantity, unit, price, total, mapping_confidence, onec_guid)
     VALUES (?, 'test', 1, ?, ?, ?, 1, ?)`,
  ).run(
    invoiceId,
    opts.unit ?? 'кг',
    opts.price,
    opts.price,
    opts.guid === undefined ? GUID : opts.guid,
  );
}

async function getStats(guid: string) {
  return getDb()
    .prepare('SELECT * FROM nomenclature_price_stats WHERE onec_guid = ?')
    .get<{ onec_guid: string; median_price: number; price_unit: string; samples: number }>(guid);
}

describe('recomputeMedianForGuid', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  it('writes nothing when fewer than 3 samples exist', async () => {
    const inv = await insertInvoice('2026-01-01');
    await insertItem(inv, { price: 100 });
    await insertItem(inv, { price: 110 });

    const result = await recomputeMedianForGuid(GUID);
    expect(result).toBeNull();
    expect(await getStats(GUID)).toBeUndefined();
  });

  it('computes median of last 10 prices (odd N)', async () => {
    for (const [i, price] of [10, 20, 30, 40, 50].entries()) {
      const inv = await insertInvoice(`2026-01-0${i + 1}`);
      await insertItem(inv, { price });
    }
    const result = await recomputeMedianForGuid(GUID);
    expect(result).not.toBeNull();
    expect(result!.median_price).toBe(30);
    expect(result!.samples).toBe(5);
    expect(result!.price_unit).toBe('кг');

    const row = await getStats(GUID);
    expect(row!.median_price).toBe(30);
  });

  it('computes mean of two middle values for even N', async () => {
    for (const [i, price] of [10, 20, 30, 40].entries()) {
      const inv = await insertInvoice(`2026-01-0${i + 1}`);
      await insertItem(inv, { price });
    }
    const result = await recomputeMedianForGuid(GUID);
    expect(result!.median_price).toBe(25);
    expect(result!.samples).toBe(4);
  });

  it('uses the majority unit when units diverge', async () => {
    for (const [i, price] of [10, 20, 30, 40].entries()) {
      const inv = await insertInvoice(`2026-01-0${i + 1}`);
      await insertItem(inv, { price, unit: 'кг' });
    }
    for (const [i, price] of [100, 200, 300].entries()) {
      const inv = await insertInvoice(`2026-02-0${i + 1}`);
      await insertItem(inv, { price, unit: 'шт' });
    }
    const result = await recomputeMedianForGuid(GUID);
    expect(result!.price_unit).toBe('кг');
    expect(result!.samples).toBe(4);
    expect(result!.median_price).toBe(25);
  });

  it('tie-breaks on unit by choosing the most recent', async () => {
    for (const [i, price] of [10, 20, 30].entries()) {
      const inv = await insertInvoice(`2026-01-0${i + 1}`);
      await insertItem(inv, { price, unit: 'кг' });
    }
    for (const [i, price] of [100, 200, 300].entries()) {
      const inv = await insertInvoice(`2026-02-0${i + 1}`);
      await insertItem(inv, { price, unit: 'шт' });
    }
    const result = await recomputeMedianForGuid(GUID);
    expect(result!.price_unit).toBe('шт');
    expect(result!.samples).toBe(3);
  });

  it('takes the 10 most recent invoices, ignores older ones', async () => {
    for (let i = 1; i <= 11; i++) {
      const inv = await insertInvoice(`2026-${String(i).padStart(2, '0')}-01`);
      await insertItem(inv, { price: i });
    }
    const result = await recomputeMedianForGuid(GUID);
    expect(result!.samples).toBe(10);
    expect(result!.median_price).toBe(6.5);
  });

  it('filters out price == 0', async () => {
    const dates = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04'];
    const prices = [0, 10, 20, 30];
    for (let i = 0; i < dates.length; i++) {
      const inv = await insertInvoice(dates[i]);
      await insertItem(inv, { price: prices[i] });
    }
    const result = await recomputeMedianForGuid(GUID);
    expect(result!.samples).toBe(3);
    expect(result!.median_price).toBe(20);
  });

  it('does not duplicate rows when called repeatedly (UPSERT)', async () => {
    for (const [i, price] of [10, 20, 30].entries()) {
      const inv = await insertInvoice(`2026-01-0${i + 1}`);
      await insertItem(inv, { price });
    }
    await recomputeMedianForGuid(GUID);
    await recomputeMedianForGuid(GUID);
    await recomputeMedianForGuid(GUID);

    const row = await getDb()
      .prepare('SELECT COUNT(*) AS c FROM nomenclature_price_stats WHERE onec_guid = ?')
      .get<{ c: number }>(GUID);
    expect(row!.c).toBe(1);
  });

  it('deletes the row when invoices vanish (samples falls below 3)', async () => {
    for (const [i, price] of [10, 20, 30].entries()) {
      const inv = await insertInvoice(`2026-01-0${i + 1}`);
      await insertItem(inv, { price });
    }
    await recomputeMedianForGuid(GUID);
    expect(await getStats(GUID)).not.toBeUndefined();

    await getDb().prepare('DELETE FROM invoice_items WHERE onec_guid = ?').run(GUID);
    const result = await recomputeMedianForGuid(GUID);
    expect(result).toBeNull();
    expect(await getStats(GUID)).toBeUndefined();
  });
});

describe('recomputeMedianForGuids (batch)', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  it('processes multiple GUIDs and skips null/empty entries', async () => {
    const G1 = 'guid-1';
    const G2 = 'guid-2';
    for (const [i, price] of [10, 20, 30].entries()) {
      const inv = await insertInvoice(`2026-01-0${i + 1}`);
      await insertItem(inv, { price, guid: G1 });
      await insertItem(inv, { price: price * 2, guid: G2 });
    }
    // null/empty deliberately passed to confirm the runtime filter (TS would normally reject).
    await recomputeMedianForGuids([G1, G2, null as unknown as string, '']);
    expect((await getStats(G1))!.median_price).toBe(20);
    expect((await getStats(G2))!.median_price).toBe(40);
  });
});
