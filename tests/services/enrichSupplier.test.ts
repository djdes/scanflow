import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../helpers/db';
import { supplierRepo } from '../../src/database/repositories/supplierRepo';
import { enrichInvoiceWithSupplier } from '../../src/services/enrichSupplier';

describe('enrichInvoiceWithSupplier', () => {
  beforeEach(() => resetDb());

  const baseInvoice = {
    supplier: 'ООО "СВИТ ЛАЙФ ФУДСЕРВИС"',  // OCR raw — caps lock
    supplier_inn: '5258068806',
    supplier_kpp: null as string | null,
    supplier_bik: null as string | null,
    supplier_account: null as string | null,
    supplier_corr_account: null as string | null,
    supplier_address: null as string | null,
  };

  it('replaces supplier fields when verified supplier exists for the INN', () => {
    supplierRepo.create({
      inn: '5258068806',
      name: 'ООО "Свит Лайф Фудсервис"',
      kpp: '525801001',
      account: '40702810142020102827',
      bank_bic: '042202603',
      bank_corr_account: '30101810900000000603',
      bank_name: 'Волго-Вятский банк',
      address: 'г. Подольск',
      verified: 1,
      source: 'manual',
    });

    const enriched = enrichInvoiceWithSupplier(baseInvoice);

    expect(enriched.supplier).toBe('ООО "Свит Лайф Фудсервис"');
    expect(enriched.supplier_kpp).toBe('525801001');
    expect(enriched.supplier_bik).toBe('042202603');
    expect(enriched.supplier_account).toBe('40702810142020102827');
    expect(enriched.supplier_corr_account).toBe('30101810900000000603');
    expect(enriched.supplier_address).toBe('г. Подольск');
  });

  it('does nothing when no supplier_inn on invoice', () => {
    const inv = { ...baseInvoice, supplier_inn: null };
    const enriched = enrichInvoiceWithSupplier(inv);
    expect(enriched).toEqual(inv);
  });

  it('does nothing when supplier not in DB', () => {
    const enriched = enrichInvoiceWithSupplier(baseInvoice);
    expect(enriched.supplier).toBe('ООО "СВИТ ЛАЙФ ФУДСЕРВИС"');  // unchanged
  });

  it('does nothing when supplier exists but verified=0', () => {
    supplierRepo.create({
      inn: '5258068806',
      name: 'should-not-show',
      bank_bic: '111111111',
      verified: 0,
      source: 'invoice',
    });
    const enriched = enrichInvoiceWithSupplier(baseInvoice);
    expect(enriched.supplier).toBe('ООО "СВИТ ЛАЙФ ФУДСЕРВИС"');
  });

  it('keeps invoice address when supplier.address is null', () => {
    supplierRepo.create({
      inn: '5258068806',
      name: 'ООО Тест',
      bank_bic: '044525225',
      address: null,
      verified: 1,
      source: 'manual',
    });
    const inv = { ...baseInvoice, supplier_address: 'г. Москва (из OCR)' };
    const enriched = enrichInvoiceWithSupplier(inv);
    expect(enriched.supplier_address).toBe('г. Москва (из OCR)');
  });

  it('does not mutate input object', () => {
    supplierRepo.create({
      inn: '5258068806', name: 'ООО Свит Лайф',
      bank_bic: '042202603', verified: 1,
    });
    const original = { ...baseInvoice };
    enrichInvoiceWithSupplier(baseInvoice);
    expect(baseInvoice).toEqual(original);
  });
});
