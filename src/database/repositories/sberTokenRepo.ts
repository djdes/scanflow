import { getDb } from '../db';

export interface SberToken {
  id: number;
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

export const sberTokenRepo = {
  async get(): Promise<SberToken | null> {
    const row = await getDb()
      .prepare('SELECT * FROM sber_tokens WHERE id = 1')
      .get<SberToken>();
    return row ?? null;
  },

  async upsert(input: UpsertSberTokenInput): Promise<void> {
    await getDb().prepare(`
      INSERT INTO sber_tokens (
        id, access_token, refresh_token, expires_at,
        account_number, org_name, payer_inn, payer_kpp,
        payer_bank_bic, payer_bank_corr_account, updated_at
      ) VALUES (
        1, :access_token, :refresh_token, :expires_at,
        :account_number, :org_name, :payer_inn, :payer_kpp,
        :payer_bank_bic, :payer_bank_corr_account, NOW()
      )
      ON DUPLICATE KEY UPDATE
        access_token = :access_token,
        refresh_token = :refresh_token,
        expires_at = :expires_at,
        account_number = COALESCE(:account_number, sber_tokens.account_number),
        org_name = COALESCE(:org_name, sber_tokens.org_name),
        payer_inn = COALESCE(:payer_inn, sber_tokens.payer_inn),
        payer_kpp = COALESCE(:payer_kpp, sber_tokens.payer_kpp),
        payer_bank_bic = COALESCE(:payer_bank_bic, sber_tokens.payer_bank_bic),
        payer_bank_corr_account = COALESCE(:payer_bank_corr_account, sber_tokens.payer_bank_corr_account),
        updated_at = NOW()
    `).run({
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

  async updateTokens(input: { access_token: string; refresh_token: string; expires_at: string }): Promise<void> {
    await getDb().prepare(`
      UPDATE sber_tokens
         SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = NOW()
       WHERE id = 1
    `).run(input.access_token, input.refresh_token, input.expires_at);
  },

  async updatePayerDetails(input: {
    account_number?: string | null;
    org_name?: string | null;
    payer_inn?: string | null;
    payer_kpp?: string | null;
    payer_bank_bic?: string | null;
    payer_bank_corr_account?: string | null;
  }): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push(`updated_at = NOW()`);
    await getDb().prepare(`UPDATE sber_tokens SET ${sets.join(', ')} WHERE id = 1`).run(...vals);
  },

  async clear(): Promise<void> {
    await getDb().prepare('DELETE FROM sber_tokens WHERE id = 1').run();
  },
};
