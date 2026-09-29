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
  /** Миграция 74: статус документа в банке (IMPLEMENTED, REFUSEDBYBANK, …) и когда проверяли (UTC). */
  bank_status?: string | null;
  bank_status_at?: string | null;
  bank_comment?: string | null;
  status_checked_at?: string | null;
}

export interface PaymentToPoll {
  invoice_id: number;
  external_id: string;
  bank_status: string | null;
  owner_user_id: number;
  invoice_number: string | null;
  supplier: string | null;
  amount: number;
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
  async findByInvoiceId(invoiceId: number): Promise<SberPayment | null> {
    const row = await getDb()
      .prepare('SELECT * FROM sber_payments WHERE invoice_id = ?')
      .get<SberPayment>(invoiceId);
    return row ?? null;
  },

  async create(input: CreateSberPaymentInput): Promise<SberPayment> {
    await getDb().prepare(`
      INSERT INTO sber_payments (invoice_id, external_id, status, payment_purpose, amount, payer_account, payee_inn, request_payload)
      VALUES (:invoice_id, :external_id, :status, :payment_purpose, :amount, :payer_account, :payee_inn, :request_payload)
    `).run({
      ...input,
      request_payload: input.request_payload ?? null,
    });
    return (await this.findByInvoiceId(input.invoice_id))!;
  },

  async updateStatus(
    invoiceId: number,
    patch: { status: string; sber_payment_number?: string | null; response_body?: string | null; error_message?: string | null }
  ): Promise<void> {
    const sets: string[] = ['status = ?'];
    const vals: unknown[] = [patch.status];
    if (patch.sber_payment_number !== undefined) { sets.push('sber_payment_number = ?'); vals.push(patch.sber_payment_number); }
    if (patch.response_body !== undefined) { sets.push('response_body = ?'); vals.push(patch.response_body); }
    if (patch.error_message !== undefined) { sets.push('error_message = ?'); vals.push(patch.error_message); }
    vals.push(invoiceId);
    await getDb().prepare(`UPDATE sber_payments SET ${sets.join(', ')} WHERE invoice_id = ?`).run(...vals);
  },

  async listRecent(limit = 50): Promise<SberPayment[]> {
    // Inline the sanitized LIMIT — mysql2 binds placeholder ints as strings,
    // which MySQL rejects in LIMIT ("Incorrect arguments to mysqld_stmt_execute").
    const lim = Math.max(1, Math.min(500, Math.trunc(Number(limit)) || 50));
    return getDb()
      .prepare(`SELECT * FROM sber_payments ORDER BY created_at DESC LIMIT ${lim}`)
      .all<SberPayment>();
  },

  /** Записать банковский статус. bank_status_at меняется только при смене статуса. */
  async updateBankStatus(invoiceId: number, bankStatus: string | null, bankComment: string | null): Promise<void> {
    await getDb().prepare(`
      UPDATE sber_payments
         SET bank_status_at = CASE WHEN bank_status <=> ? THEN bank_status_at ELSE UTC_TIMESTAMP() END,
             bank_status = ?, bank_comment = ?, status_checked_at = UTC_TIMESTAMP()
       WHERE invoice_id = ?
    `).run(bankStatus, bankStatus, bankComment ? bankComment.slice(0, 1000) : null, invoiceId);
  },

  async markChecked(invoiceId: number): Promise<void> {
    await getDb().prepare('UPDATE sber_payments SET status_checked_at = UTC_TIMESTAMP() WHERE invoice_id = ?').run(invoiceId);
  },

  /**
   * Платёжки, чей банковский статус ещё не окончательный: созданные черновики за
   * 45 дней, не проверявшиеся последние minAgeMinutes. Владелец — из накладной.
   */
  async listToPoll(finalStatuses: string[], opts: { ownerUserId?: number; minAgeMinutes?: number; limit?: number } = {}): Promise<PaymentToPoll[]> {
    const lim = Math.max(1, Math.min(500, Math.trunc(opts.limit ?? 200)));
    const age = Math.max(0, Math.trunc(opts.minAgeMinutes ?? 25));
    const params: unknown[] = [...finalStatuses];
    let ownerClause = '';
    if (opts.ownerUserId != null) { ownerClause = 'AND i.owner_user_id = ?'; params.push(opts.ownerUserId); }
    return getDb().prepare(`
      SELECT sp.invoice_id, sp.external_id, sp.bank_status, sp.amount, i.owner_user_id, i.invoice_number, i.supplier
        FROM sber_payments sp
        JOIN invoices i ON i.id = sp.invoice_id
       WHERE sp.status = 'created'
         AND (sp.bank_status IS NULL OR sp.bank_status NOT IN (${finalStatuses.map(() => '?').join(',')}))
         AND sp.created_at >= (NOW() - INTERVAL 45 DAY)
         AND i.owner_user_id IS NOT NULL ${ownerClause}
         AND (sp.status_checked_at IS NULL OR sp.status_checked_at < (UTC_TIMESTAMP() - INTERVAL ${age} MINUTE))
       ORDER BY (sp.status_checked_at IS NULL) DESC, sp.status_checked_at
       LIMIT ${lim}
    `).all<PaymentToPoll>(...params);
  },

  async deleteByInvoiceId(invoiceId: number): Promise<void> {
    await getDb().prepare('DELETE FROM sber_payments WHERE invoice_id = ?').run(invoiceId);
  },
};
