import { getDb } from '../db';

export interface ProductAssistantConnection {
  owner_user_id: number;
  label: string;
  api_base_url: string;
  api_token_enc: string;
  enabled: number;
}

export const productAssistantRepo = {
  async get(owner: number): Promise<ProductAssistantConnection | null> {
    return await getDb().prepare('SELECT * FROM product_assistant_connections WHERE owner_user_id = ?')
      .get<ProductAssistantConnection>(owner) ?? null;
  },
  async save(row: ProductAssistantConnection): Promise<void> {
    await getDb().prepare(`
      INSERT INTO product_assistant_connections (owner_user_id, label, api_base_url, api_token_enc, enabled)
      VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE label = VALUES(label), api_base_url = VALUES(api_base_url),
        api_token_enc = VALUES(api_token_enc), enabled = VALUES(enabled), updated_at = NOW()
    `).run(row.owner_user_id, row.label, row.api_base_url, row.api_token_enc, row.enabled);
  },
  async remove(owner: number): Promise<void> {
    await getDb().prepare('DELETE FROM product_assistant_connections WHERE owner_user_id = ?').run(owner);
  },
};
