import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/database/migrations';

describe('migration 20 — Sber schema', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => db.close());

  it('creates sber_tokens with id=1 constraint', () => {
    const cols = db.prepare(`PRAGMA table_info(sber_tokens)`).all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    expect(names).toEqual(expect.arrayContaining([
      'id', 'access_token', 'refresh_token', 'expires_at',
      'account_number', 'org_name', 'payer_inn', 'payer_kpp',
      'payer_bank_bic', 'payer_bank_corr_account',
      'created_at', 'updated_at',
    ]));
    db.prepare('INSERT INTO sber_tokens (id, access_token, refresh_token, expires_at) VALUES (1, ?, ?, ?)').run('a', 'r', '2099-01-01');
    expect(() => {
      db.prepare('INSERT INTO sber_tokens (id, access_token, refresh_token, expires_at) VALUES (2, ?, ?, ?)').run('a', 'r', '2099-01-01');
    }).toThrow();
  });

  it('creates suppliers with INN as PK', () => {
    const cols = db.prepare(`PRAGMA table_info(suppliers)`).all() as Array<{ name: string; pk: number }>;
    const names = cols.map(c => c.name);
    expect(names).toEqual(expect.arrayContaining([
      'inn', 'name', 'kpp', 'account', 'bank_bic', 'bank_corr_account',
      'bank_name', 'address', 'verified', 'source', 'notes',
      'created_at', 'updated_at', 'last_used_at',
    ]));
    expect(cols.find(c => c.name === 'inn')?.pk).toBe(1);
  });

  it('creates sber_payments with UNIQUE invoice_id', () => {
    db.prepare(`
      INSERT INTO invoices (file_name, file_path, total_sum, status)
      VALUES ('a.jpg', '/a.jpg', 100, 'processed')
    `).run();
    const invoiceId = (db.prepare('SELECT last_insert_rowid() as id').get() as { id: number }).id;

    db.prepare(`
      INSERT INTO sber_payments (invoice_id, external_id, status, payment_purpose, amount, payer_account, payee_inn)
      VALUES (?, 'uuid1', 'created', 'p', 100, '40702', '5012')
    `).run(invoiceId);

    expect(() => {
      db.prepare(`
        INSERT INTO sber_payments (invoice_id, external_id, status, payment_purpose, amount, payer_account, payee_inn)
        VALUES (?, 'uuid2', 'created', 'p', 100, '40702', '5012')
      `).run(invoiceId);
    }).toThrow(/UNIQUE/);
  });

  it('adds invoices.supplier_kpp column', () => {
    const cols = db.prepare(`PRAGMA table_info(invoices)`).all() as Array<{ name: string }>;
    expect(cols.map(c => c.name)).toContain('supplier_kpp');
  });

  it('adds users.sber_purpose_template column with default', () => {
    const cols = db.prepare(`PRAGMA table_info(users)`).all() as Array<{ name: string; dflt_value: string | null }>;
    const col = cols.find(c => c.name === 'sber_purpose_template');
    expect(col).toBeDefined();
    expect(col?.dflt_value).toContain('{invoice_number}');
  });
});
