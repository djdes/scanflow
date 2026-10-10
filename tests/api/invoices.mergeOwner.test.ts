import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// БД-свободный тест: POST /:id/merge-into/:targetId. Охранник router.param
// проверяет владельца только у :id — у приёмника (:targetId) проверка своя.
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/database/db', () => ({
  getDb: () => { throw new Error('объединение ходит в БД только через invoiceRepo'); },
}));
vi.mock('../../src/watcher/fileWatcher', () => ({ FileWatcher: class {} }));
vi.mock('../../src/database/repositories/editLogRepo', () => ({ logEdit: vi.fn(), editLogRepo: {} }));
vi.mock('../../src/database/repositories/invoiceRepo', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/database/repositories/invoiceRepo')>();
  return {
    ...real,
    invoiceRepo: {
      getById: vi.fn(), moveItemsToInvoice: vi.fn(), appendFileName: vi.fn(), appendRawText: vi.fn(), recordMerge: vi.fn(),
      delete: vi.fn(), updateInvoiceData: vi.fn(), recalculateTotal: vi.fn(), getWithItems: vi.fn(),
    },
  };
});

import invoicesRouter from '../../src/api/routes/invoices';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';

const repo = vi.mocked(invoiceRepo);
const invoices: Record<number, Record<string, unknown>> = {
  2: { id: 2, owner_user_id: 2, file_name: 'p2.jpg', total_sum: 100 },
  4: { id: 4, owner_user_id: 2, file_name: 'p1.jpg', total_sum: 300 },
  9: { id: 9, owner_user_id: 9, file_name: 'other.jpg', total_sum: 500 },
};

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.user = { id: 2, username: 'u', role: 'user' } as never; next(); });
  a.use('/api/invoices', invoicesRouter);
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  repo.getById.mockImplementation(async (id: number) => invoices[id] as never);
  repo.delete.mockResolvedValue({ file_name: 'p2.jpg' });
  repo.getWithItems.mockResolvedValue({ id: 4, items: [] } as never);
});

describe('POST /api/invoices/:id/merge-into/:targetId — владелец приёмника', () => {
  it('своя накладная в свою — объединяется', async () => {
    const res = await request(app()).post('/api/invoices/2/merge-into/4');
    expect(res.status).toBe(200);
    expect(repo.moveItemsToInvoice).toHaveBeenCalledWith(2, 4);
  });

  it('своя накладная в чужую → 404, ничего не двигается и не удаляется', async () => {
    const res = await request(app()).post('/api/invoices/2/merge-into/9');
    expect(res.status).toBe(404);
    expect(repo.moveItemsToInvoice).not.toHaveBeenCalled();
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it.each(['invoice_number', 'invoice_date', 'supplier_inn'])(
    'не объединяет документы с различающимся %s', async (field) => {
      const source = { ...invoices[2], [field]: field === 'invoice_date' ? '2026-01-01' : '123' };
      const target = { ...invoices[4], [field]: field === 'invoice_date' ? '2026-01-02' : '456' };
      repo.getById.mockImplementation(async (id: number) => (id === 2 ? source : target) as never);
      const res = await request(app()).post('/api/invoices/2/merge-into/4');
      expect(res.status).toBe(409);
      expect(repo.moveItemsToInvoice).not.toHaveBeenCalled();
      expect(repo.delete).not.toHaveBeenCalled();
    },
  );

  it('сохраняет исходное распознавание обеих страниц', async () => {
    repo.getById.mockImplementation(async (id: number) => ({ ...invoices[id], raw_text: id === 2 ? 'page-two-json' : 'page-one-json' }) as never);
    const res = await request(app()).post('/api/invoices/2/merge-into/4');
    expect(res.status).toBe(200);
    expect(repo.appendRawText).toHaveBeenCalledWith(4, 'page-two-json');
  });
});
