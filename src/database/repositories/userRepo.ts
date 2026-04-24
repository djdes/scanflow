import { getDb } from '../db';

export interface User {
  id: number;
  username: string;
  password_hash: string;
  api_key: string;
  role: string;
  created_at: string;
  last_login_at: string | null;
}

export const userRepo = {
  findByUsername(username: string): User | undefined {
    const db = getDb();
    return db
      .prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
      .get(username) as User | undefined;
  },

  findByApiKey(apiKey: string): User | undefined {
    const db = getDb();
    return db
      .prepare('SELECT * FROM users WHERE api_key = ?')
      .get(apiKey) as User | undefined;
  },

  create(data: { username: string; password_hash: string; api_key: string; role?: string }): number {
    const db = getDb();
    const result = db
      .prepare(
        `INSERT INTO users (username, password_hash, api_key, role)
         VALUES (?, ?, ?, ?)`
      )
      .run(data.username, data.password_hash, data.api_key, data.role ?? 'user');
    return Number(result.lastInsertRowid);
  },

  updatePasswordHash(id: number, password_hash: string): void {
    getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(password_hash, id);
  },

  updateApiKey(id: number, api_key: string): void {
    getDb().prepare('UPDATE users SET api_key = ? WHERE id = ?').run(api_key, id);
  },

  touchLastLogin(id: number): void {
    getDb()
      .prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`)
      .run(id);
  },

  count(): number {
    const row = getDb().prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number };
    return row.cnt;
  },
};
