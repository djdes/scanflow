import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';
import { userRepo } from '../../src/database/repositories/userRepo';
vi.mock('../../src/watcher/fileWatcher', () => ({ FileWatcher: class {} }));
vi.mock('../../src/mapping/nomenclatureMapper', () => ({ NomenclatureMapper: class {} }));
import { createServer } from '../../src/api/server';
const app = createServer({} as never, {} as never);
const title = 'Этикетка самоклеящаяся 60x120 (рядов 1 по 2 000шт) белая в рулоне';
const endpoint = (invoice: number, item: number, action: string) => `/api/unit-cost/invoices/${invoice}/items/${item}/${action}`;
const get = (url: string, key = 'cost-owner') => request(app).get(url).set('X-API-Key', key);
const post = (url: string, body: unknown, key = 'cost-owner') => request(app).post(url).set('X-API-Key', key).send(body);
describe.runIf((process.env.DB_NAME || '').includes('test'))('формулы расходной единицы', () => {
  beforeEach(async () => {
    await resetDb();
    await getDb().prepare("DELETE FROM edit_log WHERE field = 'unit_cost_formula'").run();
    await userRepo.create({ username: 'cost-owner', password_hash: 'x', api_key: 'cost-owner' });
    await userRepo.create({ username: 'cost-other', password_hash: 'x', api_key: 'cost-other', role: 'admin' });
  });
  afterAll(closeTestDb);
  async function seed(options: { name?: string; owner?: number; supplier?: string; rawUnit?: string } = {}) {
    const inv = await invoiceRepo.create({ file_name: 'label.jpg', file_path: '/label.jpg', invoice_number: '1213',
      supplier: 'Магма', supplier_inn: options.supplier ?? '7830002293', total_sum: 53550, owner_user_id: options.owner ?? 1 });
    await invoiceRepo.updateStatus(inv.id, 'processed');
    const item = await invoiceRepo.addItem({ invoice_id: inv.id, original_name: options.name ?? title,
      quantity: 30, unit: options.rawUnit ?? 'шт', price: 1785, total: 53550 });
    return { invoice: inv.id, item: item.id };
  }
  async function state(ids: { invoice: number; item: number }) {
    const response = await get(`/api/invoices/${ids.invoice}`);
    expect(response.status).toBe(200);
    return response.body.data.items.find((item: any) => item.id === ids.item).unit_cost;
  }
  const formula = { units_per_pack: 2000, unit_kind: 'label' };
  it('предлагает расчёт для существующей накладной и уведомление со ссылкой на её строку', async () => {
    const ids = await seed();
    expect(await state(ids)).toMatchObject({ calculation: { total_units: 60000, unit_price: 0.8925 }, rule_id: null });
    const feed = await get('/api/unit-cost/suggestions');
    expect(feed.status).toBe(200);
    expect(feed.body.data).toHaveLength(1);
    expect(feed.body.data[0]).toMatchObject({ invoice_id: ids.invoice, item_id: ids.item, original_name: title });
    expect((await getDb().prepare('SELECT COUNT(*) AS n FROM item_cost_rules').get<{ n: number }>())!.n).toBe(0);
  });
  it('запоминает только по подтверждению, применяет к новой поставке, сохраняет деньги и оставляет аудит', async () => {
    const ids = await seed();
    const before = await invoiceRepo.getItemById(ids.item);
    const result = await post(endpoint(ids.invoice, ids.item, 'remember'), { ...formula, expected: (await state(ids)).expected });
    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({ calculation: { source: 'rule', unit_price: 0.8925 } });
    expect(await invoiceRepo.getItemById(ids.item)).toEqual(before);
    expect((await get('/api/unit-cost/suggestions')).body.data).toHaveLength(0);
    const next = await seed();
    await invoiceRepo.updateItemFields(next.item, { total: 60000 });
    expect(await state(next)).toMatchObject({ calculation: { source: 'rule', unit_price: 1, total_units: 60000 } });
    expect((await get('/api/unit-cost/suggestions')).body.data.map((row: any) => row.item_id)).toEqual([next.item]);
    const logs = await getDb().prepare("SELECT * FROM edit_log WHERE item_id = ? AND field = 'unit_cost_formula'").all(ids.item);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ owner_user_id: 1, user_id: 1 });
  });
  it('ручной расчёт поддерживает неизвестную фасовку и после запоминания попадает в уведомления новых поставок', async () => {
    const ids = await seed({ name: 'Терморулон без фасовки' });
    expect((await state(ids)).calculation).toBe(null);
    const preview = await post(endpoint(ids.invoice, ids.item, 'preview'), { ...formula, units_per_pack: 1500 });
    expect(preview.status).toBe(200);
    expect(preview.body.data.calculation).toMatchObject({ source: 'manual', total_units: 45000, unit_price: 1.19 });
    expect((await state(ids)).rule_id).toBe(null);
    expect((await post(endpoint(ids.invoice, ids.item, 'remember'), { ...formula, units_per_pack: 1500, expected: preview.body.data.expected })).status).toBe(200);
    const next = await seed({ name: 'Терморулон без фасовки' });
    expect((await state(next)).calculation.units_per_pack).toBe(1500);
    expect((await get('/api/unit-cost/suggestions')).body.data[0].item_id).toBe(next.item);
  });
  it('изолирует компании, поставщиков, размеры и исходные единицы', async () => {
    const ids = await seed();
    await post(endpoint(ids.invoice, ids.item, 'remember'), { ...formula, units_per_pack: 1500, expected: (await state(ids)).expected });
    const supplier = await seed({ supplier: '7812345678' });
    const otherSize = await seed({ name: title.replace('60x120', '58x40') });
    const otherUnit = await seed({ rawUnit: 'рулон' });
    for (const candidate of [supplier, otherSize, otherUnit]) expect((await state(candidate)).rule_id).toBe(null);
    await seed({ owner: 2 });
    expect((await get('/api/unit-cost/suggestions', 'cost-other')).body.data).toHaveLength(1);
    expect((await post(endpoint(ids.invoice, ids.item, 'remember'), { ...formula, expected: (await state(ids)).expected }, 'cost-other')).status).toBe(404);
    expect((await request(app).get('/api/unit-cost/suggestions')).status).toBe(401);
  });
  it('скрывает только конкретное уведомление, повторно показывает изменённый расчёт и позволяет забыть правило', async () => {
    const ids = await seed();
    const original = await state(ids);
    expect((await post(endpoint(ids.invoice, ids.item, 'dismiss'), { expected: original.expected })).status).toBe(200);
    expect((await get('/api/unit-cost/suggestions')).body.data).toHaveLength(0);
    await invoiceRepo.updateItemFields(ids.item, { total: 60000 });
    expect((await get('/api/unit-cost/suggestions')).body.data).toHaveLength(1);
    const remember = await post(endpoint(ids.invoice, ids.item, 'remember'), { ...formula, expected: (await state(ids)).expected });
    const forgotten = await post(endpoint(ids.invoice, ids.item, 'forget'), { expected: remember.body.data.expected });
    expect(forgotten.status).toBe(200);
    expect((await state(ids)).rule_id).toBe(null);
    expect((await get('/api/unit-cost/suggestions')).body.data).toHaveLength(1);
  });
  it('проверяет изменённую строку и изменённую другим пользователем формулу', async () => {
    const a = await seed(), b = await seed();
    const oldA = await state(a), oldB = await state(b);
    await invoiceRepo.updateItemFields(a.item, { total: 60000 });
    expect((await post(endpoint(a.invoice, a.item, 'remember'), { ...formula, expected: oldA.expected })).status).toBe(409);
    await post(endpoint(a.invoice, a.item, 'remember'), { ...formula, expected: (await state(a)).expected });
    expect((await post(endpoint(b.invoice, b.item, 'remember'), { ...formula, units_per_pack: 1500, expected: oldB.expected })).status).toBe(409);
  });
  it('проверяет коэффициенты, пару накладная/строка и cursor', async () => {
    const a = await seed(), b = await seed(), current = await state(a);
    for (const units_per_pack of [0, -1, 2.5, '2000', 1e10])
      expect((await post(endpoint(a.invoice, a.item, 'remember'), { ...formula, units_per_pack, expected: current.expected })).status).toBe(400);
    expect((await post(endpoint(a.invoice, a.item, 'remember'), { ...formula, unit_kind: 'javascript', expected: current.expected })).status).toBe(400);
    expect((await post(endpoint(a.invoice, b.item, 'preview'), formula)).status).toBe(404);
    expect((await get('/api/unit-cost/suggestions?cursor=-1')).status).toBe(400);
  });
  it('расчёт доступен после отправки/оплаты, а дубликаты не создают уведомлений', async () => {
    const ids = await seed();
    await getDb().prepare("UPDATE invoices SET status = 'sent_to_1c', paid_externally = 1 WHERE id = ?").run(ids.invoice);
    expect((await post(endpoint(ids.invoice, ids.item, 'remember'), { ...formula, expected: (await state(ids)).expected })).status).toBe(200);
    const duplicate = await seed();
    await getDb().prepare('UPDATE invoices SET duplicate_of = ? WHERE id = ?').run(ids.invoice, duplicate.invoice);
    expect((await get('/api/unit-cost/suggestions')).body.data).toHaveLength(0);
  });
});
