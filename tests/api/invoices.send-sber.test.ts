import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { resetDb } from '../helpers/db';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';
import { supplierRepo } from '../../src/database/repositories/supplierRepo';
import { sberTokenRepo } from '../../src/database/repositories/sberTokenRepo';
import { sberPaymentRepo } from '../../src/database/repositories/sberPaymentRepo';

vi.mock('../../src/sber/oauth', () => ({
  getValidAccessToken: vi.fn().mockResolvedValue('TOKEN'),
}));
vi.mock('../../src/sber/payments', async () => {
  const actual = await vi.importActual<typeof import('../../src/sber/payments')>('../../src/sber/payments');
  return { ...actual, createPaymentOrder: vi.fn() };
});

import invoicesRouter from '../../src/api/routes/invoices';
import { createPaymentOrder, SberApiError } from '../../src/sber/payments';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/invoices', invoicesRouter);
  return app;
}

function seedConnectedSber() {
  sberTokenRepo.upsert({
    access_token: 'a', refresh_token: 'r',
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    account_number: '40702810940000099835',
    org_name: 'ООО БФС',
    payer_inn: '7707083893',
    payer_kpp: '770701001',
    payer_bank_bic: '044525225',
    payer_bank_corr_account: '30101810400000000225',
  });
}

function seedInvoice() {
  return invoiceRepo.create({
    file_name: 'a.jpg', file_path: '/a.jpg',
    invoice_number: 'НФНФ-001', invoice_date: '2026-05-06',
    supplier: 'ООО Свит', supplier_inn: '5012089824',
    total_sum: 1234.56, vat_sum: 205.76,
  });
}

function seedSupplier() {
  supplierRepo.create({
    inn: '5012089824', name: 'ООО Свит', kpp: '501201001',
    account: '40702810000000000001', bank_bic: '044525225',
    bank_corr_account: '30101810400000000225',
    verified: 1, source: 'manual',
  });
}

describe('POST /api/invoices/:id/send-sber', () => {
  beforeEach(() => {
    resetDb();
    vi.mocked(createPaymentOrder).mockReset();
  });

  it('happy path — supplier verified → 201 from Sber → row persisted', async () => {
    seedConnectedSber();
    const inv = seedInvoice();
    seedSupplier();
    vi.mocked(createPaymentOrder).mockResolvedValue({ externalId: 'X', number: '999', status: 'ACCEPTED' });
    const res = await request(makeApp()).post(`/api/invoices/${inv.id}/send-sber`).send({});
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.payment_number).toBe('999');
    const stored = sberPaymentRepo.findByInvoiceId(inv.id)!;
    expect(stored.status).toBe('created');
  });

  it('returns 409 needs_supplier_confirmation when supplier not in DB', async () => {
    seedConnectedSber();
    const inv = invoiceRepo.create({
      file_name: 'a.jpg', file_path: '/a.jpg',
      supplier: 'ООО Новый', supplier_inn: '7777777777',
      supplier_bik: '044525225',
      total_sum: 1000,
    });
    const res = await request(makeApp()).post(`/api/invoices/${inv.id}/send-sber`).send({});
    expect(res.status).toBe(409);
    expect(res.body.needs_supplier_confirmation).toBe(true);
    expect(res.body.prefilled).toMatchObject({ inn: '7777777777', bank_bic: '044525225' });
  });

  it('upserts supplier from supplier_overrides and proceeds', async () => {
    seedConnectedSber();
    const inv = seedInvoice();
    vi.mocked(createPaymentOrder).mockResolvedValue({ externalId: 'X', number: '999' });
    const res = await request(makeApp()).post(`/api/invoices/${inv.id}/send-sber`).send({
      supplier_overrides: {
        inn: '5012089824', name: 'ООО Свит', kpp: '501201001',
        bank_bic: '044525225', account: '40702810000000000001',
        bank_corr_account: '30101810400000000225',
      },
    });
    expect(res.status).toBe(200);
    expect(supplierRepo.findByInn('5012089824')?.verified).toBe(1);
  });

  it('returns 409 on duplicate send (UNIQUE invoice_id)', async () => {
    seedConnectedSber();
    const inv = seedInvoice();
    seedSupplier();
    vi.mocked(createPaymentOrder).mockResolvedValue({ externalId: 'X', number: '999' });
    await request(makeApp()).post(`/api/invoices/${inv.id}/send-sber`).send({});
    const res = await request(makeApp()).post(`/api/invoices/${inv.id}/send-sber`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already/i);
  });

  it('returns 502 on Sber 400 and persists failure', async () => {
    seedConnectedSber();
    const inv = seedInvoice();
    seedSupplier();
    vi.mocked(createPaymentOrder).mockRejectedValue(new SberApiError(400, '{"errors":[]}'));
    const res = await request(makeApp()).post(`/api/invoices/${inv.id}/send-sber`).send({});
    expect(res.status).toBe(502);
    expect(sberPaymentRepo.findByInvoiceId(inv.id)?.status).toBe('failed');
  });

  it('returns 400 when Sber not connected', async () => {
    const inv = seedInvoice();
    seedSupplier();
    const res = await request(makeApp()).post(`/api/invoices/${inv.id}/send-sber`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Sber not connected|payer/i);
  });

  it('returns 400 when invoice has no INN', async () => {
    seedConnectedSber();
    const inv = invoiceRepo.create({ file_name: 'a.jpg', file_path: '/a.jpg', total_sum: 100 });
    const res = await request(makeApp()).post(`/api/invoices/${inv.id}/send-sber`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/supplier_inn/);
  });
});

describe('GET /api/invoices/:id/sber-status', () => {
  beforeEach(() => resetDb());

  it('returns null when no payment', async () => {
    const inv = invoiceRepo.create({ file_name: 'a.jpg', file_path: '/a.jpg', total_sum: 100 });
    const res = await request(makeApp()).get(`/api/invoices/${inv.id}/sber-status`);
    expect(res.body.payment).toBeNull();
  });

  it('returns row when exists', async () => {
    const inv = invoiceRepo.create({ file_name: 'a.jpg', file_path: '/a.jpg', total_sum: 100 });
    sberPaymentRepo.create({
      invoice_id: inv.id, external_id: 'X', status: 'created',
      payment_purpose: 'p', amount: 100, payer_account: '40702', payee_inn: '5012',
    });
    const res = await request(makeApp()).get(`/api/invoices/${inv.id}/sber-status`);
    expect(res.body.payment.status).toBe('created');
  });
});
