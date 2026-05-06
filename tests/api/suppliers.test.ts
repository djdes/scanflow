import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { resetDb } from '../helpers/db';
import { supplierRepo } from '../../src/database/repositories/supplierRepo';

vi.mock('../../src/sber/dadata', () => ({
  lookupPartyByInn: vi.fn(),
  DadataNotConfiguredError: class extends Error {
    constructor() { super('DADATA_API_KEY not configured'); this.name = 'DadataNotConfiguredError'; }
  },
}));

import suppliersRouter from '../../src/api/routes/suppliers';
import { lookupPartyByInn, DadataNotConfiguredError } from '../../src/sber/dadata';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/suppliers', suppliersRouter);
  return app;
}

describe('suppliers routes', () => {
  beforeEach(() => {
    resetDb();
    vi.mocked(lookupPartyByInn).mockReset();
  });

  it('POST creates supplier', async () => {
    const res = await request(makeApp())
      .post('/api/suppliers')
      .send({
        inn: '5012089824', name: 'ООО Тест', kpp: '501201001',
        bank_bic: '044525225', account: '40702810000000000001',
        bank_corr_account: '30101810400000000225',
      });
    expect(res.status).toBe(201);
    expect(supplierRepo.findByInn('5012089824')?.verified).toBe(1);
  });

  it('POST rejects invalid INN', async () => {
    const res = await request(makeApp()).post('/api/suppliers').send({ inn: '123', name: 'X', bank_bic: '044525225' });
    expect(res.status).toBe(400);
  });

  it('GET lists suppliers', async () => {
    supplierRepo.create({ inn: '5012089824', name: 'A', bank_bic: '044525225' });
    supplierRepo.create({ inn: '7707083893', name: 'B', bank_bic: '044525225' });
    const res = await request(makeApp()).get('/api/suppliers');
    expect(res.body.suppliers.length).toBe(2);
  });

  it('GET /:inn returns one', async () => {
    supplierRepo.create({ inn: '5012089824', name: 'A', bank_bic: '044525225' });
    const res = await request(makeApp()).get('/api/suppliers/5012089824');
    expect(res.body.supplier.name).toBe('A');
  });

  it('GET /:inn 404 when missing', async () => {
    const res = await request(makeApp()).get('/api/suppliers/9999999999');
    expect(res.status).toBe(404);
  });

  it('PATCH updates fields', async () => {
    supplierRepo.create({ inn: '5012089824', name: 'A', bank_bic: '044525225' });
    const res = await request(makeApp()).patch('/api/suppliers/5012089824').send({ name: 'B' });
    expect(res.status).toBe(200);
    expect(supplierRepo.findByInn('5012089824')?.name).toBe('B');
  });

  it('DELETE removes', async () => {
    supplierRepo.create({ inn: '5012089824', name: 'A', bank_bic: '044525225' });
    const res = await request(makeApp()).delete('/api/suppliers/5012089824');
    expect(res.status).toBe(200);
    expect(supplierRepo.findByInn('5012089824')).toBeNull();
  });

  it('POST /lookup-dadata happy path', async () => {
    vi.mocked(lookupPartyByInn).mockResolvedValue({
      name: 'ООО X', inn: '5012089824', kpp: '501201001', address: 'Москва',
    });
    const res = await request(makeApp()).post('/api/suppliers/lookup-dadata').send({ inn: '5012089824' });
    expect(res.body.party.name).toBe('ООО X');
  });

  it('POST /lookup-dadata 503 when not configured', async () => {
    vi.mocked(lookupPartyByInn).mockRejectedValue(new DadataNotConfiguredError());
    const res = await request(makeApp()).post('/api/suppliers/lookup-dadata').send({ inn: '5012089824' });
    expect(res.status).toBe(503);
  });
});
