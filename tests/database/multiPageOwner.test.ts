import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';

// Страницы одной накладной — всегда одной компании (правило 19). Поиски
// «продолжения» многостраничной накладной не смотрели на владельца: страница
// без шапки одной компании могла приклеиться к накладной другой, обработанной
// в последние 2 минуты (нашёл агент B при работе над приёмом XML, 30.09.2026).
describe.runIf((process.env.DB_NAME || '').includes('test'))('поиск соседних страниц — только своя компания', () => {
  let companyA = 0;
  let companyB = 0;

  async function makeUser(username: string): Promise<number> {
    const res = await getDb()
      .prepare(`INSERT INTO users (username, password_hash, api_key, role, notify_events) VALUES (?, 'x', ?, 'user', '[]')`)
      .run(username, `key-${username}`);
    return Number(res.lastInsertRowid);
  }

  async function mkInvoice(owner: number, opts: { number?: string | null; date?: string | null; supplier?: string | null; status?: string } = {}): Promise<number> {
    const r = await getDb().prepare(
      `INSERT INTO invoices (file_name, file_path, invoice_number, invoice_date, supplier, status, owner_user_id, created_at)
       VALUES ('f', '/f', ?, ?, ?, ?, ?, NOW())`,
    ).run(opts.number ?? null, opts.date ?? null, opts.supplier ?? null, opts.status ?? 'processed', owner);
    return Number(r.lastInsertRowid);
  }

  beforeEach(async () => {
    await resetDb();
    companyA = await makeUser('company-a');
    companyB = await makeUser('company-b');
  });
  afterAll(async () => { await closeTestDb(); });

  it('страница без шапки не приклеивается к накладной другой компании', async () => {
    const a = await mkInvoice(companyA, { number: '1351', supplier: 'ИП Кнутова А. С.' });
    const page = await mkInvoice(companyB, { status: 'ocr_processing' });
    expect(await invoiceRepo.findMostRecentProcessedForContinuation(page, 2, companyB)).toBeUndefined();
    expect((await invoiceRepo.findMostRecentProcessedForContinuation(page, 2, companyA))?.id).toBe(a);
  });

  it('по номеру и по поставщику — только среди накладных своей компании', async () => {
    const a = await mkInvoice(companyA, { number: '1351', supplier: 'ИП Кнутова А. С.' });
    const page = await mkInvoice(companyB, { status: 'ocr_processing' });
    expect(await invoiceRepo.findRecentByNumber('1351', 'ИП Кнутова А. С.', 10, companyB)).toBeUndefined();
    expect((await invoiceRepo.findRecentByNumber('1351', 'ИП Кнутова А. С.', 10, companyA))?.id).toBe(a);
    expect(await invoiceRepo.findRecentBySupplier('ИП Кнутова А. С.', page, 5, companyB)).toBeUndefined();
    expect((await invoiceRepo.findRecentBySupplier('ИП Кнутова А. С.', page, 5, companyA))?.id).toBe(a);
  });

  it('ожидание ещё распознаваемых страниц — только своей компании', async () => {
    await mkInvoice(companyA, { status: 'ocr_processing' });
    const page = await mkInvoice(companyB, { status: 'ocr_processing' });
    expect(await invoiceRepo.countInFlightOlderThan(page, 5, companyB)).toBe(0);
    expect(await invoiceRepo.countInFlightOlderThan(page, 5, companyA)).toBe(1);
  });

  it('«возможные части этой накладной» в карточке — без чужих накладных', async () => {
    const own = await mkInvoice(companyB, { number: '17-0546560', date: '2026-09-08', supplier: 'СВИТ ЛАЙФ ФУДСЕРВИС' });
    await mkInvoice(companyA, { number: '17-0546560', date: '2026-09-08', supplier: 'СВИТ ЛАЙФ ФУДСЕРВИС' });
    const current = await mkInvoice(companyB, { number: '17-0546560', date: '2026-09-08', supplier: 'СВИТ ЛАЙФ ФУДСЕРВИС' });
    expect((await invoiceRepo.findSiblings(current)).map(s => s.id)).toEqual([own]);
  });

  it('части по одному ИНН находятся при полном имени и инициалах', async () => {
    const head = await mkInvoice(companyA, { number: 'TEST-510', supplier: 'ИП Иванов Иван Иванович' });
    const tail = await mkInvoice(companyA, { number: 'TEST-510', supplier: 'ИП Иванов И. И.' });
    await getDb().prepare("UPDATE invoices SET supplier_inn='123456789012' WHERE id IN (?,?)").run(head, tail);
    expect((await invoiceRepo.findSiblings(tail)).map(s => s.id)).toEqual([head]);
  });

  it('одно имя и номер с разными ИНН не предлагаются для склейки', async () => {
    const head = await mkInvoice(companyA, { number: 'TEST-510', supplier: 'ООО Тест' });
    const tail = await mkInvoice(companyA, { number: 'TEST-510', supplier: 'ООО Тест' });
    await getDb().prepare("UPDATE invoices SET supplier_inn='123456789012' WHERE id=?").run(head);
    await getDb().prepare("UPDATE invoices SET supplier_inn='123456789013' WHERE id=?").run(tail);
    expect(await invoiceRepo.findSiblings(tail)).toEqual([]);
  });
});
