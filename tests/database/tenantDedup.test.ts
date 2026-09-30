import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { invoiceRepo, DuplicateFileHashError } from '../../src/database/repositories/invoiceRepo';
import { listCompanyHealth } from '../../src/services/companyHealth';

// Дубликаты по хешу файла, написание поставщика и «очередь» — в границах
// компании (правило 19, миграция 79). До исправления одинаковый файл второй
// компании возвращал накладную первой, а подбор написания и объединение
// поставщиков смотрели и меняли накладные всех компаний.
describe.runIf((process.env.DB_NAME || '').includes('test'))('изоляция компаний: дубликаты, поставщики, очередь', () => {
  let companyA = 0;
  let companyB = 0;

  async function makeUser(username: string): Promise<number> {
    const res = await getDb()
      .prepare(`INSERT INTO users (username, password_hash, api_key, role, notify_events) VALUES (?, 'x', ?, 'user', '[]')`)
      .run(username, `key-${username}`);
    return Number(res.lastInsertRowid);
  }

  async function mkInvoice(owner: number, p: { supplier?: string; inn?: string | null; status?: string; approved?: number; sent?: boolean; fileName?: string; total?: number } = {}): Promise<number> {
    const r = await getDb().prepare(
      `INSERT INTO invoices (file_name, file_path, supplier, supplier_inn, status, approved_for_1c, sent_at, owner_user_id, total_sum, created_at)
       VALUES (?, '/f', ?, ?, ?, ?, ?, ?, ?, NOW())`,
    ).run(p.fileName ?? 'f.jpg', p.supplier ?? null, p.inn ?? null, p.status ?? 'processed', p.approved ?? 0,
      p.sent ? new Date() : null, owner, p.total ?? 100);
    return Number(r.lastInsertRowid);
  }

  beforeEach(async () => {
    await resetDb();
    companyA = await makeUser('company-a');
    companyB = await makeUser('company-b');
  });
  afterAll(async () => { await closeTestDb(); });

  it('одинаковый файл второй компании — её собственная накладная, а не дубликат чужой', async () => {
    const hash = 'a'.repeat(64);
    const a = await invoiceRepo.create({ file_name: 'x.jpg', file_path: '/x', file_hash: hash, owner_user_id: companyA });
    expect((await invoiceRepo.findByFileHash(hash, companyB))).toBeUndefined();
    const b = await invoiceRepo.create({ file_name: 'x.jpg', file_path: '/x', file_hash: hash, owner_user_id: companyB });
    expect(b.id).not.toBe(a.id);
    expect((await invoiceRepo.findByFileHash(hash, companyB))?.id).toBe(b.id);
    // Внутри компании дубликат по-прежнему ловится на вставке.
    await expect(invoiceRepo.create({ file_name: 'y.jpg', file_path: '/y', file_hash: hash, owner_user_id: companyA }))
      .rejects.toBeInstanceOf(DuplicateFileHashError);
  });

  it('страница камеры ищется по шаблону имени только в своей компании', async () => {
    const a = await mkInvoice(companyA, { fileName: 'photo_1_1790000000000.jpg' });
    const pageB = await mkInvoice(companyB, { fileName: 'photo_2_1790000000000.jpg', status: 'ocr_processing' });
    expect(await invoiceRepo.findRecentByFileNamePattern('photo_%_1790000000000.jpg', pageB, 10, companyB)).toBeUndefined();
    expect((await invoiceRepo.findRecentByFileNamePattern('photo_%_1790000000000.jpg', pageB, 10, companyA))?.id).toBe(a);
  });

  it('написание поставщика и объединение написаний — только своей компании', async () => {
    await mkInvoice(companyA, { supplier: 'ООО "Ромашка Опт"', inn: '7701234567' });
    await mkInvoice(companyA, { supplier: 'ООО "Ромашка Опт"', inn: '7701234567' });
    const bId = await mkInvoice(companyB, { supplier: 'ООО Ромашка-Опт', inn: '7701234567' });
    // Для компании B «каноническое» написание — её собственное, не чужое.
    expect(await invoiceRepo.findCanonicalSupplier('ООО Ромашка Опт', '7701234567', companyB)).toBe('ООО Ромашка-Опт');
    expect(await invoiceRepo.findCanonicalSupplier('ООО Ромашка Опт', '7701234567', companyA)).toBe('ООО "Ромашка Опт"');
    expect((await invoiceRepo.distinctSuppliers(companyA)).map(s => s.supplier)).toEqual(['ООО "Ромашка Опт"']);
    // Переименование в компании A не трогает накладную компании B.
    expect(await invoiceRepo.renameSupplier(['ООО Ромашка-Опт'], 'ООО "Ромашка Опт"', companyA)).toBe(0);
    expect((await invoiceRepo.getById(bId))?.supplier).toBe('ООО Ромашка-Опт');
  });

  it('очередь в обзоре компаний — как на странице очереди: одобренные, но не отправленные, тоже в ней', async () => {
    await mkInvoice(companyA, { total: 100 });
    await mkInvoice(companyA, { approved: 1, total: 200 });
    await mkInvoice(companyA, { approved: 1, sent: true, total: 400 });
    const a = (await listCompanyHealth()).find(c => c.owner_user_id === companyA)!;
    expect(a.queue_count).toBe(2);
    expect(a.queue_sum).toBe(300);
  });
});
