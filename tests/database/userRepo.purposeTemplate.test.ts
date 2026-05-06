import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../helpers/db';
import { userRepo } from '../../src/database/repositories/userRepo';
import { getDb } from '../../src/database/db';

describe('userRepo — sber_purpose_template', () => {
  beforeEach(() => {
    resetDb();
    getDb().prepare(`INSERT INTO users (username, password_hash, api_key) VALUES ('admin','h','k')`).run();
  });

  it('default template is set on user creation', () => {
    const tpl = userRepo.getPurposeTemplate(1);
    expect(tpl).toContain('{invoice_number}');
    expect(tpl).toContain('{vat_clause}');
  });

  it('setPurposeTemplate persists', () => {
    userRepo.setPurposeTemplate(1, 'CUSTOM {invoice_number}');
    expect(userRepo.getPurposeTemplate(1)).toBe('CUSTOM {invoice_number}');
  });

  it('getPurposeTemplate returns null for unknown id', () => {
    expect(userRepo.getPurposeTemplate(999)).toBeNull();
  });
});
