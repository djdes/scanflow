import { getDb } from '../db';

export interface Supplier {
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
}

export interface ListOptions {
  q?: string;
  verified?: number;
  limit: number;
  offset: number;
}

export const supplierRepo = {
  async findByInn(inn: string): Promise<Supplier | null> {
    const row = await getDb()
      .prepare('SELECT * FROM suppliers WHERE inn = ?')
      .get<Supplier>(inn);
    return row ?? null;
  },

  async create(input: CreateSupplierInput): Promise<Supplier> {
    await getDb().prepare(`
      INSERT INTO suppliers (inn, name, kpp, account, bank_bic, bank_corr_account, bank_name, address, verified, source, notes)
      VALUES (:inn, :name, :kpp, :account, :bank_bic, :bank_corr_account, :bank_name, :address, :verified, :source, :notes)
    `).run({
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
    return (await this.findByInn(input.inn))!;
  },

  async upsert(input: CreateSupplierInput): Promise<Supplier> {
    const existing = await this.findByInn(input.inn);
    if (existing) {
      await this.update(input.inn, input);
    } else {
      await this.create(input);
    }
    return (await this.findByInn(input.inn))!;
  },

  async update(inn: string, patch: Partial<CreateSupplierInput>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'inn' || v === undefined) continue;
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push(`updated_at = NOW()`);
    vals.push(inn);
    await getDb().prepare(`UPDATE suppliers SET ${sets.join(', ')} WHERE inn = ?`).run(...vals);
  },

  async touchLastUsed(inn: string): Promise<void> {
    await getDb().prepare(`UPDATE suppliers SET last_used_at = NOW() WHERE inn = ?`).run(inn);
  },

  async delete(inn: string): Promise<void> {
    await getDb().prepare('DELETE FROM suppliers WHERE inn = ?').run(inn);
  },

  async list(opts: ListOptions): Promise<Supplier[]> {
    const wheres: string[] = [];
    const params: unknown[] = [];
    if (opts.q) {
      // utf8mb4_unicode_ci collation makes LIKE case-insensitive by default
      wheres.push('(name LIKE ? OR inn LIKE ?)');
      params.push(`%${opts.q}%`, `%${opts.q}%`);
    }
    if (opts.verified !== undefined) {
      wheres.push('verified = ?');
      params.push(opts.verified);
    }
    const sql = `
      SELECT * FROM suppliers
      ${wheres.length > 0 ? 'WHERE ' + wheres.join(' AND ') : ''}
      ORDER BY (last_used_at IS NULL), last_used_at DESC, name
      LIMIT ? OFFSET ?
    `;
    params.push(opts.limit, opts.offset);
    return getDb().prepare(sql).all<Supplier>(...params);
  },
};
