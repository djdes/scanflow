import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';
vi.mock('../../src/watcher/fileWatcher', () => ({ FileWatcher: class {
    } }));
vi.mock('../../src/mapping/nomenclatureMapper', () => ({ NomenclatureMapper: class {
    } }));
vi.mock('../../src/services/invoiceSourceLocator', () => ({ locateSource: vi.fn(), sourceImage: vi.fn().mockResolvedValue(Buffer.from('jpeg')) }));
import { locateSource } from '../../src/services/invoiceSourceLocator';
import { createServer } from '../../src/api/server';
import { FileWatcher } from '../../src/watcher/fileWatcher';
import { NomenclatureMapper } from '../../src/mapping/nomenclatureMapper';
const app = createServer(new FileWatcher() as never, new NomenclatureMapper() as never);
const api = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, key = 'rv1') => request(app)[method]('/api/invoices' + url).set('X-API-Key', key);
async function seed(owner = 1, date = '2026-10-02', name = 'Молоко') {
    const invoice = await invoiceRepo.create({ file_name: 'review.jpg', file_path: '/review.jpg', invoice_number: '1048', invoice_date: date, supplier: 'Ферма', supplier_inn: '7830002293', total_sum: 150, owner_user_id: owner });
    const id = invoice.id;
    await getDb().prepare("UPDATE invoices SET status='processed' WHERE id=?").run(id);
    const item = await invoiceRepo.addItem({ invoice_id: id, original_name: name, quantity: 2, unit: 'шт', price: 75, total: 150, vat_rate: 20, onec_guid: 'milk', mapping_confidence: 1 });
    return { id, item: item.id };
}
describe.runIf((process.env.DB_NAME || '').includes('test'))('production invoice review', () => {
    beforeEach(async () => { await resetDb(); vi.mocked(locateSource).mockReset(); await getDb().prepare("INSERT INTO users (id,username,password_hash,api_key,role) VALUES (1,'review1','x','rv1','user'),(2,'review2','x','rv2','admin')").run(); });
    afterAll(closeTestDb);
    it('retains source anchors when their items move into a merged document', async () => {
        const source = await seed(), target = await seed();
        const region = { filename: 'review.jpg', target_key: `item:${source.item}:row`, x: .1, y: .2, width: .8, height: .05 };
        expect((await api('put', `/${source.id}/review/region`).send(region)).status).toBe(200);
        await invoiceRepo.moveItemsToInvoice(source.id, target.id);
        await invoiceRepo.delete(source.id);
        expect((await api('get', `/${target.id}/review`)).body.data.regions).toEqual(expect.arrayContaining([expect.objectContaining({ target_key: region.target_key, filename: 'review.jpg' })]));
    });
    it('invalidates header verification and detects stale header edits', async () => {
        const { id } = await seed();
        await invoiceRepo.setAllAttrsChecked(id, true);
        const patch = { field: 'total_sum', expected: 150, value: 160 };
        expect((await api('patch', `/${id}/review/edit`).send(patch)).status).toBe(200);
        expect(await invoiceRepo.getById(id)).toMatchObject({ total_sum: 160, attr_checked_total: 0, attr_checked_number: 1, items_total_mismatch: 1 });
        expect((await api('patch', `/${id}/review/edit`).send(patch)).status).toBe(409);
    });
    it('discards locator output if rows were replaced while the job was running', async () => {
        const { id, item } = await seed();
        let finish!: (regions: import('../../src/services/invoiceReview').SourceRegion[]) => void;
        vi.mocked(locateSource).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
        expect((await api('post', `/${id}/review/locate`).send({ filename: 'review.jpg', target_key: `item:${item}:row` })).status).toBe(202);
        while (!finish) await new Promise(resolve => setTimeout(resolve, 5));
        await getDb().prepare('DELETE FROM invoice_items WHERE id = ?').run(item);
        finish([{ filename: 'review.jpg', target_key: `item:${item}:row`, x: .1, y: .2, width: .8, height: .05, origin: 'ai' }]);
        let state;
        for (let i = 0; i < 40; i++) {
            state = (await api('get', `/${id}/review`)).body.data;
            if (state.job.status !== 'running') break;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(state.job.status).toBe('error');
        expect(state.regions).toHaveLength(0);
        expect((await getDb().prepare('SELECT COUNT(*) AS n FROM invoice_source_regions WHERE invoice_id = ?').get<{ n: number }>(id))?.n).toBe(0);
    });
    it('selects next unresolved document in company and supports exclusion without marking checked', async () => {
        const a = await seed(), b = await seed();
        await seed(2);
        await invoiceRepo.setAllAttrsChecked(a.id, true);
        expect((await api('get', '/review/next')).body.data.id).toBe(b.id);
        expect((await api('get', `/review/next?exclude=${b.id}`)).body.data).toBeNull();
        expect((await api('get', '/review/next?exclude=1,evil')).status).toBe(400);
        expect((await invoiceRepo.getById(b.id))?.attr_checked_total).toBe(0);
    });
    it('isolates every review surface, even from another administrator', async () => {
        const { id } = await seed();
        for (const path of [`/${id}/review`, `/${id}/review/compare`, `/${id}/review/image/review.jpg`])
            expect((await api('get', path, 'rv2')).status).toBe(404);
        for (const [method, suffix] of [['patch', 'edit'], ['put', 'region'], ['post', 'locate']] as const)
            expect((await api(method, `/${id}/review/${suffix}`, 'rv2').send({})).status).toBe(404);
    });
    it('validates coordinates, target and filename and persists manual anchors', async () => {
        const { id, item } = await seed();
        const region = { filename: 'review.jpg', target_key: `item:${item}:price`, x: .1, y: .2, width: .3, height: .05, printed_text: '75,00' };
        const put = () => api('put', `/${id}/review/region`);
        expect((await put().send({ ...region, x: -1 })).status).toBe(400);
        expect((await put().send({ ...region, width: 2 })).status).toBe(400);
        expect((await put().send({ ...region, filename: '../secret.jpg' })).status).toBe(400);
        expect((await put().send({ ...region, target_key: 'item:99999:price' })).status).toBe(400);
        expect((await put().send({ ...region, origin: 'ai' })).body.data[0]).toMatchObject({ origin: 'manual', printed_text: '75,00' });
        expect((await api('get', `/${id}/review/image/review.jpg?key=rv1`)).status).toBe(200);
        expect((await request(app).get(`/api/invoices/${id}/review/image/review.jpg?key=rv1`)).status).toBe(200);
        expect((await request(app).get(`/api/invoices/${id}/review?key=rv1`)).status).toBe(401);
        await getDb().prepare('DELETE FROM invoice_items WHERE id=?').run(item);
        expect((await api('get', `/${id}/review`)).body.data.regions).toHaveLength(0);
    });
    it('edits atomically, recalculates the row, preserves document total/raw values, resets checks and audits', async () => {
        const { id, item } = await seed();
        await invoiceRepo.setAllAttrsChecked(id, true);
        const row = await invoiceRepo.getItemById(item);
        const result = await api('patch', `/${id}/review/edit`).send({ item_id: item, field: 'price', expected: 75, expected_row: row, value: 80 });
        expect(result.status).toBe(200);
        const after = await invoiceRepo.getItemById(item), inv = await invoiceRepo.getById(id);
        expect(after).toMatchObject({ price: 80, total: 160, raw_price: 75 });
        expect(inv).toMatchObject({ total_sum: 150, attr_checked_total: 0, attr_checked_vat: 0, attr_checked_number: 1, items_total_mismatch: 1 });
        const logs = await getDb().prepare("SELECT field,old_value,new_value FROM edit_log WHERE invoice_id=? AND context LIKE '%photo_review%'").all(id);
        expect(logs).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'price', old_value: '75', new_value: '80' }), expect.objectContaining({ field: 'total', new_value: '160' })]));
        expect((await api('patch', `/${id}/review/edit`).send({ item_id: item, field: 'price', expected: 75, expected_row: row, value: 90 })).status).toBe(409);
        const fresh = await invoiceRepo.getItemById(item);
        await getDb().prepare('UPDATE invoice_items SET quantity=3 WHERE id=?').run(item);
        expect((await api('patch', `/${id}/review/edit`).send({ item_id: item, field: 'price', expected: 80, expected_row: fresh, value: 90 })).status).toBe(409);
    });
    it('rejects edits to queued/sent/paid documents and refuses malformed values', async () => {
        const { id } = await seed();
        const patch = (value: unknown) => api('patch', `/${id}/review/edit`).send({ field: 'total_sum', value, expected: 150 });
        expect((await patch(-1)).status).toBe(400);
        expect((await api('patch', `/${id}/review/edit`).send({ field: 'status', value: 'sent_to_1c', expected: 'processed' })).status).toBe(400);
        expect((await api('patch', `/${id}/review/edit`).send({ field: 'invoice_date', value: '2026-02-30', expected: '2026-10-02' })).status).toBe(400);
        await getDb().prepare('UPDATE invoices SET approved_for_1c=1 WHERE id=?').run(id);
        expect((await patch(170)).status).toBe(409);
        await getDb().prepare("UPDATE invoices SET approved_for_1c=0,status='sent_to_1c' WHERE id=?").run(id);
        expect((await patch(170)).status).toBe(409);
        await getDb().prepare("UPDATE invoices SET status='processed',paid_externally=1 WHERE id=?").run(id);
        expect((await patch(170)).status).toBe(409);
        await getDb().prepare('UPDATE invoices SET paid_externally=0 WHERE id=?').run(id);
        await getDb().prepare("INSERT INTO sber_payments (invoice_id,external_id,status,payment_purpose,amount,payer_account,payee_inn) VALUES (?,'review-pay','created','Оплата',150,'a','7830002293')").run(id);
        expect((await patch(170)).status).toBe(409);
    });
    it('compares only earlier supplies of the same company and supplier', async () => {
        const old = await seed(1, '2026-09-20'), now = await seed(1, '2026-10-02');
        await seed(2, '2026-09-30');
        await seed(1, '2026-10-03');
        await getDb().prepare('UPDATE invoice_items SET price=60,total=120 WHERE id=?').run(old.item);
        const result = await api('get', `/${now.id}/review/compare`);
        expect(result.status).toBe(200);
        expect(result.body.data.previous.id).toBe(old.id);
        expect(result.body.data.rows[0]).toMatchObject({ comparable: true, price_change_pct: 25, match: 'guid' });
    });
    it('never overwrites manually bound regions with AI suggestions', async () => {
        const { id, item } = await seed();
        const region = { filename: 'review.jpg', target_key: `item:${item}:row`, x: .1, y: .2, width: .8, height: .05, origin: 'manual' as const };
        await api('put', `/${id}/review/region`).send(region);
        vi.mocked(locateSource).mockResolvedValue([{ ...region, x: .05, origin: 'ai' }]);
        expect((await api('post', `/${id}/review/locate`).send({ filename: 'review.jpg', target_key: `item:${item}:row` })).status).toBe(202);
        let state;
        for (let i = 0; i < 30; i++) {
            state = (await api('get', `/${id}/review`)).body.data;
            if (state.job.status !== 'running')
                break;
            await new Promise(r => setTimeout(r, 10));
        }
        expect(state.job.status).toBe('done');
        expect(state.regions[0]).toMatchObject({ x: .1, origin: 'manual' });
    });
});
