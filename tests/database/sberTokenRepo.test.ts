import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../helpers/db';
import { sberTokenRepo } from '../../src/database/repositories/sberTokenRepo';

describe('sberTokenRepo', () => {
  beforeEach(() => resetDb());

  it('returns null when no row exists', () => {
    expect(sberTokenRepo.get()).toBeNull();
  });

  it('upsert creates row id=1', () => {
    sberTokenRepo.upsert({
      access_token: 'a',
      refresh_token: 'r',
      expires_at: '2099-01-01T00:00:00.000Z',
      account_number: '40702810940000099835',
      org_name: 'ООО Тест',
      payer_inn: '7707083893',
      payer_kpp: '770701001',
      payer_bank_bic: '044525225',
      payer_bank_corr_account: '30101810400000000225',
    });
    const row = sberTokenRepo.get()!;
    expect(row.access_token).toBe('a');
    expect(row.account_number).toBe('40702810940000099835');
  });

  it('upsert overwrites existing row', () => {
    sberTokenRepo.upsert({ access_token: 'a', refresh_token: 'r', expires_at: '2099-01-01T00:00:00.000Z' });
    sberTokenRepo.upsert({ access_token: 'b', refresh_token: 'r2', expires_at: '2099-01-02T00:00:00.000Z' });
    expect(sberTokenRepo.get()!.access_token).toBe('b');
  });

  it('updateTokens updates only token fields', () => {
    sberTokenRepo.upsert({
      access_token: 'a', refresh_token: 'r', expires_at: '2099-01-01T00:00:00.000Z',
      account_number: '40702',
    });
    sberTokenRepo.updateTokens({ access_token: 'new-a', refresh_token: 'new-r', expires_at: '2099-02-01T00:00:00.000Z' });
    const row = sberTokenRepo.get()!;
    expect(row.access_token).toBe('new-a');
    expect(row.account_number).toBe('40702');
  });

  it('updatePayerDetails updates only payer fields', () => {
    sberTokenRepo.upsert({ access_token: 'a', refresh_token: 'r', expires_at: '2099-01-01T00:00:00.000Z' });
    sberTokenRepo.updatePayerDetails({ payer_inn: '7707083893', payer_bank_bic: '044525225' });
    const row = sberTokenRepo.get()!;
    expect(row.payer_inn).toBe('7707083893');
    expect(row.payer_bank_bic).toBe('044525225');
    expect(row.access_token).toBe('a');
  });

  it('clear removes the row', () => {
    sberTokenRepo.upsert({ access_token: 'a', refresh_token: 'r', expires_at: '2099-01-01T00:00:00.000Z' });
    sberTokenRepo.clear();
    expect(sberTokenRepo.get()).toBeNull();
  });
});
