import { getDb } from '../db';
import type { NotifyConfig, NotifyMode, EventType } from '../../notifications/types';
import { DEFAULT_EVENT_TYPES } from '../../notifications/types';

export interface User {
  id: number;
  username: string;
  password_hash: string;
  api_key: string;
  role: string;
  is_superadmin?: number;
  is_blocked?: number;
  tariff_plan?: string;
  tariff_limit?: number | null;
  tariff_expires_at?: string | null;
  company_name?: string | null;
  units_all_kg?: number;
  created_at: string;
  last_login_at: string | null;
  email: string | null;
  notify_mode: string; // narrowed when read via getNotifyConfig
  notify_events: string; // JSON-encoded array; parsed by getNotifyConfig
  telegram_chat_id: string | null;
  telegram_bot_token: string | null;
  sber_purpose_template: string;
}

export interface AdminUserListItem {
  id: number;
  username: string;
  role: string;
  email: string | null;
  company_name: string | null;
  is_superadmin: boolean;
  is_blocked: boolean;
  tariff_plan: string;
  tariff_limit: number | null;
  tariff_expires_at: string | null;
  units_all_kg: boolean;
  telegram_chat_id: string | null;
  telegram_bot_token_set: boolean;
  sber_purpose_template: string;
  invoice_count: number;
  created_at: string;
  last_login_at: string | null;
}

export interface UpdateUserFields {
  username?: string;
  email?: string | null;
  company_name?: string | null;
  password_hash?: string;
  api_key?: string;
  role?: string;
  is_superadmin?: boolean;
  is_blocked?: boolean;
  tariff_plan?: string;
  tariff_limit?: number | null;
  tariff_expires_at?: string | null;
  units_all_kg?: boolean;
  telegram_chat_id?: string | null;
  telegram_bot_token?: string | null;
  sber_purpose_template?: string;
}

