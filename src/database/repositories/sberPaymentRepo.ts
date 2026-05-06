import { getDb } from '../db';

export interface SberPayment {
  id: number;
  invoice_id: number;
  external_id: string;
  status: string;
  payment_purpose: string;
  amount: number;
  payer_account: string;
  payee_inn: string;
  request_payload: string | null;
  response_body: string | null;
  sber_payment_number: string | null;
  error_message: string | null;
  created_at: string;
}

export interface CreateSberPaymentInput {
  invoice_id: number;
  external_id: string;
  status: string;
  payment_purpose: string;
  amount: number;
  payer_account: string;
  payee_inn: string;
  request_payload?: string | null;
}

export const sberPaymentRepo = {
  findByInvoiceId(invoiceId: number): SberPayment | null {
    const row = getDb().prepare('SELECT * FROM sber_payments WHERE invoice_id = ?').get(invoiceId) as SberPayment | undefined;
    return row ?? null;
  },

  create(input: CreateSberPaymentInput): SberPayment {
    getDb().prepare(`
      INSERT INTO sber_payments (invoice_id, external_id, status, payment_purpose, amount, payer_account, payee_inn, request_payload)
      VALUES (@invoice_id, @external_id, @status, @payment_purpose, @amount, @payer_account, @payee_inn, @request_payload)
    `).run({
      ...input,
      request_payload: input.request_payload ?? null,
    });
    return this.findByInvoiceId(input.invoice_id)!;
  },

  updateStatus(invoiceId: number, patch: { status: string; sber_payment_number?: string | null; response_body?: string | null; error_message?: string | null }): void {
    const sets: string[] = ['status = ?'];
    const vals: unknown[] = [patch.status];
    if (patch.sber_payment_number !== undefined) { sets.push('sber_payment_number = ?'); vals.push(patch.sber_payment_number); }
    if (patch.response_body !== undefined) { sets.push('response_body = ?'); vals.push(patch.response_body); }
    if (patch.error_message !== undefined) { sets.push('error_message = ?'); vals.push(patch.error_message); }
    vals.push(invoiceId);
    getDb().prepare(`UPDATE sber_payments SET ${sets.join(', ')} WHERE invoice_id = ?`).run(...vals);
  },

  listRecent(limit = 50): SberPayment[] {
    return getDb().prepare('SELECT * FROM sber_payments ORDER BY created_at DESC LIMIT ?').all(limit) as SberPayment[];
  },

  deleteByInvoiceId(invoiceId: number): void {
    getDb().prepare('DELETE FROM sber_payments WHERE invoice_id = ?').run(invoiceId);
  },
};
