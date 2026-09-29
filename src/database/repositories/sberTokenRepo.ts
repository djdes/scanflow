import { getDb } from '../db';

export interface SberToken {
  id: number;
  /** Компания-владелец подключения. Подключение пер-тенантное: у каждой компании свой банк. */
  owner_user_id: number;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  account_number: string | null;
  org_name: string | null;
  payer_inn: string | null;
  payer_kpp: string | null;
  payer_bank_bic: string | null;
  payer_bank_corr_account: string | null;
  created_at: string;
  updated_at: string;
  /** Миграция 74: откуда пара ('oauth' | 'manual' | 'refresh'), когда получен refresh, последнее обновление и его ошибка (время — UTC). */
  token_source?: string | null;
  refresh_obtained_at?: string | null;
  last_refresh_at?: string | null;
  last_refresh_error?: string | null;
}

export interface UpsertSberTokenInput {
  access_token: string;
  refresh_token: string;
  expires_at: string;
  account_number?: string | null;
  org_name?: string | null;
  payer_inn?: string | null;
  payer_kpp?: string | null;
  payer_bank_bic?: string | null;
  payer_bank_corr_account?: string | null;
}

// Владелец — обязательный параметр каждого метода, без значения по умолчанию.
// Это единственное, что превращает забытый вызывающий из «платёж со счёта чужой
// компании» в ошибку компиляции.
export const sberTokenRepo = {
  async get(ownerUserId: number): Promise<SberToken | null> {
    const row = await getDb()
      .prepare('SELECT * FROM sber_connections WHERE owner_user_id = ?')
      .get<SberToken>(ownerUserId);
    return row ?? null;
  },

  async upsert(input: UpsertSberTokenInput, ownerUserId: number): Promise<void> {
    await getDb().prepare(`
      INSERT INTO sber_connections (
        owner_user_id, access_token, refresh_token, expires_at,
        account_number, org_name, payer_inn, payer_kpp,
        payer_bank_bic, payer_bank_corr_account, updated_at
      ) VALUES (
        :owner_user_id, :access_token, :refresh_token, :expires_at,
        :account_number, :org_name, :payer_inn, :payer_kpp,
        :payer_bank_bic, :payer_bank_corr_account, NOW()
      )
      ON DUPLICATE KEY UPDATE
        access_token = :access_token,
        refresh_token = :refresh_token,
        expires_at = :expires_at,
        account_number = COALESCE(:account_number, sber_connections.account_number),
        org_name = COALESCE(:org_name, sber_connections.org_name),
        payer_inn = COALESCE(:payer_inn, sber_connections.payer_inn),
        payer_kpp = COALESCE(:payer_kpp, sber_connections.payer_kpp),
        payer_bank_bic = COALESCE(:payer_bank_bic, sber_connections.payer_bank_bic),
        payer_bank_corr_account = COALESCE(:payer_bank_corr_account, sber_connections.payer_bank_corr_account),
        updated_at = NOW()
    `).run({
      owner_user_id: ownerUserId,
      access_token: input.access_token,
      refresh_token: input.refresh_token,
      expires_at: input.expires_at,
      account_number: input.account_number ?? null,
      org_name: input.org_name ?? null,
      payer_inn: input.payer_inn ?? null,
      payer_kpp: input.payer_kpp ?? null,
      payer_bank_bic: input.payer_bank_bic ?? null,
      payer_bank_corr_account: input.payer_bank_corr_account ?? null,
    });
  },

  async updateTokens(
    input: { access_token: string; refresh_token: string; expires_at: string },
    ownerUserId: number,
  ): Promise<void> {
    await getDb().prepare(`
      UPDATE sber_connections
         SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = NOW()
       WHERE owner_user_id = ?
    `).run(input.access_token, input.refresh_token, input.expires_at, ownerUserId);
  },

  async updatePayerDetails(input: {
    account_number?: string | null;
    org_name?: string | null;
    payer_inn?: string | null;
    payer_kpp?: string | null;
    payer_bank_bic?: string | null;
    payer_bank_corr_account?: string | null;
  }, ownerUserId: number): Promise<void> {
    // Column names are interpolated into SQL (identifier position), so restrict
    // to a fixed allow-list — defends against any future caller passing a raw
    // request body (current callers use fixed keys). See supplierRepo.update.
    // The owner is a BOUND parameter, never part of this list.
    const ALLOWED = new Set<string>([
      'account_number', 'org_name', 'payer_inn', 'payer_kpp',
      'payer_bank_bic', 'payer_bank_corr_account',
    ]);
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined) continue;
      if (!ALLOWED.has(k)) continue;
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push(`updated_at = NOW()`);
    vals.push(ownerUserId);
    await getDb()
      .prepare(`UPDATE sber_connections SET ${sets.join(', ')} WHERE owner_user_id = ?`)
      .run(...vals);
  },

  /**
   * Итог обновления токена. Успех — новый refresh получен сейчас (его 180 дней
   * отсчитываются заново), ошибка сброшена. Провал — только текст ошибки.
   */
  async setRefreshMeta(ownerUserId: number, r: { ok: true; source: 'oauth' | 'manual' | 'refresh' } | { ok: false; error: string }): Promise<void> {
    if (r.ok) {
      await getDb().prepare(`
        UPDATE sber_connections
           SET token_source = ?, refresh_obtained_at = UTC_TIMESTAMP(), last_refresh_at = UTC_TIMESTAMP(), last_refresh_error = NULL
         WHERE owner_user_id = ?
      `).run(r.source, ownerUserId);
    } else {
      await getDb().prepare('UPDATE sber_connections SET last_refresh_error = ? WHERE owner_user_id = ?')
        .run(r.error.slice(0, 500), ownerUserId);
    }
  },

  /** Компании с подключением к Сберу — для ночного обновления токенов и опроса статусов. */
  async listOwners(): Promise<number[]> {
    const rows = await getDb().prepare('SELECT owner_user_id FROM sber_connections ORDER BY owner_user_id').all<{ owner_user_id: number }>();
    return rows.map(r => Number(r.owner_user_id));
  },

  async clear(ownerUserId: number): Promise<void> {
    await getDb()
      .prepare('DELETE FROM sber_connections WHERE owner_user_id = ?')
      .run(ownerUserId);
  },
};
