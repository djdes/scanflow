import { describe, it, expect, vi, beforeEach } from 'vitest';

// Позиция 1С ведётся в штуках (яйца), а правило «всё в кг» включено.
const flags = { units_v2: true, all_kg: true, price_guard: true, mapping_v2: true, ocr_memory: true, batch_notify: true, learning: true, row_pairing: true };
vi.mock('../../src/services/engineFlags', () => ({ getEngineFlags: vi.fn(async () => ({ ...flags })) }));
vi.mock('../../src/database/repositories/itemUnitRuleRepo', () => ({ itemUnitRuleRepo: { find: vi.fn(async () => null), touch: vi.fn(async () => {}) } }));
vi.mock('../../src/database/repositories/onecNomenclatureRepo', () => ({
  onecNomenclatureRepo: { getByGuid: vi.fn(async () => ({ guid: 'g-egg', name: 'Яйцо Куриное', unit: 'шт' })) },
}));
vi.mock('../../src/database/repositories/mappingRepo', () => ({ mappingRepo: { update: vi.fn(async () => {}) } }));
vi.mock('../../src/pricing/priceStats', () => ({ getReferencePrice: vi.fn(async () => 7) }));

import { convertInvoiceLine } from '../../src/services/lineConversion';
import { getReferencePrice } from '../../src/pricing/priceStats';

const eggs = {
  ownerUserId: 1, supplierKey: 'inn:5258068806', name: 'Яйцо Куриное Коричневое С1 360шт',
  raw: { quantity: 1080, unit: 'шт', price: 7, total: 7560 }, onecGuid: 'g-egg',
};

describe('convertInvoiceLine — «всё в кг»', () => {
  beforeEach(() => { vi.clearAllMocks(); flags.all_kg = true; });

  it('позиция 1С в штуках → строка всё равно в кг; медиана цены за штуку не сравнивается', async () => {
    const r = await convertInvoiceLine(eggs);
    expect(r).toMatchObject({ quantity: 59.4, unit: 'кг', total: 7560 });
    expect(r.conversion).toMatchObject({ raw_quantity: 1080, raw_unit: 'шт', conv_source: 'name', qty_flag: null });
    expect(getReferencePrice).not.toHaveBeenCalled();
  });

  it('строка без позиции 1С — тоже в кг', async () => {
    const r = await convertInvoiceLine({ ...eggs, onecGuid: null });
    expect(r).toMatchObject({ quantity: 59.4, unit: 'кг' });
  });

  it('флаг выключен → прежнее поведение: единица позиции 1С (шт)', async () => {
    flags.all_kg = false;
    const r = await convertInvoiceLine(eggs);
    expect(r).toMatchObject({ quantity: 1080, unit: 'шт' });
    expect(getReferencePrice).toHaveBeenCalled();
  });
});
