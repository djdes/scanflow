import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/services/lineConversion', () => ({ convertInvoiceLine: vi.fn() }));
vi.mock('../../src/database/repositories/invoiceRepo', () => ({ invoiceRepo: { updateItemConversion: vi.fn() } }));
import { convertInvoiceLine } from '../../src/services/lineConversion';
import { invoiceRepo, type InvoiceItem } from '../../src/database/repositories/invoiceRepo';
import { reconvertStoredItem } from '../../src/services/itemReconvert';

describe('confirmed row conversion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(convertInvoiceLine).mockResolvedValue({ quantity: 100, unit: 'шт', price: 90, total: 9000,
      conversion: { raw_quantity: 100, raw_unit: 'шт', raw_price: 90, raw_total: 9000, conv_source: 'manual', conv_factor: 1,
        conv_note: null, qty_flag: null, qty_flag_note: null } });
  });
  const row = { id: 1, original_name: 'Термоэтикетка', onec_guid: 'label', quantity: 100, unit: 'шт', price: 90, total: 9000,
    conv_source: 'manual', qty_confirmed: 1, raw_quantity: 100, raw_unit: 'шт' } as InvoiceItem;
  const inv = { owner_user_id: 1, supplier_inn: null, supplier: 'Поставщик' };
  it('does not overwrite a checked manual result in a background conversion', async () => {
    expect(await reconvertStoredItem(row, inv)).toBe(false);
    expect(await reconvertStoredItem(row, inv, { onecGuid: 'label' })).toBe(false);
    expect(convertInvoiceLine).not.toHaveBeenCalled();
    expect(invoiceRepo.updateItemConversion).not.toHaveBeenCalled();
  });
  it('allows explicit recalculation and writes even when numbers did not change, resetting approval', async () => {
    await reconvertStoredItem(row, inv, { force: true });
    expect(convertInvoiceLine).toHaveBeenCalledOnce();
    expect(invoiceRepo.updateItemConversion).toHaveBeenCalledOnce();
  });
  it('recalculates for a different 1C position', async () => {
    await reconvertStoredItem(row, inv, { onecGuid: 'other' });
    expect(convertInvoiceLine).toHaveBeenCalledWith(expect.objectContaining({ onecGuid: 'other' }));
  });
});
