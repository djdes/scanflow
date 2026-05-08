import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { resetDb } from '../helpers/db';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';
import invoicesRouter from '../../src/api/routes/invoices';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/invoices', invoicesRouter);
  return app;
}

describe('PATCH /api/invoices/:id — header edit', () => {
  beforeEach(() => resetDb());

  it('updates a subset of fields', async () => {
    const inv = invoiceRepo.create({
      file_name: 'a.jpg', file_path: '/a.jpg',
      invoice_number: 'OLD', supplier: 'OLD CO',
    });
    const res = await request(makeApp())
      .patch(`/api/invoices/${inv.id}`)
      .send({ invoice_number: '661', supplier: 'ИП Кнутова А.С.' });
    expect(res.status).toBe(200);
    const reloaded = invoiceRepo.getById(inv.id)!;
    expect(reloaded.invoice_number).toBe('661');
    expect(reloaded.supplier).toBe('ИП Кнутова А.С.');
  });

  it('trims strings and treats empty as null', async () => {
    const inv = invoiceRepo.create({
      file_name: 'a.jpg', file_path: '/a.jpg',
      supplier_kpp: '501801001',
    });
    const res = await request(makeApp())
      .patch(`/api/invoices/${inv.id}`)
      .send({ supplier_kpp: '', supplier: '  ООО Тест  ' });
    expect(res.status).toBe(200);
    const reloaded = invoiceRepo.getById(inv.id)!;
    expect(reloaded.supplier_kpp).toBeNull();
    expect(reloaded.supplier).toBe('ООО Тест');
  });

  it('rejects invalid INN', async () => {
    const inv = invoiceRepo.create({ file_name: 'a.jpg', file_path: '/a.jpg' });
    const res = await request(makeApp())
      .patch(`/api/invoices/${inv.id}`)
      .send({ supplier_inn: '123' });
    expect(res.status).toBe(400);
  });

  it('rejects invalid BIK', async () => {
    const inv = invoiceRepo.create({ file_name: 'a.jpg', file_path: '/a.jpg' });
    const res = await request(makeApp())
      .patch(`/api/invoices/${inv.id}`)
      .send({ supplier_bik: '12' });
    expect(res.status).toBe(400);
  });

  it('rejects invalid date', async () => {
    const inv = invoiceRepo.create({ file_name: 'a.jpg', file_path: '/a.jpg' });
    const res = await request(makeApp())
      .patch(`/api/invoices/${inv.id}`)
      .send({ invoice_date: '08.05.2026' });
    expect(res.status).toBe(400);
  });

  it('accepts null to clear a field', async () => {
    const inv = invoiceRepo.create({
      file_name: 'a.jpg', file_path: '/a.jpg', supplier_kpp: '501801001',
    });
    const res = await request(makeApp())
      .patch(`/api/invoices/${inv.id}`)
      .send({ supplier_kpp: null });
    expect(res.status).toBe(200);
    expect(invoiceRepo.getById(inv.id)!.supplier_kpp).toBeNull();
  });

  it('updates total_sum and vat_sum', async () => {
    const inv = invoiceRepo.create({
      file_name: 'a.jpg', file_path: '/a.jpg',
    });
    const res = await request(makeApp())
      .patch(`/api/invoices/${inv.id}`)
      .send({ total_sum: '13730.00', vat_sum: 0 });
    expect(res.status).toBe(200);
    const reloaded = invoiceRepo.getById(inv.id)!;
    expect(reloaded.total_sum).toBe(13730);
    expect(reloaded.vat_sum).toBe(0);
  });

  it('400 when body has no editable fields', async () => {
    const inv = invoiceRepo.create({ file_name: 'a.jpg', file_path: '/a.jpg' });
    const res = await request(makeApp())
      .patch(`/api/invoices/${inv.id}`)
      .send({ random_field: 'x' });
    expect(res.status).toBe(400);
  });

  it('404 on unknown id', async () => {
    const res = await request(makeApp())
      .patch('/api/invoices/99999')
      .send({ supplier: 'X' });
    expect(res.status).toBe(404);
  });
});
