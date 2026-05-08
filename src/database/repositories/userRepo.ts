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
  sber_purpose_template: string;
}

export const userRepo = {
  // utf8mb4_unicode_ci is case-insensitive by default — no COLLATE NOCASE needed.
  async findByUsername(username: string): Promise<User | undefined> {
    return getDb()
      .prepare('SELECT * FROM users WHERE username = ?')
      .get<User>(username);
  },

  async findByApiKey(apiKey: string): Promise<User | undefined> {
    return getDb()
      .prepare('SELECT * FROM users WHERE api_key = ?')
      .get<User>(apiKey);
  },

  async create(data: { username: string; password_hash: string; api_key: string; role?: string }): Promise<number> {
    const result = await getDb()
      .prepare(
        `INSERT INTO users (username, password_hash, api_key, role)
         VALUES (?, ?, ?, ?)`
      )
      .run(data.username, data.password_hash, data.api_key, data.role ?? 'user');
    return Number(result.lastInsertRowid);
  },

  async updatePasswordHash(id: number, password_hash: string): Promise<void> {
    await getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(password_hash, id);
  },

  async updateApiKey(id: number, api_key: string): Promise<void> {
    await getDb().prepare('UPDATE users SET api_key = ? WHERE id = ?').run(api_key, id);
  },

  async touchLastLogin(id: number): Promise<void> {
    await getDb()
      .prepare(`UPDATE users SET last_login_at = NOW() WHERE id = ?`)
      .run(id);
  },

  async count(): Promise<number> {
    const row = await getDb()
      .prepare('SELECT COUNT(*) as cnt FROM users')
      .get<{ cnt: number }>();
    return row?.cnt ?? 0;
  },

  async getNotifyConfig(id: number): Promise<NotifyConfig | null> {
    const row = await getDb()
      .prepare('SELECT email, notify_mode, notify_events FROM users WHERE id = ?')
      .get<{ email: string | null; notify_mode: string; notify_events: string }>(id);
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

  async setNotifyConfig(id: number, cfg: Partial<NotifyConfig>): Promise<void> {
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
    await getDb().prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  },

  // Returns the row id of the first user (lowest id). Used by emit() when no
  // HTTP-context user is available (e.g. fileWatcher background events).
  // For the current single-user setup this is the owner.
  async firstUserId(): Promise<number | null> {
    const row = await getDb()
      .prepare('SELECT id FROM users ORDER BY id LIMIT 1')
      .get<{ id: number }>();
    return row?.id ?? null;
  },

  async getTelegramConfig(id: number): Promise<{ chat_id: string | null; bot_token: string | null } | null> {
    const row = await getDb()
      .prepare('SELECT telegram_chat_id, telegram_bot_token FROM users WHERE id = ?')
      .get<{ telegram_chat_id: string | null; telegram_bot_token: string | null }>(id);
    if (!row) return null;
    return { chat_id: row.telegram_chat_id, bot_token: row.telegram_bot_token };
  },

  async setTelegramConfig(id: number, cfg: Partial<{ chat_id: string | null; bot_token: string | null }>): Promise<void> {
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
    await getDb().prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  },

  async getPurposeTemplate(id: number): Promise<string | null> {
    const row = await getDb()
      .prepare('SELECT sber_purpose_template FROM users WHERE id = ?')
      .get<{ sber_purpose_template: string }>(id);
    return row?.sber_purpose_template ?? null;
  },

  async setPurposeTemplate(id: number, template: string): Promise<void> {
    await getDb()
      .prepare('UPDATE users SET sber_purpose_template = ? WHERE id = ?')
      .run(template, id);
  },
};
