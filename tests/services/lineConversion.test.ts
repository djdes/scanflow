import { describe, it, expect, vi, beforeEach } from 'vitest';

const flags = { units_v2: true, price_guard: true, mapping_v2: true, ocr_memory: true, batch_notify: true, learning: true };
vi.mock('../../src/services/engineFlags', () => ({ getEngineFlags: vi.fn(async () => ({ ...flags })) }));
vi.mock('../../src/database/repositories/itemUnitRuleRepo', () => ({ itemUnitRuleRepo: { find: vi.fn(async () => null), touch: vi.fn(async () => {}) } }));
vi.mock('../../src/database/repositories/onecNomenclatureRepo', () => ({ onecNomenclatureRepo: { getByGuid: vi.fn(async () => ({ guid: 'g', name: 'Батон Нарезной', unit: 'кг' })) } }));
vi.mock('../../src/database/repositories/mappingRepo', () => ({ mappingRepo: { update: vi.fn(async () => {}) } }));
vi.mock('../../src/pricing/priceStats', () => ({ getReferencePrice: vi.fn(async () => null) }));

import { convertInvoiceLine } from '../../src/services/lineConversion';
import { getEngineFlags } from '../../src/services/engineFlags';
import { itemUnitRuleRepo } from '../../src/database/repositories/itemUnitRuleRepo';
import { getReferencePrice } from '../../src/pricing/priceStats';

const base = {
  ownerUserId: 1, supplierKey: 'inn:7722316694', name: 'Батон "Нарезной" в/с 0,4 кг без упаковки',
  raw: { quantity: 60, unit: 'шт', price: 32.2, total: 1932 }, onecGuid: 'g',
};

describe('convertInvoiceLine', () => {
  beforeEach(() => { vi.clearAllMocks(); Object.assign(flags, { units_v2: true, price_guard: true }); });

  it('v2: пересчёт по названию, «как в накладной» сохраняется', async () => {
    const r = await convertInvoiceLine(base);
    expect(r.quantity).toBe(24);
    expect(r.unit).toBe('кг');
    expect(r.total).toBe(1932);
    expect(r.conversion).toMatchObject({ raw_quantity: 60, raw_unit: 'шт', raw_total: 1932, conv_source: 'name' });
  });

  it('правило «поставщик + товар» важнее названия и отмечается использованным', async () => {
    vi.mocked(itemUnitRuleRepo.find).mockResolvedValueOnce({ id: 5, factor: 0.35, target_unit: 'кг', source: 'user' } as never);
    const r = await convertInvoiceLine(base);
    expect(r.quantity).toBe(21);
    expect(r.conversion.conv_source).toBe('rule');
    await new Promise(res => setTimeout(res, 0));
    expect(itemUnitRuleRepo.touch).toHaveBeenCalledWith(5);
  });

  it('units_v2 выключен → прежний пересчёт, но raw всё равно сохраняются', async () => {
    flags.units_v2 = false;
    const r = await convertInvoiceLine(base);
    expect(r.conversion.conv_source).toBe('legacy');
    expect(r.conversion.raw_quantity).toBe(60);
    expect(r.total).toBe(1932);
    expect(getEngineFlags).toHaveBeenCalled();
  });

  it('price_guard выключен → выброс цены не помечается и медиана не запрашивается', async () => {
    flags.price_guard = false;
    const r = await convertInvoiceLine(base);
    expect(getReferencePrice).not.toHaveBeenCalled();
    expect(r.conversion.qty_flag).toBeNull();
  });

  it('price_guard включён и цена выбивается из медианы → флаг', async () => {
    vi.mocked(getReferencePrice).mockResolvedValueOnce(900);
    const r = await convertInvoiceLine(base);
    expect(r.conversion.qty_flag).toBe('price_outlier');
    expect(r.conversion.qty_flag_note).toMatch(/обычной/);
  });
});
