import { getDb } from '../db';

export interface Supplier {
  id: number;
  /** Компания-владелец карточки. Справочник пер-тенантный: у каждой компании свои реквизиты одного и того же ИНН. */
  owner_user_id: number | null;
  inn: string;
  name: string;
  kpp: string | null;
  account: string | null;
  bank_bic: string;
  bank_corr_account: string | null;
  bank_name: string | null;
  address: string | null;
  verified: number;
  source: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  verification_source: string | null;
  verified_at: string | null;
  verification_fingerprint: string | null;
  verification_risk: string | null;
}

export interface CreateSupplierInput {
  inn: string;
  name: string;
  kpp?: string | null;
  account?: string | null;
  bank_bic: string;
  bank_corr_account?: string | null;
  bank_name?: string | null;
  address?: string | null;
  verified?: number;
  source?: string | null;
  notes?: string | null;
  verification_source?: string | null;
  verified_at?: string | null;
  verification_fingerprint?: string | null;
  verification_risk?: string | null;
}

export interface ListOptions {
  ownerUserId: number;
  q?: string;
  verified?: number;
  limit: number;
  offset: number;
}

// SECURITY: whitelist of columns that update() may write. The update() helper
// interpolates the column name directly into SQL (identifier position cannot be
// a bound parameter), and callers such as PATCH /api/suppliers/:inn forward a
// raw request body. Without this allow-list an attacker-supplied JSON key would
// be spliced into the SET clause — a second-order SQL injection.
const SUPPLIER_UPDATE_COLUMNS = new Set<string>([
  'name', 'kpp', 'account', 'bank_bic', 'bank_corr_account',
  'bank_name', 'address', 'verified', 'source', 'notes', 'last_used_at',
  'verification_source', 'verified_at', 'verification_fingerprint', 'verification_risk',
]);

// Владелец — обязательный параметр каждого метода, без значения по умолчанию.
// Это единственное, что превращает забытый вызывающий из тихой межтенантной
// утечки в ошибку компиляции.
export const supplierRepo = {
  async findByInn(inn: string, ownerUserId: number): Promise<Supplier | null> {
    const row = await getDb()
      .prepare('SELECT * FROM supplier_cards WHERE inn = ? AND owner_user_id = ?')
      .get<Supplier>(inn, ownerUserId);
    return row ?? null;
  },

  async create(input: CreateSupplierInput, ownerUserId: number): Promise<Supplier> {
    await getDb().prepare(`
      INSERT INTO supplier_cards (owner_user_id, inn, name, kpp, account, bank_bic, bank_corr_account, bank_name, address, verified, source, notes)
      VALUES (:owner_user_id, :inn, :name, :kpp, :account, :bank_bic, :bank_corr_account, :bank_name, :address, :verified, :source, :notes)
    `).run({
      owner_user_id: ownerUserId,
      inn: input.inn,
      name: input.name,
      kpp: input.kpp ?? null,
      account: input.account ?? null,
      bank_bic: input.bank_bic,
      bank_corr_account: input.bank_corr_account ?? null,
      bank_name: input.bank_name ?? null,
      address: input.address ?? null,
      verified: input.verified ?? 0,
      source: input.source ?? null,
      notes: input.notes ?? null,
    });
    return (await this.findByInn(input.inn, ownerUserId))!;
  },

  async upsert(input: CreateSupplierInput, ownerUserId: number): Promise<Supplier> {
    const existing = await this.findByInn(input.inn, ownerUserId);
    if (existing) {
      await this.update(input.inn, ownerUserId, input);
    } else {
      await this.create(input, ownerUserId);
    }
    return (await this.findByInn(input.inn, ownerUserId))!;
  },

  /**
   * Like upsert but only fills NULL/empty fields on existing rows. Used by
   * bulk supplier extraction from photos — multiple uploads of similar
   * payment slips shouldn't overwrite user-corrected data.
   */
  async mergeEmpty(
    input: CreateSupplierInput,
    ownerUserId: number,
  ): Promise<{ supplier: Supplier; mode: 'created' | 'merged' | 'unchanged' }> {
    const existing = await this.findByInn(input.inn, ownerUserId);
    if (!existing) {
      return { supplier: await this.create(input, ownerUserId), mode: 'created' };
    }
    const patch: Partial<CreateSupplierInput> = {};
    for (const [k, raw] of Object.entries(input)) {
      if (k === 'inn') continue;
      if (raw == null || raw === '') continue;
      const current = (existing as unknown as Record<string, unknown>)[k];
      if (current == null || current === '') {
        (patch as Record<string, unknown>)[k] = raw;
      }
    }
    if (Object.keys(patch).length === 0) {
      return { supplier: existing, mode: 'unchanged' };
    }
    await this.update(input.inn, ownerUserId, patch);
    return { supplier: (await this.findByInn(input.inn, ownerUserId))!, mode: 'merged' };
  },

  async update(inn: string, ownerUserId: number, patch: Partial<CreateSupplierInput>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'inn' || v === undefined) continue;
      if (!SUPPLIER_UPDATE_COLUMNS.has(k)) continue; // SQLi guard — see allow-list above
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push(`updated_at = NOW()`);
    vals.push(inn, ownerUserId);
    await getDb()
      .prepare(`UPDATE supplier_cards SET ${sets.join(', ')} WHERE inn = ? AND owner_user_id = ?`)
      .run(...vals);
  },

  async touchLastUsed(inn: string, ownerUserId: number): Promise<void> {
    await getDb()
      .prepare(`UPDATE supplier_cards SET last_used_at = NOW() WHERE inn = ? AND owner_user_id = ?`)
      .run(inn, ownerUserId);
  },

  async delete(inn: string, ownerUserId: number): Promise<void> {
    await getDb()
      .prepare('DELETE FROM supplier_cards WHERE inn = ? AND owner_user_id = ?')
      .run(inn, ownerUserId);
  },

  async list(opts: ListOptions): Promise<Supplier[]> {
    const wheres: string[] = ['owner_user_id = ?'];
    const params: unknown[] = [opts.ownerUserId];
    if (opts.q) {
      // utf8mb4_unicode_ci collation makes LIKE case-insensitive by default
      wheres.push('(name LIKE ? OR inn LIKE ?)');
      params.push(`%${opts.q}%`, `%${opts.q}%`);
    }
    if (opts.verified !== undefined) {
      wheres.push('verified = ?');
      params.push(opts.verified);
    }
    // LIMIT/OFFSET are inlined as sanitized integers, not bound params: mysql2
    // sends placeholder ints as strings, which MySQL 8/9 rejects in LIMIT with
    // "Incorrect arguments to mysqld_stmt_execute". Values are clamped here so
    // inlining stays injection-safe even if a caller passes junk.
    const lim = Math.max(1, Math.min(500, Math.trunc(Number(opts.limit)) || 100));
    const off = Math.max(0, Math.trunc(Number(opts.offset)) || 0);
    const sql = `
      SELECT * FROM supplier_cards
      WHERE ${wheres.join(' AND ')}
      ORDER BY (last_used_at IS NULL), last_used_at DESC, name
      LIMIT ${lim} OFFSET ${off}
    `;
    return getDb().prepare(sql).all<Supplier>(...params);
  },
};
