import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../helpers/db';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';

describe('invoiceRepo — supplier_kpp', () => {
  beforeEach(() => resetDb());

  it('persists and reads supplier_kpp', () => {
    const inv = invoiceRepo.create({
      file_name: 'a.jpg',
      file_path: '/a.jpg',
      supplier: 'Test',
      supplier_inn: '7707083893',
      supplier_kpp: '770701001',
    });
    expect(inv.supplier_kpp).toBe('770701001');
    const reloaded = invoiceRepo.getById(inv.id)!;
    expect(reloaded.supplier_kpp).toBe('770701001');
  });

  it('null when not provided', () => {
    const inv = invoiceRepo.create({ file_name: 'a.jpg', file_path: '/a.jpg' });
    expect(inv.supplier_kpp).toBeNull();
  });
});
