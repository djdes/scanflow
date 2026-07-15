import { getDb } from '../db';

export interface InboundChannelRow {
  user_id: number;
  telegram_enabled: number;
  telegram_secret_hash: string | null;
  email_enabled: number;
  email_secret_hash: string | null;
  telegram_last_update_id: number | null;
  updated_at: string;
}

export const inboundChannelRepo = {
  async get(userId: number): Promise<InboundChannelRow | null> {
    const row = await getDb().prepare('SELECT * FROM inbound_channels WHERE user_id = ?')
      .get<InboundChannelRow>(userId);
    return row ?? null;
  },

  async setTelegram(userId: number, enabled: boolean, secretHash: string | null): Promise<void> {
    await getDb().prepare(`
      INSERT INTO inbound_channels (user_id, telegram_enabled, telegram_secret_hash)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE telegram_enabled = VALUES(telegram_enabled),
                              telegram_secret_hash = VALUES(telegram_secret_hash)
    `).run(userId, enabled ? 1 : 0, secretHash);
  },

  async setEmail(userId: number, enabled: boolean, secretHash: string | null): Promise<void> {
    await getDb().prepare(`
      INSERT INTO inbound_channels (user_id, email_enabled, email_secret_hash)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE email_enabled = VALUES(email_enabled),
                              email_secret_hash = VALUES(email_secret_hash)
    `).run(userId, enabled ? 1 : 0, secretHash);
  },

  async claimTelegramUpdate(userId: number, updateId: number): Promise<boolean> {
    const result = await getDb().prepare(`
      UPDATE inbound_channels
         SET telegram_last_update_id = ?
       WHERE user_id = ? AND telegram_enabled = 1
         AND (telegram_last_update_id IS NULL OR telegram_last_update_id < ?)
    `).run(updateId, userId, updateId);
    return result.changes > 0;
  },
};
