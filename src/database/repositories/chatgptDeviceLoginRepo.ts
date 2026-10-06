import { getDb } from '../db';

/**
 * Незавершённый вход в ChatGPT по коду (миграция 82): код показан админу, сервер ждёт
 * подтверждения на auth.openai.com. Один вход на платформу (id = 1); переживает перезапуск.
 */
export interface ChatgptDeviceLogin {
  userCode: string;
  deviceAuthId: string;
  verificationUrl: string;
  intervalSec: number;
  expiresMs: number;
  createdBy: number | null;
}

interface Row {
  user_code: string;
  device_auth_id: string;
  verification_url: string;
  interval_sec: number;
  expires_ms: number;
  created_by: number | null;
}

export const chatgptDeviceLoginRepo = {
  async get(): Promise<ChatgptDeviceLogin | null> {
    const row = await getDb().prepare('SELECT * FROM chatgpt_device_login WHERE id = 1').get<Row>();
    if (!row) return null;
    return {
      userCode: row.user_code,
      deviceAuthId: row.device_auth_id,
      verificationUrl: row.verification_url,
      intervalSec: Number(row.interval_sec),
      expiresMs: Number(row.expires_ms),
      createdBy: row.created_by,
    };
  },

  async replace(login: ChatgptDeviceLogin): Promise<void> {
    await getDb().prepare(`
      INSERT INTO chatgpt_device_login (id, user_code, device_auth_id, verification_url, interval_sec, expires_ms, created_by)
      VALUES (1, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        user_code = VALUES(user_code), device_auth_id = VALUES(device_auth_id),
        verification_url = VALUES(verification_url), interval_sec = VALUES(interval_sec),
        expires_ms = VALUES(expires_ms), created_by = VALUES(created_by), created_at = CURRENT_TIMESTAMP
    `).run(login.userCode, login.deviceAuthId, login.verificationUrl, login.intervalSec, login.expiresMs, login.createdBy);
  },

  async delete(): Promise<void> {
    await getDb().prepare('DELETE FROM chatgpt_device_login WHERE id = 1').run();
  },
};
