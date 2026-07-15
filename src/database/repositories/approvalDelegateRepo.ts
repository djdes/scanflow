import { getDb } from '../db';

export interface ApprovalDelegateRow {
  id: number;
  delegator_user_id: number;
  delegate_user_id: number;
  max_amount: number | null;
  valid_until: string | null;
  active: number;
  created_at: string;
  revoked_at: string | null;
  delegator_name?: string;
  delegate_name?: string;
}

export const approvalDelegateRepo = {
  async create(delegatorUserId: number, delegateUserId: number, maxAmount: number | null, validUntil: string | null): Promise<ApprovalDelegateRow> {
    await getDb().prepare('UPDATE approval_delegates SET active = 0, revoked_at = NOW() WHERE delegate_user_id = ? AND active = 1').run(delegateUserId);
    const result = await getDb().prepare(`
      INSERT INTO approval_delegates (delegator_user_id, delegate_user_id, max_amount, valid_until)
      VALUES (?, ?, ?, ?)
    `).run(delegatorUserId, delegateUserId, maxAmount, validUntil);
    return (await this.getById(Number(result.lastInsertRowid)))!;
  },

  async getById(id: number): Promise<ApprovalDelegateRow | null> {
    const row = await getDb().prepare(`
      SELECT d.*, a.username AS delegator_name, u.username AS delegate_name
        FROM approval_delegates d JOIN users a ON a.id = d.delegator_user_id JOIN users u ON u.id = d.delegate_user_id
       WHERE d.id = ?
    `).get<ApprovalDelegateRow>(id);
    return row ?? null;
  },

  async activeForUser(userId: number): Promise<ApprovalDelegateRow | null> {
    const row = await getDb().prepare(`
      SELECT d.*, a.username AS delegator_name, u.username AS delegate_name
        FROM approval_delegates d JOIN users a ON a.id = d.delegator_user_id JOIN users u ON u.id = d.delegate_user_id
       WHERE d.delegate_user_id = ? AND d.active = 1 AND (d.valid_until IS NULL OR d.valid_until >= CURDATE())
       ORDER BY d.id DESC LIMIT 1
    `).get<ApprovalDelegateRow>(userId);
    return row ?? null;
  },

  async list(activeOnly = false): Promise<ApprovalDelegateRow[]> {
    return getDb().prepare(`
      SELECT d.*, a.username AS delegator_name, u.username AS delegate_name
        FROM approval_delegates d JOIN users a ON a.id = d.delegator_user_id JOIN users u ON u.id = d.delegate_user_id
       ${activeOnly ? 'WHERE d.active = 1 AND (d.valid_until IS NULL OR d.valid_until >= CURDATE())' : ''}
       ORDER BY d.active DESC, d.created_at DESC
    `).all<ApprovalDelegateRow>();
  },

  async revoke(id: number): Promise<boolean> {
    const result = await getDb().prepare('UPDATE approval_delegates SET active = 0, revoked_at = NOW() WHERE id = ? AND active = 1').run(id);
    return result.changes > 0;
  },
};
