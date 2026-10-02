import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';

vi.mock('../../src/watcher/fileWatcher', () => ({ FileWatcher: class {} }));
vi.mock('../../src/mapping/nomenclatureMapper', () => ({ NomenclatureMapper: class {} }));
import { createServer } from '../../src/api/server';
import { FileWatcher } from '../../src/watcher/fileWatcher';
import { NomenclatureMapper } from '../../src/mapping/nomenclatureMapper';

const app = createServer(new FileWatcher() as never, new NomenclatureMapper() as never);

async function invoice(owner = 1, status = 'processed') {
  const r = await getDb().prepare(`INSERT INTO invoices
    (file_name, file_path, owner_user_id, status, invoice_number, invoice_date, supplier, supplier_inn, total_sum)
    VALUES ('demo.jpg', '/demo.jpg', ?, ?, '123', '2026-10-02', 'Поставщик', '7830002293', 1000)`)
    .run(owner, status);
  const id = Number(r.lastInsertRowid);
  await getDb().prepare(`INSERT INTO invoice_items
    (invoice_id, original_name, mapped_name, onec_guid, quantity, price, total, mapping_confidence)
    VALUES (?, 'Товар', 'Товар', 'guid-1', 1, 1000, 1000, 1)`).run(id);
  return id;
}

describe.runIf((process.env.DB_NAME || '').includes('test'))('invoice workflow list', () => {
  beforeEach(async () => {
    await resetDb();
    await getDb().prepare(`INSERT INTO users (id, username, password_hash, api_key, role)
      VALUES (1, 'workflow1', 'x', 'wk1', 'user'), (2, 'workflow2', 'x', 'wk2', 'user')`).run();
  });
  afterAll(closeTestDb);

  it('uses identical tenant-scoped predicates for tabs and summary, before pagination', async () => {
    const ready = await invoice();
    const missing = await invoice();
    await getDb().prepare('UPDATE invoices SET invoice_number = NULL WHERE id = ?').run(missing);
    const queue = await invoice();
    await getDb().prepare('UPDATE invoices SET approved_for_1c = 1 WHERE id = ?').run(queue);
    const error = await invoice(1, 'error');
    await invoice(2);
    await invoice(2, 'error');
    const stats = await request(app).get('/api/invoices/stats').set('X-API-Key', 'wk1');
    expect(stats.status).toBe(200);
    expect(stats.body.data.workflow).toMatchObject({ attention: 2, ready: 1, queue: 1, payment: 3 });
    const attention = await request(app).get('/api/invoices?view=attention&limit=1').set('X-API-Key', 'wk1');
    expect(attention.status).toBe(200);
    expect(attention.body.data).toHaveLength(1);
    expect(attention.body.total).toBe(2);
    expect([missing, error]).toContain(attention.body.data[0].id);
    const readyList = await request(app).get('/api/invoices?view=ready').set('X-API-Key', 'wk1');
    expect(readyList.body.data.map((x: { id: number }) => x.id)).toEqual([ready]);
    const queued = await request(app).get('/api/invoices?view=queue').set('X-API-Key', 'wk1');
    expect(queued.body.data.map((x: { id: number }) => x.id)).toEqual([queue]);
  });

  it('shows unresolved arithmetic, quantity and new-item warnings, and respects manual total verification', async () => {
    const id = await invoice();
    await getDb().prepare('UPDATE invoices SET items_total_mismatch = 1 WHERE id = ?').run(id);
    expect((await invoiceRepo.getAll(undefined, 50, 0, 1))[0].review_reason).toBe('total');
    await invoiceRepo.setAttrChecked(id, 'total', true);
    expect(await invoiceRepo.countList(undefined, 1, { view: 'ready' })).toBe(1);
    await getDb().prepare("UPDATE invoice_items SET qty_flag = 'suspect' WHERE invoice_id = ?").run(id);
    expect((await invoiceRepo.getAll(undefined, 50, 0, 1))[0].review_reason).toBe('quantity');
    await getDb().prepare('UPDATE invoice_items SET qty_flag = NULL, onec_guid = NULL WHERE invoice_id = ?').run(id);
    expect((await invoiceRepo.getAll(undefined, 50, 0, 1))[0].review_reason).toBe('mapping');
    await getDb().prepare('UPDATE invoices SET supplier_inn = NULL WHERE id = ?').run(id);
    expect((await invoiceRepo.getAll(undefined, 50, 0, 1))[0].review_reason).toBe('header');
  });

  it('separates bank drafts, completed payments and invoices without payment, excluding external payments', async () => {
    const draft = await invoice();
    const paid = await invoice();
    const missing = await invoice();
    const external = await invoice();
    await invoiceRepo.setPaidExternally(external, true);
    await getDb().prepare(`INSERT INTO sber_payments
      (invoice_id, external_id, status, bank_status, payment_purpose, amount, payer_account, payee_inn)
      VALUES (?, 'draft-1', 'created', 'CREATED', 'Оплата', 1000, 'account', '7830002293'),
             (?, 'paid-1', 'created', 'IMPLEMENTED', 'Оплата', 1000, 'account', '7830002293')`).run(draft, paid);
    const ids = async (filter: string) => {
      const res = await request(app).get(`/api/invoices?sber=${filter}`).set('X-API-Key', 'wk1');
      expect(res.status).toBe(200);
      return res.body.data.map((x: { id: number }) => x.id).sort((a: number, b: number) => a - b);
    };
    expect(await ids('draft')).toEqual([draft]);
    expect(await ids('settled')).toEqual([paid, external]);
    expect(await ids('missing')).toEqual([missing]);
    await getDb().prepare("UPDATE sber_payments SET bank_status = 'REFUSEDBYBANK' WHERE invoice_id = ?").run(draft);
    expect(await ids('failed')).toEqual([draft]);
    expect(await ids('missing')).toEqual([draft, missing]);
  });

  it('combines quick views with search and ignores unrecognized view input', async () => {
    const id = await invoice();
    await invoice();
    await getDb().prepare("UPDATE invoices SET invoice_number = 'unique-456' WHERE id = ?").run(id);
    const res = await request(app).get('/api/invoices?view=ready&q=unique-456').set('X-API-Key', 'wk1');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    const invalid = await request(app).get('/api/invoices?view=attention%27%20OR%201=1').set('X-API-Key', 'wk1');
    expect(invalid.status).toBe(200);
    expect(invalid.body.total).toBe(2);
  });

  it('keeps detected duplicates in attention and out of ready and payment queues', async () => {
    const id = await invoice(1, 'duplicate');
    const list = await invoiceRepo.getAll(undefined, 50, 0, 1, { view: 'attention' });
    expect(list.map(row => row.id)).toEqual([id]);
    expect(list[0].review_reason).toBe('duplicate');
    expect(await invoiceRepo.countList(undefined, 1, { view: 'ready' })).toBe(0);
    expect(await invoiceRepo.countList(undefined, 1, { view: 'payment' })).toBe(0);
  });
});
