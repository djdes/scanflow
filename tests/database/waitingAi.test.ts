import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';

// Накладные, ждавшие GPT (waiting_ai), распознаются часы спустя. Соседние страницы
// ищутся в окне от их created_at (anchor), а не от NOW(); зачистка «зависших»
// такие накладные не трогает.
describe.runIf((process.env.DB_NAME || '').includes('test'))('waiting_ai: окно соседних страниц и статус', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  async function mk(over: { number?: string | null; supplier?: string | null; status?: string; agoMin?: number; owner?: number | null } = {}): Promise<number> {
    const r = await getDb().prepare(
      `INSERT INTO invoices (file_name, file_path, status, invoice_number, supplier, owner_user_id, created_at)
       VALUES ('f.jpg', '/f.jpg', ?, ?, ?, ?, (NOW() - INTERVAL ? MINUTE))`
    ).run(over.status ?? 'processed', over.number ?? null, over.supplier ?? null, over.owner ?? null, over.agoMin ?? 0);
    return Number(r.lastInsertRowid);
  }
  async function createdAt(id: number): Promise<string> {
    const row = await getDb().prepare('SELECT created_at FROM invoices WHERE id = ?').get<{ created_at: string }>(id);
    return String(row?.created_at);
  }

  it('страницы, загруженные 3 часа назад с разницей в минуту: с anchor пара находится, без — нет', async () => {
    const first = await mk({ number: '424', supplier: 'ООО Ромашка', agoMin: 181 });
    const second = await mk({ number: '424', status: 'waiting_ai', agoMin: 180 });
    const anchor = await createdAt(second);
    expect((await invoiceRepo.findRecentByNumber('424', undefined, 10, null, anchor))?.id).toBe(first);
    expect(await invoiceRepo.findRecentByNumber('424', undefined, 10, null)).toBeUndefined();
    expect((await invoiceRepo.findRecentBySupplier('ООО Ромашка', second, 5, null, anchor))?.id).toBe(first);
    expect((await invoiceRepo.findMostRecentProcessedForContinuation(second, 2, null, anchor))?.id).toBe(first);
  });

  it('окно с anchor ограничено с обеих сторон: загруженное позже, чем через окно, не цепляется', async () => {
    const waiting = await mk({ status: 'waiting_ai', agoMin: 180 });
    await mk({ number: '424', supplier: 'ООО Ромашка', agoMin: 30 }); // загружено через 2,5 часа
    const anchor = await createdAt(waiting);
    expect(await invoiceRepo.findMostRecentProcessedForContinuation(waiting, 2, null, anchor)).toBeUndefined();
    expect(await invoiceRepo.findRecentByNumber('424', undefined, 10, null, anchor)).toBeUndefined();
  });

  it('markStaleAsFailed не трогает waiting_ai; markWaitingAi / listWaitingAiIds / countWaitingAi', async () => {
    const owner = Number((await getDb().prepare(
      `INSERT INTO users (username, password_hash, api_key, role, notify_events) VALUES ('u', 'x', 'k-u', 'user', '[]')`,
    ).run()).lastInsertRowid);
    const stuck = await mk({ status: 'ocr_processing', agoMin: 60 });
    const a = await mk({ status: 'ocr_processing', agoMin: 60, owner });
    const b = await mk({ status: 'new', agoMin: 1 });
    await invoiceRepo.markWaitingAi(a, 'Лимит подписки ChatGPT до 18:40 МСК', '/data/processed/a.jpg');
    await invoiceRepo.markWaitingAi(b, 'ChatGPT просит войти заново');

    await invoiceRepo.markStaleAsFailed(5);
    const status = async (id: number) => (await invoiceRepo.getById(id))?.status;
    expect(await status(stuck)).toBe('error');
    expect(await status(a)).toBe('waiting_ai');
    expect(await status(b)).toBe('waiting_ai');
    expect((await invoiceRepo.getById(a))?.file_path).toBe('/data/processed/a.jpg');
    expect((await invoiceRepo.getById(a))?.error_message).toContain('Лимит подписки');

    expect(await invoiceRepo.listWaitingAiIds()).toEqual([a, b]);
    expect(await invoiceRepo.countWaitingAi(null)).toBe(2);
    expect(await invoiceRepo.countWaitingAi(owner)).toBe(1);

    await invoiceRepo.clearErrorMessage(a);
    expect((await invoiceRepo.getById(a))?.error_message).toBeNull();
  });
});
