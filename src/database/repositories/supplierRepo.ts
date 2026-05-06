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
  findByInn(inn: string): Supplier | null {
    const row = getDb().prepare('SELECT * FROM suppliers WHERE inn = ?').get(inn) as Supplier | undefined;
    return row ?? null;
  },

  create(input: CreateSupplierInput): Supplier {
    getDb().prepare(`
      INSERT INTO suppliers (inn, name, kpp, account, bank_bic, bank_corr_account, bank_name, address, verified, source, notes)
      VALUES (@inn, @name, @kpp, @account, @bank_bic, @bank_corr_account, @bank_name, @address, @verified, @source, @notes)
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
    return this.findByInn(input.inn)!;
  },

  upsert(input: CreateSupplierInput): Supplier {
    const existing = this.findByInn(input.inn);
    if (existing) {
      this.update(input.inn, input);
    } else {
      this.create(input);
    }
    return this.findByInn(input.inn)!;
  },

  update(inn: string, patch: Partial<CreateSupplierInput>): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'inn' || v === undefined) continue;
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push(`updated_at = datetime('now')`);
    vals.push(inn);
    getDb().prepare(`UPDATE suppliers SET ${sets.join(', ')} WHERE inn = ?`).run(...vals);
  },

  touchLastUsed(inn: string): void {
    getDb().prepare(`UPDATE suppliers SET last_used_at = datetime('now') WHERE inn = ?`).run(inn);
  },

  delete(inn: string): void {
    getDb().prepare('DELETE FROM suppliers WHERE inn = ?').run(inn);
  },

  list(opts: ListOptions): Supplier[] {
    const wheres: string[] = [];
    const params: unknown[] = [];
    if (opts.q) {
      wheres.push('(name LIKE ? COLLATE NOCASE OR inn LIKE ?)');
      params.push(`%${opts.q}%`, `%${opts.q}%`);
    }
    if (opts.verified !== undefined) {
      wheres.push('verified = ?');
      params.push(opts.verified);
    }
    const sql = `
      SELECT * FROM suppliers
      ${wheres.length > 0 ? 'WHERE ' + wheres.join(' AND ') : ''}
      ORDER BY (last_used_at IS NULL), last_used_at DESC, name COLLATE NOCASE
      LIMIT ? OFFSET ?
    `;
    params.push(opts.limit, opts.offset);
    return getDb().prepare(sql).all(...params) as Supplier[];
  },
};
