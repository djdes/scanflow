import { getDb } from '../db';

/** Предложение правила из ночного разбора (миграция 70). */
export interface RuleProposal {
  id: number;
  owner_user_id: number;
  kind: string;
  supplier_key: string;
  name_key: string;
  title: string;
  payload: string;
  evidence: string | null;
  source: 'miner' | 'llm';
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
  created_at: string;
  decided_at: string | null;
  decided_by: number | null;
}

export interface NewProposal {
  kind: string;
  supplier_key: string;
  name_key: string;
  title: string;
  payload: unknown;
  evidence?: unknown;
  source: 'miner' | 'llm';
}

export const ruleProposalRepo = {
  /**
   * Создать, если такого ещё нет: ожидающее с тем же ключом не дублируем, а
   * отклонённое человеком за последние 90 дней не предлагаем снова (не
   * надоедаем). Возвращает true, если создано.
   */
  async createIfNew(ownerUserId: number, p: NewProposal): Promise<boolean> {
    const db = getDb();
    const existing = await db.prepare(`
      SELECT id FROM rule_proposals
       WHERE owner_user_id = ? AND kind = ? AND supplier_key = ? AND name_key = ?
         AND (status = 'pending' OR (status IN ('rejected', 'accepted') AND COALESCE(decided_at, created_at) >= (NOW() - INTERVAL 90 DAY)))
       LIMIT 1
    `).get(ownerUserId, p.kind, p.supplier_key.slice(0, 64), p.name_key.slice(0, 191));
    if (existing) return false;
    await db.prepare(`
      INSERT INTO rule_proposals (owner_user_id, kind, supplier_key, name_key, title, payload, evidence, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(ownerUserId, p.kind, p.supplier_key.slice(0, 64), p.name_key.slice(0, 191), p.title.slice(0, 512),
      JSON.stringify(p.payload), p.evidence == null ? null : JSON.stringify(p.evidence).slice(0, 60000), p.source);
    return true;
  },

  async list(ownerUserId: number, status: string = 'pending'): Promise<RuleProposal[]> {
    return getDb().prepare(
      'SELECT * FROM rule_proposals WHERE owner_user_id = ? AND status = ? ORDER BY id DESC LIMIT 300',
    ).all<RuleProposal>(ownerUserId, status);
  },

  async get(ownerUserId: number, id: number): Promise<RuleProposal | null> {
    const row = await getDb().prepare('SELECT * FROM rule_proposals WHERE id = ? AND owner_user_id = ?')
      .get<RuleProposal>(id, ownerUserId);
    return row ?? null;
  },

  async decide(ownerUserId: number, id: number, status: 'accepted' | 'rejected', userId: number | null): Promise<void> {
    await getDb().prepare(
      "UPDATE rule_proposals SET status = ?, decided_at = NOW(), decided_by = ? WHERE id = ? AND owner_user_id = ? AND status = 'pending'",
    ).run(status, userId, id, ownerUserId);
  },

  async countPending(ownerUserId: number): Promise<number> {
    const r = await getDb().prepare("SELECT COUNT(*) AS n FROM rule_proposals WHERE owner_user_id = ? AND status = 'pending'")
      .get<{ n: number }>(ownerUserId);
    return Number(r?.n ?? 0);
  },
};
