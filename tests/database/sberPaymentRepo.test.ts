import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../helpers/db';
import { sberPaymentRepo } from '../../src/database/repositories/sberPaymentRepo';
import { getDb } from '../../src/database/db';

describe('sberPaymentRepo', () => {
  beforeEach(() => {
    resetDb();
    getDb().prepare(`INSERT INTO invoices (id, file_name, file_path, total_sum, status) VALUES (1, 'a.jpg', '/a.jpg', 100, 'processed')`).run();
  });

  it('create + findByInvoiceId roundtrip', () => {
    sberPaymentRepo.create({
      invoice_id: 1,
      external_id: 'uuid-1',
      status: 'pending',
      payment_purpose: 'Test',
      amount: 100,
      payer_account: '40702',
      payee_inn: '5012',
    });
    const row = sberPaymentRepo.findByInvoiceId(1)!;
    expect(row.external_id).toBe('uuid-1');
    expect(row.status).toBe('pending');
  });

  it('findByInvoiceId returns null when none', () => {
    expect(sberPaymentRepo.findByInvoiceId(999)).toBeNull();
  });

  it('UNIQUE invoice_id rejects duplicates', () => {
    sberPaymentRepo.create({ invoice_id: 1, external_id: 'a', status: 'pending', payment_purpose: 'p', amount: 1, payer_account: '1', payee_inn: '1' });
    expect(() => {
      sberPaymentRepo.create({ invoice_id: 1, external_id: 'b', status: 'pending', payment_purpose: 'p', amount: 1, payer_account: '1', payee_inn: '1' });
    }).toThrow(/UNIQUE/);
  });

  it('updateStatus flips fields', () => {
    sberPaymentRepo.create({ invoice_id: 1, external_id: 'a', status: 'pending', payment_purpose: 'p', amount: 1, payer_account: '1', payee_inn: '1' });
    sberPaymentRepo.updateStatus(1, {
      status: 'created',
      sber_payment_number: '123',
      response_body: '{"ok":true}',
    });
    const row = sberPaymentRepo.findByInvoiceId(1)!;
    expect(row.status).toBe('created');
    expect(row.sber_payment_number).toBe('123');
  });
});
