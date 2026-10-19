import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';
import { userRepo } from '../../src/database/repositories/userRepo';
import { quantityReviewToken } from '../../src/services/itemQuantityConfirmation';
import { decision } from '../../src/services/invoiceReview';
import { evaluateInvoiceQuality } from '../../src/automation/qualityGate';
vi.mock('../../src/watcher/fileWatcher', () => ({ FileWatcher: class {} }));
vi.mock('../../src/mapping/nomenclatureMapper', () => ({ NomenclatureMapper: class {} }));
import { createServer } from '../../src/api/server';
const app = createServer({} as never, {} as never);
const path = (invoice: number, item: number) => `/api/invoices/${invoice}/items/${item}/quantity-confirmation`;

describe.runIf((process.env.DB_NAME || '').includes('test'))('row quantity confirmation', () => {
  beforeEach(async () => {
    await resetDb();
    await getDb().prepare("DELETE FROM edit_log WHERE context LIKE '%quantity_review%'").run();
    await userRepo.create({ username: 'quantity-owner', password_hash: 'x', api_key: 'quantity-owner' });
    await userRepo.create({ username: 'quantity-other', password_hash: 'x', api_key: 'quantity-other', role: 'admin' });
  });
  afterAll(closeTestDb);
  async function seed() {
    const inv = await invoiceRepo.create({ file_name: 'label.jpg', file_path: '/label.jpg', invoice_number: '105', invoice_date: '2026-10-20',
      supplier: 'Поставщик этикеток', supplier_inn: '7830002293', total_sum: 9000, owner_user_id: 1 });
    await invoiceRepo.updateStatus(inv.id, 'processed');
    const item = await invoiceRepo.addItem({ invoice_id: inv.id, original_name: 'Термоэтикетка', onec_guid: 'label', mapping_confidence: 1,
      quantity: 100, unit: 'шт', price: 90, total: 9000, row_no: 1,
      conversion: { raw_quantity: 100, raw_unit: 'шт', raw_price: 90, raw_total: 9000, conv_source: 'unresolved', conv_factor: null,
        conv_note: null, qty_flag: 'needs_weight', qty_flag_note: 'Укажите вес' } });
    return { invoice: inv.id, item: item.id };
  }
  async function confirm(ids: { invoice: number; item: number }, changes: Record<string, unknown> = {}, key = 'quantity-owner') {
    const item = (await invoiceRepo.getItemById(ids.item))!;
    return request(app).post(path(ids.invoice, ids.item)).set('X-API-Key', key)
      .send({ expected: quantityReviewToken(item), confirmed: true, quantity: item.quantity, unit: item.unit, ...changes });
  }
  it('confirms piece goods, persists the check, retains source warnings and audits without learning a rule', async () => {
    const ids = await seed();
    const response = await confirm(ids);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ qty_confirmed: 1, qty_confirmed_by: 1, quantity: 100, unit: 'шт', price: 90, total: 9000,
      raw_quantity: 100, raw_unit: 'шт', qty_flag: 'needs_weight' });
    expect(response.body.data.qty_confirmed_at).toBeTruthy();
    const fresh = await request(app).get(`/api/invoices/${ids.invoice}`).set('X-API-Key', 'quantity-owner');
    expect(fresh.body.data.items[0]).toMatchObject({ qty_confirmed: 1, qty_review_token: response.body.data.qty_review_token });
    expect(fresh.body.data.review_reason).not.toBe('quantity');
    expect(decision((await invoiceRepo.getWithItems(ids.invoice))!).quantity).toEqual([]);
    expect((await evaluateInvoiceQuality(ids.invoice)).reasons.some(reason => reason.code === 'unit_suspect')).toBe(false);
    const logs = await getDb().prepare("SELECT * FROM edit_log WHERE item_id = ? AND field = 'qty_confirmed'").all(ids.item);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ owner_user_id: 1, user_id: 1 });
    expect((await getDb().prepare('SELECT COUNT(*) AS n FROM item_unit_rules').get<{ n: number }>())?.n).toBe(0);
  });
  it('saves actual weight atomically, recalculates price and keeps document total and raw values', async () => {
    const ids = await seed();
    const response = await confirm(ids, { quantity: 2, unit: 'кг' });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ quantity: 2, unit: 'кг', price: 4500, total: 9000, raw_quantity: 100, raw_unit: 'шт', qty_confirmed: 1 });
    expect((await invoiceRepo.getById(ids.invoice))?.total_sum).toBe(9000);
  });
  it('revokes the check without altering numbers and restores the unresolved warning', async () => {
    const ids = await seed();
    await confirm(ids);
    expect((await confirm(ids, { confirmed: false })).status).toBe(200);
    expect(await invoiceRepo.getItemById(ids.item)).toMatchObject({ qty_confirmed: 0, qty_confirmed_at: null, qty_confirmed_by: null, quantity: 100, unit: 'шт' });
    expect(decision((await invoiceRepo.getWithItems(ids.invoice))!).quantity).toEqual([ids.item]);
  });
  it('rejects stale versions, invalid quantities, units and missing consent', async () => {
    const ids = await seed();
    const before = (await invoiceRepo.getItemById(ids.item))!;
    for (const changes of [{ quantity: 0 }, { quantity: -1 }, { quantity: '2' }, { quantity: 1e13 }, { unit: '' }, { unit: 'x'.repeat(33) }, { confirmed: 'true' }, { expected: '' }]) {
      expect((await confirm(ids, changes)).status).toBe(400);
    }
    await invoiceRepo.updateItemFields(ids.item, { price: 95 });
    const stale = await confirm(ids, { expected: quantityReviewToken(before) });
    expect(stale.status).toBe(409);
    expect((await invoiceRepo.getItemById(ids.item))?.qty_confirmed).toBe(0);
  });
  it('isolates owners, even administrators, and rejects wrong invoice/item pairs', async () => {
    const a = await seed(), b = await seed();
    expect((await confirm(a, {}, 'quantity-other')).status).toBe(404);
    expect((await confirm({ invoice: b.invoice, item: a.item })).status).toBe(404);
    expect((await request(app).post(path(a.invoice, a.item)).send({})).status).toBe(401);
  });
  it('refuses queued, sent and paid documents', async () => {
    const ids = await seed();
    for (const sql of ["approved_for_1c = 1", "approved_for_1c = 0, status = 'sent_to_1c'", "status = 'processed', paid_externally = 1"]) {
      await getDb().prepare(`UPDATE invoices SET ${sql} WHERE id = ?`).run(ids.invoice);
      expect((await confirm(ids)).status).toBe(409);
    }
  });
  it('preserves approval on the same catalog position and clears it after remapping or editing numbers', async () => {
    const ids = await seed();
    await confirm(ids);
    await invoiceRepo.updateItemMapping(ids.item, 'label', 'Этикетка', 1);
    expect((await invoiceRepo.getItemById(ids.item))?.qty_confirmed).toBe(1);
    await invoiceRepo.updateItemMapping(ids.item, 'other', 'Другая позиция', 1);
    expect((await invoiceRepo.getItemById(ids.item))?.qty_confirmed).toBe(0);
    await confirm(ids);
    await invoiceRepo.updateItemFields(ids.item, { quantity: 101 });
    expect(await invoiceRepo.getItemById(ids.item)).toMatchObject({ qty_confirmed: 0, qty_confirmed_at: null });
  });
});
