import { getDb } from '../db';

export interface WebhookConfig {
  id: number;
  /** Компания-владелец настройки. Вебхук пер-тенантный: у каждой компании свой URL и токен. */
  owner_user_id: number;
  url: string;
  enabled: number;
  auth_token: string | null;
  auto_send_1c: number;
}

export interface WebhookConfigInput {
  url: string;
  enabled: number;
  auth_token: string | null;
  auto_send_1c: number;
}

/**
 * Легаси-вебхук 1С. Раньше это был синглтон (`webhook_config WHERE id = 1`),
 * то есть две компании перетирали друг другу URL и Authorization-токен —
 * накладные одной уходили на эндпоинт другой.
 *
 * Владелец — обязательный параметр каждого метода, без значения по умолчанию:
 * забытый вызывающий должен падать компиляцией, а не молча читать чужой URL.
 */
export const webhookConfigRepo = {
  async get(ownerUserId: number): Promise<WebhookConfig | null> {
    const row = await getDb()
      .prepare('SELECT * FROM webhook_config_cards WHERE owner_user_id = ?')
      .get<WebhookConfig>(ownerUserId);
    return row ?? null;
  },

  async upsert(input: WebhookConfigInput, ownerUserId: number): Promise<void> {
    await getDb().prepare(`
      INSERT INTO webhook_config_cards (owner_user_id, url, enabled, auth_token, auto_send_1c)
      VALUES (:owner_user_id, :url, :enabled, :auth_token, :auto_send_1c)
      ON DUPLICATE KEY UPDATE
        url          = :url,
        enabled      = :enabled,
        auth_token   = :auth_token,
        auto_send_1c = :auto_send_1c
    `).run({
      owner_user_id: ownerUserId,
      url: input.url,
      enabled: input.enabled,
      auth_token: input.auth_token,
      auto_send_1c: input.auto_send_1c,
    });
  },

  /** Легаси-флаг автоотправки в 1С. Отсутствие настройки = выключено. */
  async autoSend1cEnabled(ownerUserId: number): Promise<boolean> {
    const row = await getDb()
      .prepare('SELECT auto_send_1c FROM webhook_config_cards WHERE owner_user_id = ?')
      .get<{ auto_send_1c: number }>(ownerUserId);
    return row?.auto_send_1c === 1;
  },
};
