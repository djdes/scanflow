import { getDb } from '../db';
import type { NotifyConfig, NotifyMode, EventType } from '../../notifications/types';

export interface User {
  id: number;
  username: string;
  password_hash: string;
  api_key: string;
  role: string;
  created_at: string;
  last_login_at: string | null;
  email: string | null;
  notify_mode: string; // narrowed when read via getNotifyConfig
  notify_events: string; // JSON-encoded array; parsed by getNotifyConfig
  telegram_chat_id: string | null;
  telegram_bot_token: string | null;
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

  getNotifyConfig(id: number): NotifyConfig | null {
    const row = getDb()
      .prepare('SELECT email, notify_mode, notify_events FROM users WHERE id = ?')
      .get(id) as { email: string | null; notify_mode: string; notify_events: string } | undefined;
    if (!row) return null;
    let events: EventType[];
    try {
      const parsed = JSON.parse(row.notify_events);
      events = Array.isArray(parsed) ? parsed : [];
    } catch {
      events = [];
    }
    return {
      email: row.email,
      notify_mode: row.notify_mode as NotifyMode,
      notify_events: events,
    };
  },

  setNotifyConfig(id: number, cfg: Partial<NotifyConfig>): void {
    const fields: string[] = [];
    const values: unknown[] = [];
    if (cfg.email !== undefined) {
      fields.push('email = ?');
      values.push(cfg.email);
    }
    if (cfg.notify_mode !== undefined) {
      fields.push('notify_mode = ?');
      values.push(cfg.notify_mode);
    }
    if (cfg.notify_events !== undefined) {
      fields.push('notify_events = ?');
      values.push(JSON.stringify(cfg.notify_events));
    }
    if (fields.length === 0) return;
    values.push(id);
    getDb().prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  },

  // Returns the row id of the first user (lowest id). Used by emit() when no
  // HTTP-context user is available (e.g. fileWatcher background events).
  // For the current single-user setup this is the owner.
  firstUserId(): number | null {
    const row = getDb()
      .prepare('SELECT id FROM users ORDER BY id LIMIT 1')
      .get() as { id: number } | undefined;
    return row?.id ?? null;
  },

  getTelegramConfig(id: number): { chat_id: string | null; bot_token: string | null } | null {
    const row = getDb()
      .prepare('SELECT telegram_chat_id, telegram_bot_token FROM users WHERE id = ?')
      .get(id) as { telegram_chat_id: string | null; telegram_bot_token: string | null } | undefined;
    if (!row) return null;
    return { chat_id: row.telegram_chat_id, bot_token: row.telegram_bot_token };
  },

  setTelegramConfig(id: number, cfg: Partial<{ chat_id: string | null; bot_token: string | null }>): void {
    const fields: string[] = [];
    const values: unknown[] = [];
    if (cfg.chat_id !== undefined) {
      fields.push('telegram_chat_id = ?');
      values.push(cfg.chat_id);
    }
    if (cfg.bot_token !== undefined) {
      fields.push('telegram_bot_token = ?');
      values.push(cfg.bot_token);
    }
    if (fields.length === 0) return;
    values.push(id);
    getDb().prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  },
};
