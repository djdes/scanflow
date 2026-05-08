import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../helpers/db';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';
import { getDb } from '../../src/database/db';

describe('invoiceRepo — duplicate detection', () => {
  beforeEach(() => resetDb());

  function seedOriginal(overrides: Partial<{
    invoice_number: string;
    invoice_date: string;
    supplier: string;
    supplier_inn: string;
    total_sum: number;
    minutesAgo: number;
  }> = {}) {
    const data = {
      invoice_number: '650',
      invoice_date: '2026-05-05',
      supplier: 'ИП Чихинов Гюндуз Аббасович',
      supplier_inn: '521800000000',
      total_sum: 43400,
      minutesAgo: 60,
      ...overrides,
    };
    const inv = invoiceRepo.create({
      file_name: 'a.jpg',
      file_path: '/a.jpg',
      invoice_number: data.invoice_number,
      invoice_date: data.invoice_date,
      supplier: data.supplier,
      supplier_inn: data.supplier_inn,
      total_sum: data.total_sum,
    });
    // Backdate created_at by N minutes so window math works deterministically.
    getDb().prepare(
      `UPDATE invoices SET created_at = datetime('now', '-${data.minutesAgo} minutes'), status = 'processed' WHERE id = ?`
    ).run(inv.id);
    return invoiceRepo.getById(inv.id)!;
  }

  it('finds original by INN + number + date + total within 30 days', () => {
    const original = seedOriginal();
    const found = invoiceRepo.findDuplicateOriginal(
      999, '650', '521800000000', null, '2026-05-05', 43400, 30,
    );
    expect(found?.id).toBe(original.id);
  });

  it('falls back to fuzzy supplier name when INN missing on either side', () => {
    const original = seedOriginal({ supplier_inn: undefined });
    const found = invoiceRepo.findDuplicateOriginal(
      999, '650', null, 'ИП Чихинов', '2026-05-05', 43400, 30,
    );
    expect(found?.id).toBe(original.id);
  });

  it('REJECTS when INN differs (different juridical entities, same number)', () => {
    seedOriginal({ supplier_inn: '111111111111' });
    const found = invoiceRepo.findDuplicateOriginal(
      999, '650', '999999999999', null, '2026-05-05', 43400, 30,
    );
    expect(found).toBeUndefined();
  });

  it('rejects when total_sum diverges by >1 руб', () => {
    seedOriginal({ total_sum: 43400 });
    const found = invoiceRepo.findDuplicateOriginal(
      999, '650', '521800000000', null, '2026-05-05', 43500, 30,
    );
    expect(found).toBeUndefined();
  });

  it('accepts ±1 руб difference (VAT rounding tolerance)', () => {
    const original = seedOriginal({ total_sum: 43400.5 });
    const found = invoiceRepo.findDuplicateOriginal(
      999, '650', '521800000000', null, '2026-05-05', 43401, 30,
    );
    expect(found?.id).toBe(original.id);
  });

  it('rejects when invoice_date differs', () => {
    seedOriginal({ invoice_date: '2026-05-05' });
    const found = invoiceRepo.findDuplicateOriginal(
      999, '650', '521800000000', null, '2026-05-06', 43400, 30,
    );
    expect(found).toBeUndefined();
  });

  it('respects 30-day window — older originals are ignored', () => {
    seedOriginal({ minutesAgo: 60 * 24 * 31 });  // 31 days ago
    const found = invoiceRepo.findDuplicateOriginal(
      999, '650', '521800000000', null, '2026-05-05', 43400, 30,
    );
    expect(found).toBeUndefined();
  });

  it('skips originals already marked as duplicates', () => {
    const orig = seedOriginal();
    invoiceRepo.markAsDuplicate(orig.id, 9999);  // pretend it's a duplicate of something
    const found = invoiceRepo.findDuplicateOriginal(
      999, '650', '521800000000', null, '2026-05-05', 43400, 30,
    );
    expect(found).toBeUndefined();
  });

  it('does NOT match itself (excludeId)', () => {
    const orig = seedOriginal();
    const found = invoiceRepo.findDuplicateOriginal(
      orig.id, '650', '521800000000', null, '2026-05-05', 43400, 30,
    );
    expect(found).toBeUndefined();
  });

  it('returns undefined when key fields missing', () => {
    seedOriginal();
    expect(invoiceRepo.findDuplicateOriginal(999, null, '521800000000', null, '2026-05-05', 43400, 30)).toBeUndefined();
    expect(invoiceRepo.findDuplicateOriginal(999, '650', '521800000000', null, null, 43400, 30)).toBeUndefined();
    expect(invoiceRepo.findDuplicateOriginal(999, '650', '521800000000', null, '2026-05-05', null, 30)).toBeUndefined();
    expect(invoiceRepo.findDuplicateOriginal(999, '650', null, null, '2026-05-05', 43400, 30)).toBeUndefined();
  });

  it('markAsDuplicate sets duplicate_of and status', () => {
    const orig = seedOriginal();
    const dup = seedOriginal();
    invoiceRepo.markAsDuplicate(dup.id, orig.id);
    const reloaded = invoiceRepo.getById(dup.id)!;
    expect(reloaded.duplicate_of).toBe(orig.id);
    expect(reloaded.status).toBe('duplicate');
  });

  it('unmarkAsDuplicate clears duplicate_of and resets status', () => {
    const orig = seedOriginal();
    const dup = seedOriginal();
    invoiceRepo.markAsDuplicate(dup.id, orig.id);
    invoiceRepo.unmarkAsDuplicate(dup.id);
    const reloaded = invoiceRepo.getById(dup.id)!;
    expect(reloaded.duplicate_of).toBeNull();
    expect(reloaded.status).toBe('processed');
  });
});
