import { getDb } from '../db';

export type ApprovalAction = 'sber' | '1c';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface ApprovalRequestRow {
  id: number;
  invoice_id: number;
  action: ApprovalAction;
  status: ApprovalStatus;
  requested_by: number | null;
  decided_by: number | null;
  request_note: string | null;
  decision_note: string | null;
  execution_error: string | null;
  created_at: string;
  decided_at: string | null;
  invoice_number?: string | null;
  supplier?: string | null;
  total_sum?: number | null;
  requester_name?: string | null;
  decider_name?: string | null;
}

export const approvalRepo = {
  async create(invoiceId: number, action: ApprovalAction, requestedBy: number | null, note?: string | null): Promise<ApprovalRequestRow> {
    const existing = await getDb().prepare(`
      SELECT * FROM approval_requests
       WHERE invoice_id = ? AND action = ? AND status = 'pending'
       ORDER BY id DESC LIMIT 1
    `).get<ApprovalRequestRow>(invoiceId, action);
    if (existing) return existing;
    const result = await getDb().prepare(`
      INSERT INTO approval_requests (invoice_id, action, requested_by, request_note)
      VALUES (?, ?, ?, ?)
    `).run(invoiceId, action, requestedBy, note?.trim().slice(0, 2000) || null);
    return (await this.getById(Number(result.lastInsertRowid)))!;
  },

  async getById(id: number): Promise<ApprovalRequestRow | null> {
    const row = await getDb().prepare('SELECT * FROM approval_requests WHERE id = ?').get<ApprovalRequestRow>(id);
    return row ?? null;
  },

  async hasApproved(invoiceId: number, action: ApprovalAction): Promise<boolean> {
    const row = await getDb().prepare(`
      SELECT id FROM approval_requests
       WHERE invoice_id = ? AND action = ? AND status = 'approved'
       ORDER BY id DESC LIMIT 1
    `).get<{ id: number }>(invoiceId, action);
    return !!row;
  },

  async list(limit = 100, status?: ApprovalStatus, ownerUserId: number | null = null): Promise<ApprovalRequestRow[]> {
    const lim = Math.max(1, Math.min(500, Math.trunc(limit) || 100));
    const filters: string[] = [];
    const params: unknown[] = [];
    if (status) { filters.push('ar.status = ?'); params.push(status); }
    if (ownerUserId != null) { filters.push('i.owner_user_id = ?'); params.push(ownerUserId); }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    return getDb().prepare(`
      SELECT ar.*, i.invoice_number, i.supplier, i.total_sum,
             ru.username AS requester_name, du.username AS decider_name
        FROM approval_requests ar
        JOIN invoices i ON i.id = ar.invoice_id
        LEFT JOIN users ru ON ru.id = ar.requested_by
        LEFT JOIN users du ON du.id = ar.decided_by
        ${where}
       ORDER BY CASE ar.status WHEN 'pending' THEN 0 ELSE 1 END, ar.created_at DESC
       LIMIT ${lim}
    `).all<ApprovalRequestRow>(...params);
  },

  async decide(id: number, status: Exclude<ApprovalStatus, 'pending'>, decidedBy: number | null, note?: string | null): Promise<boolean> {
    const result = await getDb().prepare(`
      UPDATE approval_requests
         SET status = ?, decided_by = ?, decision_note = ?, decided_at = NOW()
       WHERE id = ? AND status = 'pending'
    `).run(status, decidedBy, note?.trim().slice(0, 2000) || null, id);
    return result.changes > 0;
  },

  async setExecutionError(id: number, error: string | null): Promise<void> {
    await getDb().prepare('UPDATE approval_requests SET execution_error = ? WHERE id = ?')
      .run(error?.slice(0, 2000) || null, id);
  },
};
