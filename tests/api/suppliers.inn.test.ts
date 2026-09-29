import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Роутер справочника без базы: репозитории, сервис объединения и всё тяжёлое
// (OCR, диспетчер, DaData, уведомления) замоканы. Проверяем только то, что
// добавлено в п.18: контрольную сумму ИНН, inn_valid и «Объединить с…».
vi.mock('../../src/database/repositories/supplierRepo', () => ({
  supplierRepo: {
    list: vi.fn(), findByInn: vi.fn(), create: vi.fn(), mergeEmpty: vi.fn(), update: vi.fn(), delete: vi.fn(),
  },
}));
vi.mock('../../src/database/repositories/invoiceRepo', () => ({ invoiceRepo: { getAnalyzerConfig: vi.fn() } }));
vi.mock('../../src/database/repositories/supplierExtractJobRepo', () => ({ supplierExtractJobRepo: {} }));
vi.mock('../../src/sber/dadata', () => ({
  lookupPartyByInn: vi.fn(),
  DadataNotConfiguredError: class DadataNotConfiguredError extends Error {},
}));
vi.mock('../../src/ocr/claudeApiAnalyzer', () => ({ analyzeImageWithClaudeApi: vi.fn() }));
vi.mock('../../src/dispatcher/createTask', () => ({
  dispatchSupplierExtract: vi.fn(),
  DispatcherConfigError: class DispatcherConfigError extends Error {},
  DispatcherApiError: class DispatcherApiError extends Error {},
}));
vi.mock('../../src/notifications/events', () => ({ notifySupplierExtractError: vi.fn() }));
vi.mock('../../src/services/supplierMerge', () => ({
  mergeSupplierCards: vi.fn(),
  SupplierMergeError: class SupplierMergeError extends Error {
    constructor(public status: number, message: string) { super(message); }
  },
}));
vi.mock('../../src/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import suppliersRouter from '../../src/api/routes/suppliers';
import { supplierRepo } from '../../src/database/repositories/supplierRepo';
import { mergeSupplierCards, SupplierMergeError } from '../../src/services/supplierMerge';

const GOOD = '7724357632';
const TYPO = '7724357832';
const CHECKSUM_ERROR = 'ИНН не проходит проверку контрольной суммы — проверьте цифры';

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 1, username: 'u', role: 'user' } as never;
    next();
  });
  app.use('/api/suppliers', suppliersRouter);
  return app;
}

function row(inn: string, name = 'ООО "Вкусный мир ТК"') {
  return { id: 1, owner_user_id: 1, inn, name, bank_bic: '044525225', verified: 1 };
}

const body = (inn: string) => ({ inn, name: 'ООО "Вкусный мир ТК"', bank_bic: '044525225' });

describe('справочник поставщиков — контрольная сумма ИНН (п.18)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('POST / отклоняет ИНН с неверной контрольной суммой', async () => {
    const res = await request(makeApp()).post('/api/suppliers').send(body(TYPO));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(CHECKSUM_ERROR);
    expect(supplierRepo.create).not.toHaveBeenCalled();
  });

  it('POST / с верным ИНН создаёт карточку', async () => {
    vi.mocked(supplierRepo.findByInn).mockResolvedValue(null);
    vi.mocked(supplierRepo.create).mockResolvedValue(row(GOOD) as never);
    const res = await request(makeApp()).post('/api/suppliers').send(body(GOOD));
    expect(res.status).toBe(201);
    expect(supplierRepo.create).toHaveBeenCalledOnce();
  });

  it('POST /merge (реквизиты с фото) отклоняет ИНН с неверной контрольной суммой', async () => {
    const res = await request(makeApp()).post('/api/suppliers/merge').send(body(TYPO));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(CHECKSUM_ERROR);
    expect(supplierRepo.mergeEmpty).not.toHaveBeenCalled();
  });

  it('PATCH карточки с битым ИНН не блокируется (ИНН PATCH не меняет)', async () => {
    vi.mocked(supplierRepo.findByInn).mockResolvedValue(row(TYPO) as never);
    const res = await request(makeApp()).patch(`/api/suppliers/${TYPO}`).send({ notes: 'двойник' });
    expect(res.status).toBe(200);
    expect(supplierRepo.update).toHaveBeenCalledWith(TYPO, 1, { notes: 'двойник' });
  });

  it('GET / и GET /:inn отдают inn_valid', async () => {
    vi.mocked(supplierRepo.list).mockResolvedValue([row(GOOD), row(TYPO)] as never);
    const list = await request(makeApp()).get('/api/suppliers');
    expect(list.status).toBe(200);
    expect(list.body.suppliers.map((s: { inn: string; inn_valid: boolean }) => [s.inn, s.inn_valid]))
      .toEqual([[GOOD, true], [TYPO, false]]);

    vi.mocked(supplierRepo.findByInn).mockResolvedValue(row(TYPO) as never);
    const one = await request(makeApp()).get(`/api/suppliers/${TYPO}`);
    expect(one.body.supplier).toMatchObject({ inn: TYPO, inn_valid: false });
  });
});

describe('POST /api/suppliers/:inn/merge-into/:targetInn', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('вызывает объединение в рамках своей компании и отдаёт результат', async () => {
    const result = { moved_invoices: 3, moved_rules: 2, skipped_rules: 0, deleted_card: row(TYPO) };
    vi.mocked(mergeSupplierCards).mockResolvedValue(result as never);
    const res = await request(makeApp()).post(`/api/suppliers/${TYPO}/merge-into/${GOOD}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(result);
    expect(mergeSupplierCards).toHaveBeenCalledWith(1, TYPO, GOOD);
  });

  it('ошибки сервиса отдаются со своим статусом и текстом', async () => {
    vi.mocked(mergeSupplierCards).mockRejectedValue(new SupplierMergeError(404, 'Поставщик не найден'));
    const res = await request(makeApp()).post(`/api/suppliers/${TYPO}/merge-into/1234567890`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Поставщик не найден');
  });
});
