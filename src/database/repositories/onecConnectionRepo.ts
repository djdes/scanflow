import crypto from 'crypto';
import { getDb } from '../db';

export interface OnecConnectionRow {
  id: number;
  owner_user_id: number;
  name: string;
  token_prefix: string;
  active: number;
  last_used_at: string | null;
  last_ip: string | null;
  created_at: string;
  revoked_at: string | null;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export const onecConnectionRepo = {
  async create(ownerUserId: number, name: string): Promise<{ connection: OnecConnectionRow; token: string }> {
    const token = `sf1c_${crypto.randomBytes(32).toString('base64url')}`;
    const result = await getDb().prepare(`
      INSERT INTO onec_connections (owner_user_id, name, token_hash, token_prefix)
      VALUES (?, ?, ?, ?)
    `).run(ownerUserId, name.trim().slice(0, 128), hashToken(token), token.slice(0, 12));
    const connection = await this.getById(Number(result.lastInsertRowid));
    return { connection: connection!, token };
  },

  async getById(id: number): Promise<OnecConnectionRow | null> {
    const row = await getDb().prepare(`
      SELECT id, owner_user_id, name, token_prefix, active, last_used_at, last_ip, created_at, revoked_at
        FROM onec_connections WHERE id = ?
    `).get<OnecConnectionRow>(id);
    return row ?? null;
  },

  async authenticate(token: string, ip: string | null): Promise<OnecConnectionRow | null> {
    if (!/^sf1c_[A-Za-z0-9_-]{40,}$/.test(token)) return null;
    const row = await getDb().prepare(`
      SELECT id, owner_user_id, name, token_prefix, active, last_used_at, last_ip, created_at, revoked_at
        FROM onec_connections WHERE token_hash = ? AND active = 1
    `).get<OnecConnectionRow>(hashToken(token));
    if (!row) return null;
    await getDb().prepare('UPDATE onec_connections SET last_used_at = NOW(), last_ip = ? WHERE id = ?')
      .run(ip?.slice(0, 64) || null, row.id);
    return row;
  },

  async list(ownerUserId: number | null): Promise<OnecConnectionRow[]> {
    return ownerUserId == null
      ? getDb().prepare(`SELECT id, owner_user_id, name, token_prefix, active, last_used_at, last_ip, created_at, revoked_at FROM onec_connections ORDER BY active DESC, created_at DESC`).all<OnecConnectionRow>()
      : getDb().prepare(`SELECT id, owner_user_id, name, token_prefix, active, last_used_at, last_ip, created_at, revoked_at FROM onec_connections WHERE owner_user_id = ? ORDER BY active DESC, created_at DESC`).all<OnecConnectionRow>(ownerUserId);
  },

  async revoke(id: number, ownerUserId: number | null): Promise<boolean> {
    const result = ownerUserId == null
      ? await getDb().prepare('UPDATE onec_connections SET active = 0, revoked_at = NOW() WHERE id = ? AND active = 1').run(id)
      : await getDb().prepare('UPDATE onec_connections SET active = 0, revoked_at = NOW() WHERE id = ? AND owner_user_id = ? AND active = 1').run(id, ownerUserId);
    return result.changes > 0;
  },
};
