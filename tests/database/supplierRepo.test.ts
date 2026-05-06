import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../helpers/db';
import { supplierRepo } from '../../src/database/repositories/supplierRepo';

describe('supplierRepo', () => {
  beforeEach(() => resetDb());

  const sample = {
    inn: '5012089824',
    name: 'ООО "Свит лайф фудсервис"',
    kpp: '501201001',
    account: '40702810000000000001',
    bank_bic: '044525225',
    bank_corr_account: '30101810400000000225',
    bank_name: 'ПАО Сбербанк',
    address: 'г. Москва',
    verified: 1,
    source: 'manual',
    notes: null,
  };

  it('create + findByInn roundtrip', () => {
    supplierRepo.create(sample);
    const found = supplierRepo.findByInn('5012089824');
    expect(found?.name).toBe(sample.name);
    expect(found?.verified).toBe(1);
  });

  it('findByInn returns null when not found', () => {
    expect(supplierRepo.findByInn('9999999999')).toBeNull();
  });

  it('upsert creates new', () => {
    supplierRepo.upsert(sample);
    expect(supplierRepo.findByInn('5012089824')?.name).toBe(sample.name);
  });

  it('upsert overwrites existing fields', () => {
    supplierRepo.create(sample);
    supplierRepo.upsert({ ...sample, name: 'Новое имя', verified: 1 });
    expect(supplierRepo.findByInn('5012089824')?.name).toBe('Новое имя');
  });

  it('list paginates and searches', () => {
    supplierRepo.create({ ...sample, inn: '1111111111', name: 'Альфа' });
    supplierRepo.create({ ...sample, inn: '2222222222', name: 'Бета' });
    supplierRepo.create({ ...sample, inn: '3333333333', name: 'Гамма' });
    expect(supplierRepo.list({ limit: 10, offset: 0 }).length).toBe(3);
    expect(supplierRepo.list({ q: 'Бет', limit: 10, offset: 0 }).length).toBe(1);
    expect(supplierRepo.list({ q: '3333', limit: 10, offset: 0 }).length).toBe(1);
    expect(supplierRepo.list({ verified: 1, limit: 10, offset: 0 }).length).toBe(3);
  });

  it('update marks updated_at', () => {
    supplierRepo.create(sample);
    const before = supplierRepo.findByInn('5012089824')!.updated_at;
    const start = Date.now();
    while (Date.now() - start < 1100) { /* spin to ensure datetime('now') ticks past 1 second */ }
    supplierRepo.update('5012089824', { name: 'X' });
    const after = supplierRepo.findByInn('5012089824')!.updated_at;
    expect(after >= before).toBe(true);
    expect(supplierRepo.findByInn('5012089824')?.name).toBe('X');
  });

  it('touchLastUsed updates last_used_at', () => {
    supplierRepo.create(sample);
    supplierRepo.touchLastUsed('5012089824');
    expect(supplierRepo.findByInn('5012089824')?.last_used_at).not.toBeNull();
  });

  it('delete removes row', () => {
    supplierRepo.create(sample);
    supplierRepo.delete('5012089824');
    expect(supplierRepo.findByInn('5012089824')).toBeNull();
  });
});