export const userRepo = {
  // utf8mb4_unicode_ci is case-insensitive by default — no COLLATE NOCASE needed.
  async findByUsername(username: string): Promise<User | undefined> {
    return getDb()
      .prepare('SELECT * FROM users WHERE username = ?')
      .get<User>(username);
  },

  async findByLogin(login: string): Promise<User | undefined> {
    const trimmed = login.trim();
    if (!trimmed) return undefined;
    const byUsername = await this.findByUsername(trimmed);
    if (byUsername) return byUsername;
    return this.findByEmail(trimmed.toLowerCase());
  },

  async findByApiKey(apiKey: string): Promise<User | undefined> {
    return getDb()
      .prepare('SELECT * FROM users WHERE api_key = ?')
      .get<User>(apiKey);
  },

  async create(data: {
    username: string;
    password_hash: string;
    api_key: string;
    role?: string;
    email?: string | null;
    company_name?: string | null;
    is_superadmin?: boolean | number;
    is_blocked?: boolean | number;
    tariff_plan?: string;
    tariff_limit?: number | null;
    tariff_expires_at?: string | null;
    units_all_kg?: boolean | number;
  }): Promise<number> {
    // notify_events is NOT NULL with no DEFAULT (migration 18 cross-DB fix
    // dropped the literal default for MySQL compat). Provide a seed value
    // on INSERT so the row passes the constraint. Derive from the event list so
    // a newly-added event type is on by default for new users automatically —
    // except opt-in ones (OPT_IN_EVENT_TYPES: e.g. the weekly price digest),
    // which only the user turns on.
    const defaultNotifyEvents = JSON.stringify([...DEFAULT_EVENT_TYPES]);
    const result = await getDb()
      .prepare(
        `INSERT INTO users (username, password_hash, api_key, role, email, notify_events)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.username,
        data.password_hash,
        data.api_key,
        data.role ?? 'user',
        data.email ?? null,
        defaultNotifyEvents,
      );
    const id = Number(result.lastInsertRowid);
    if (
      data.company_name !== undefined
      || data.is_superadmin !== undefined
      || data.is_blocked !== undefined
      || data.tariff_plan !== undefined
      || data.tariff_limit !== undefined
      || data.tariff_expires_at !== undefined
      || data.units_all_kg !== undefined
    ) {
      await this.updateUser(id, {
        company_name: data.company_name,
        is_superadmin: data.is_superadmin !== undefined ? Boolean(data.is_superadmin) : undefined,
        is_blocked: data.is_blocked !== undefined ? Boolean(data.is_blocked) : undefined,
        tariff_plan: data.tariff_plan,
        tariff_limit: data.tariff_limit,
        tariff_expires_at: data.tariff_expires_at,
        units_all_kg: data.units_all_kg !== undefined ? Boolean(data.units_all_kg) : undefined,
      });
    }
    return id;
  },

  async updatePasswordHash(id: number, password_hash: string): Promise<void> {
    await getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(password_hash, id);
  },

  async updateApiKey(id: number, api_key: string): Promise<void> {
    await getDb().prepare('UPDATE users SET api_key = ? WHERE id = ?').run(api_key, id);
  },

  async updateUser(id: number, fields: UpdateUserFields): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];

    if (fields.username !== undefined) {
      sets.push('username = ?');
      vals.push(fields.username);
    }
    if (fields.email !== undefined) {
      sets.push('email = ?');
      vals.push(fields.email);
    }
    if (fields.company_name !== undefined) {
      sets.push('company_name = ?');
      vals.push(fields.company_name);
    }
    if (fields.password_hash !== undefined) {
      sets.push('password_hash = ?');
      vals.push(fields.password_hash);
    }
    if (fields.api_key !== undefined) {
      sets.push('api_key = ?');
      vals.push(fields.api_key);
    }
    if (fields.role !== undefined) {
      sets.push('role = ?');
      vals.push(fields.role);
    }
    if (fields.is_superadmin !== undefined) {
      sets.push('is_superadmin = ?');
      vals.push(fields.is_superadmin ? 1 : 0);
    }
    if (fields.is_blocked !== undefined) {
      sets.push('is_blocked = ?');
      vals.push(fields.is_blocked ? 1 : 0);
    }
    if (fields.tariff_plan !== undefined) {
      sets.push('tariff_plan = ?');
      vals.push(fields.tariff_plan);
    }
    if (fields.tariff_limit !== undefined) {
      sets.push('tariff_limit = ?');
      vals.push(fields.tariff_limit);
    }
    if (fields.tariff_expires_at !== undefined) {
      sets.push('tariff_expires_at = ?');
      vals.push(fields.tariff_expires_at);
    }
    if (fields.units_all_kg !== undefined) {
      sets.push('units_all_kg = ?');
      vals.push(fields.units_all_kg ? 1 : 0);
    }
    if (fields.telegram_chat_id !== undefined) {
      sets.push('telegram_chat_id = ?');
      vals.push(fields.telegram_chat_id);
    }
    if (fields.telegram_bot_token !== undefined) {
      sets.push('telegram_bot_token = ?');
      vals.push(fields.telegram_bot_token);
    }
    if (fields.sber_purpose_template !== undefined) {
      sets.push('sber_purpose_template = ?');
      vals.push(fields.sber_purpose_template);
    }

    if (sets.length === 0) return;
    vals.push(id);
    await getDb().prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  },

  async findByEmail(email: string): Promise<User | undefined> {
    return getDb()
      .prepare('SELECT * FROM users WHERE email = ? LIMIT 1')
      .get<User>(email);
  },

  async findByMagicToken(token: string): Promise<User | undefined> {
    return getDb().prepare(
      `SELECT * FROM users
         WHERE magic_token = ?
           AND (magic_token_expires_at IS NULL OR magic_token_expires_at > NOW())
         LIMIT 1`
    ).get<User>(token);
  },

  async consumeMagicToken(token: string): Promise<User | undefined> {
    return getDb().transaction(async (txn) => {
      const user = await txn.prepare(
        `SELECT * FROM users
           WHERE magic_token = ?
             AND (magic_token_expires_at IS NULL OR magic_token_expires_at > NOW())
           LIMIT 1
           FOR UPDATE`
      ).get<User>(token);
      if (!user) return undefined;

      const result = await txn.prepare(
        `UPDATE users
            SET magic_token = NULL,
                magic_token_expires_at = NULL,
                last_login_at = NOW()
          WHERE id = ? AND magic_token = ?`
      ).run(user.id, token);
      return result.changes === 1 ? user : undefined;
    });
  },

  // Set/clear the magic token. Callers should provide a finite expiry; null is
  // retained only so old rows and explicit token clearing remain compatible.
  async setMagicToken(id: number, token: string | null, expiresAt: Date | null = null): Promise<void> {
    await getDb()
      .prepare('UPDATE users SET magic_token = ?, magic_token_expires_at = ? WHERE id = ?')
      .run(token, expiresAt, id);
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

  async findById(id: number): Promise<User | undefined> {
    return getDb().prepare('SELECT * FROM users WHERE id = ?').get<User>(id);
  },

  // Admin user-management list. Safe fields only — never expose password_hash
  // or api_key here.
  async listAll(): Promise<AdminUserListItem[]> {
    const rows = await getDb()
      .prepare(
        `SELECT u.id, u.username, u.role, u.email, u.company_name,
                u.is_superadmin, u.is_blocked,
                u.tariff_plan, u.tariff_limit, u.tariff_expires_at,
                u.units_all_kg, u.telegram_chat_id, u.telegram_bot_token,
                u.sber_purpose_template, u.created_at, u.last_login_at,
                (SELECT COUNT(*) FROM invoices i WHERE i.owner_user_id = u.id) AS invoice_count
           FROM users u
          ORDER BY u.id`
      )
      .all<Record<string, unknown>>();
    return rows.map((r) => ({
      id: Number(r.id),
      username: String(r.username),
      role: String(r.role || 'user'),
      email: r.email != null ? String(r.email) : null,
      company_name: r.company_name != null ? String(r.company_name) : null,
      is_superadmin: Boolean(r.is_superadmin),
      is_blocked: Boolean(r.is_blocked),
      tariff_plan: String(r.tariff_plan || 'beta'),
      tariff_limit: r.tariff_limit != null ? Number(r.tariff_limit) : null,
      tariff_expires_at: r.tariff_expires_at != null ? String(r.tariff_expires_at) : null,
      units_all_kg: Boolean(r.units_all_kg),
      telegram_chat_id: r.telegram_chat_id != null ? String(r.telegram_chat_id) : null,
      telegram_bot_token_set: Boolean(r.telegram_bot_token),
      sber_purpose_template: String(r.sber_purpose_template || ''),
      invoice_count: Number(r.invoice_count ?? 0),
      created_at: String(r.created_at),
      last_login_at: r.last_login_at != null ? String(r.last_login_at) : null,
    }));
  },

  async setRole(id: number, role: string): Promise<void> {
    await getDb().prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  },

  async countAdmins(): Promise<number> {
    const row = await getDb()
      .prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'admin' AND COALESCE(is_blocked, 0) = 0")
      .get<{ cnt: number }>();
    return row?.cnt ?? 0;
  },

  async countSuperadmins(): Promise<number> {
    const row = await getDb()
      .prepare('SELECT COUNT(*) as cnt FROM users WHERE COALESCE(is_superadmin, 0) = 1 AND COALESCE(is_blocked, 0) = 0')
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
