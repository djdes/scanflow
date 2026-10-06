import { getDb } from '../db';
import { openSecret, sealSecret } from '../../sber/secretBox';

/**
 * Своё подключение подписки ChatGPT (миграция 82): одна строка на платформу (id = 1).
 * Токены в БД только зашифрованы (sealSecret, purpose 'chatgpt-oauth'); наружу их отдаёт
 * лишь getCredentials — для запроса к модели. Сроки — мс эпохи (BIGINT), не DATETIME.
 */
const PURPOSE = 'chatgpt-oauth';

export type ChatgptStatus = 'active' | 'reauth_required';

/** Подключение без токенов: его показывает админка и по нему решается, обновлять ли токен. */
export interface ChatgptConnection {
  status: ChatgptStatus;
  accountId: string | null;
  accountEmail: string | null;
  planType: string | null;
  accessExpiresMs: number | null;
  lastRefreshMs: number | null;
  rateLimitedUntilMs: number | null;
  lastUsedMs: number | null;
  lastError: string | null;
  version: number;
  createdAt: string;
}

export interface ChatgptCredentials {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
}

export interface ChatgptAccount {
  accountId: string | null;
  email: string | null;
  planType: string | null;
  accessExpiresMs: number | null;
}

interface Row {
  status: string;
  account_id: string | null;
  account_email: string | null;
  plan_type: string | null;
  access_token: string;
  refresh_token: string | null;
  id_token: string | null;
  access_expires_ms: number | null;
  last_refresh_ms: number | null;
  rate_limited_until_ms: number | null;
  last_used_ms: number | null;
  last_error: string | null;
  version: number;
  created_at: string;
}

const seal = (v: string | null) => (v == null ? null : sealSecret(v, PURPOSE));
const num = (v: unknown) => (v == null ? null : Number(v));

export const chatgptConnectionRepo = {
  async get(): Promise<ChatgptConnection | null> {
    const row = await getDb().prepare('SELECT * FROM chatgpt_connection WHERE id = 1').get<Row>();
    if (!row) return null;
    return {
      status: row.status === 'reauth_required' ? 'reauth_required' : 'active',
      accountId: row.account_id,
      accountEmail: row.account_email,
      planType: row.plan_type,
      accessExpiresMs: num(row.access_expires_ms),
      lastRefreshMs: num(row.last_refresh_ms),
      rateLimitedUntilMs: num(row.rate_limited_until_ms),
      lastUsedMs: num(row.last_used_ms),
      lastError: row.last_error,
      version: Number(row.version),
      createdAt: row.created_at,
    };
  },

  /** Расшифрованные токены; null — подключения нет или расшифровать нельзя (сменился JWT_SECRET). */
  async getCredentials(): Promise<ChatgptCredentials | null> {
    const row = await getDb()
      .prepare('SELECT access_token, refresh_token, id_token FROM chatgpt_connection WHERE id = 1')
      .get<Pick<Row, 'access_token' | 'refresh_token' | 'id_token'>>();
    if (!row) return null;
    try {
      return {
        accessToken: openSecret(row.access_token, PURPOSE),
        refreshToken: row.refresh_token ? openSecret(row.refresh_token, PURPOSE) : null,
        idToken: row.id_token ? openSecret(row.id_token, PURPOSE) : null,
      };
    } catch {
      return null;
    }
  },

  /** Подключение после входа по коду — заменяет прежнее целиком. */
  async replace(input: { credentials: ChatgptCredentials; account: ChatgptAccount; createdBy: number | null; nowMs: number }): Promise<void> {
    const { credentials: c, account: a } = input;
    await getDb().prepare(`
      INSERT INTO chatgpt_connection (
        id, status, account_id, account_email, plan_type, access_token, refresh_token, id_token,
        access_expires_ms, last_refresh_ms, rate_limited_until_ms, last_used_ms, last_error, version, created_by
      ) VALUES (1, 'active', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?)
      ON DUPLICATE KEY UPDATE
        status = 'active', account_id = VALUES(account_id), account_email = VALUES(account_email),
        plan_type = VALUES(plan_type), access_token = VALUES(access_token), refresh_token = VALUES(refresh_token),
        id_token = VALUES(id_token), access_expires_ms = VALUES(access_expires_ms), last_refresh_ms = VALUES(last_refresh_ms),
        rate_limited_until_ms = NULL, last_used_ms = NULL, last_error = NULL,
        version = version + 1, created_by = VALUES(created_by), created_at = CURRENT_TIMESTAMP
    `).run(
      a.accountId, a.email, a.planType, seal(c.accessToken), seal(c.refreshToken), seal(c.idToken),
      a.accessExpiresMs, input.nowMs, input.createdBy,
    );
  },

  /**
   * Токены после refresh. Пишутся, только если строку никто не менял с момента чтения
   * (version): refresh-токен одноразовый, проигравший перечитывает уже записанное.
   */
  async updateTokens(input: { expectedVersion: number; credentials: ChatgptCredentials; account: ChatgptAccount; refreshedMs: number }): Promise<boolean> {
    const { credentials: c, account: a } = input;
    const res = await getDb().prepare(`
      UPDATE chatgpt_connection SET
        status = 'active', access_token = ?, refresh_token = ?, id_token = ?,
        account_id = ?, account_email = ?, plan_type = ?, access_expires_ms = ?,
        last_refresh_ms = ?, last_error = NULL, version = version + 1
      WHERE id = 1 AND version = ?
    `).run(
      seal(c.accessToken), seal(c.refreshToken), seal(c.idToken),
      a.accountId, a.email, a.planType, a.accessExpiresMs,
      input.refreshedMs, input.expectedVersion,
    );
    return res.changes > 0;
  },

  async markReauth(error: string): Promise<void> {
    await getDb().prepare(`UPDATE chatgpt_connection SET status = 'reauth_required', last_error = ? WHERE id = 1`)
      .run(error.slice(0, 500));
  },

  async markRateLimited(untilMs: number, error: string): Promise<void> {
    await getDb().prepare('UPDATE chatgpt_connection SET rate_limited_until_ms = ?, last_error = ? WHERE id = 1')
      .run(untilMs, error.slice(0, 500));
  },

  /** Успешный запрос: время последнего использования, ошибка и лимит сбрасываются. */
  async touchUsed(nowMs: number): Promise<void> {
    await getDb().prepare('UPDATE chatgpt_connection SET last_used_ms = ?, rate_limited_until_ms = NULL, last_error = NULL WHERE id = 1')
      .run(nowMs);
  },

  async delete(): Promise<void> {
    await getDb().prepare('DELETE FROM chatgpt_connection WHERE id = 1').run();
  },
};
