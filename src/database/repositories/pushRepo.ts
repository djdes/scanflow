import { createHash } from 'node:crypto';
import { getDb } from '../db';

/** Подписка устройства на уведомления (Web Push), миграция 94. */
export interface PushSubscriptionRow {
  id: number;
  owner_user_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

const hash = (endpoint: string) => createHash('sha256').update(endpoint).digest('hex');

export const pushRepo = {
  /**
   * Сохранить подписку. Адрес подписки принадлежит устройству: вошли на том же
   * телефоне в другую компанию — уведомления теперь её, прежняя их не получает.
   */
  async upsert(ownerUserId: number, sub: PushSubscriptionInput, userAgent: string | null): Promise<void> {
    await getDb().prepare(
      `INSERT INTO push_subscriptions (owner_user_id, endpoint_hash, endpoint, p256dh, auth, user_agent)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE owner_user_id = VALUES(owner_user_id), endpoint = VALUES(endpoint),
         p256dh = VALUES(p256dh), auth = VALUES(auth), user_agent = VALUES(user_agent)`,
    ).run(ownerUserId, hash(sub.endpoint), sub.endpoint, sub.p256dh, sub.auth, userAgent);
  },

  /** Отписка: только своя подписка. Возвращает, была ли она. */
  async removeOwn(ownerUserId: number, endpoint: string): Promise<boolean> {
    const r = await getDb().prepare('DELETE FROM push_subscriptions WHERE endpoint_hash = ? AND owner_user_id = ?')
      .run(hash(endpoint), ownerUserId);
    return Number(r.changes ?? 0) > 0;
  },

  /** Служба уведомлений ответила «подписки больше нет» (404/410). */
  async removeById(id: number): Promise<void> {
    await getDb().prepare('DELETE FROM push_subscriptions WHERE id = ?').run(id);
  },

  async listForUser(ownerUserId: number): Promise<PushSubscriptionRow[]> {
    return getDb().prepare(
      'SELECT id, owner_user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE owner_user_id = ? ORDER BY id',
    ).all<PushSubscriptionRow>(ownerUserId);
  },

  async markSuccess(id: number): Promise<void> {
    await getDb().prepare('UPDATE push_subscriptions SET last_success_at = NOW() WHERE id = ?').run(id);
  },

  async getVapid(): Promise<{ public_key: string; private_key_enc: string } | undefined> {
    return getDb().prepare('SELECT public_key, private_key_enc FROM push_vapid_keys WHERE id = 1')
      .get<{ public_key: string; private_key_enc: string }>();
  },

  /** Первый ключ выигрывает: повторная вставка не затирает уже выданный ключ. */
  async insertVapidIfAbsent(publicKey: string, privateKeyEnc: string): Promise<void> {
    await getDb().prepare('INSERT IGNORE INTO push_vapid_keys (id, public_key, private_key_enc) VALUES (1, ?, ?)')
      .run(publicKey, privateKeyEnc);
  },
};
