import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NomenclatureMapper, type MappingResult } from '../../src/mapping/nomenclatureMapper';
import { mappingRepo } from '../../src/database/repositories/mappingRepo';
import { onecNomenclatureRepo } from '../../src/database/repositories/onecNomenclatureRepo';
import { rejectionRepo } from '../../src/database/repositories/rejectionRepo';
import { getOnecUsage } from '../../src/integration/onecUsage';

vi.mock('../../src/integration/onecUsage', () => ({ getOnecUsage: vi.fn(), usageSource: () => ({ url: 'http://test', token: 'test' }) }));
vi.mock('../../src/database/repositories/mappingRepo', () => ({ mappingRepo: { getConfirmed: vi.fn() } }));
vi.mock('../../src/database/repositories/onecNomenclatureRepo', () => ({ onecNomenclatureRepo: { listItems: vi.fn(), getByGuid: vi.fn() } }));
vi.mock('../../src/database/repositories/rejectionRepo', () => ({ rejectionRepo: { guidsFor: vi.fn() } }));
vi.mock('../../src/utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
const catalog = [
  { guid: 'a', name: 'Бекон сырокопченый' }, { guid: 'b', name: 'Бекон варено-копченый' },
  { guid: 'dish', name: 'Суп гороховый с беконом' },
];
const ordinary: MappingResult = { original_name: 'Бекон', mapped_name: catalog[0].name, onec_guid: 'a', confidence: 1, source: 'learned', mapping_id: 5, pack_size: 10, pack_unit: 'кг' };
const stats = (a: [number, number], b: [number, number]) => ({ available: true, checkedAt: '2026-10-16T08:00:00Z', rows: new Map([
  ['a', { specifications: a[0], receipts: a[1] }], ['b', { specifications: b[0], receipts: b[1] }],
]) });
let mapper: NomenclatureMapper;
beforeEach(() => {
  vi.clearAllMocks(); mapper = new NomenclatureMapper();
  vi.mocked(mappingRepo.getConfirmed).mockResolvedValue(undefined);
  vi.mocked(rejectionRepo.guidsFor).mockResolvedValue(new Set());
  vi.mocked(onecNomenclatureRepo.listItems).mockResolvedValue(catalog as never);
});

describe('usage-based ambiguity resolution', () => {
  it('prefers specifications over any number of receipts and clears another item pack hint', async () => {
    vi.mocked(getOnecUsage).mockResolvedValue(stats([2, 1000], [3, 0]));
    const chosen = await mapper.refineWithUsage('Бекон', ordinary, 3);
    expect(chosen).toMatchObject({ onec_guid: 'b', source: 'onec_usage', mapping_id: null, pack_size: null, pack_unit: null });
    expect(chosen.mapping_reason).toContain('3 спецификации');
    expect(getOnecUsage).toHaveBeenCalledWith(3, ['a', 'b']); // суп не кандидат
  });
  it('uses receipts to break equal specification counts', async () => {
    vi.mocked(getOnecUsage).mockResolvedValue(stats([2, 4], [2, 5]));
    expect((await mapper.refineWithUsage('Бекон', ordinary, 3)).onec_guid).toBe('b');
  });
  it.each([{ a: [0, 0], b: [0, 0] }, { a: [3, 5], b: [3, 5] }])('keeps the ordinary pick when counts do not distinguish candidates', async ({ a, b }) => {
    vi.mocked(getOnecUsage).mockResolvedValue(stats(a as [number, number], b as [number, number]));
    expect((await mapper.refineWithUsage('Бекон', ordinary, 3)).onec_guid).toBe('a');
  });
  it('retains confirmed human choices without querying popularity', async () => {
    vi.mocked(mappingRepo.getConfirmed).mockResolvedValue({ id: 9, onec_guid: 'b', pack_size: null, pack_unit: null } as never);
    vi.mocked(onecNomenclatureRepo.getByGuid).mockResolvedValue(catalog[1] as never);
    const chosen = await mapper.refineWithUsage('Бекон', ordinary, 3);
    expect(chosen).toMatchObject({ onec_guid: 'b', source: 'learned', confidence: 1 });
    expect(chosen.mapping_reason).toContain('подтверждённому человеком');
    expect(getOnecUsage).not.toHaveBeenCalled();
  });
  it('keeps supplier rules and excludes rejected candidates', async () => {
    expect((await mapper.refineWithUsage('Бекон', { ...ordinary, source: 'supplier' }, 3)).onec_guid).toBe('a');
    vi.mocked(rejectionRepo.guidsFor).mockResolvedValue(new Set(['b']));
    expect((await mapper.refineWithUsage('Бекон', ordinary, 3)).onec_guid).toBe('a');
    expect(getOnecUsage).not.toHaveBeenCalled();
  });
  it('does not treat a failed MCP check as zero usage', async () => {
    vi.mocked(getOnecUsage).mockResolvedValue({ available: false, checkedAt: null, rows: new Map(), reason: 'unavailable' });
    const chosen = await mapper.refineWithUsage('Бекон', ordinary, 3);
    expect(chosen.onec_guid).toBe('a');
    expect(chosen.mapping_reason).toContain('не проверена');
  });
  it('respects explicit fat content before comparing popularity', async () => {
    vi.mocked(onecNomenclatureRepo.listItems).mockResolvedValue([
      { guid: 'a', name: 'Молоко 3,2% Альфа' }, { guid: 'b', name: 'Молоко 3,2% Бета' }, { guid: 'wrong', name: 'Молоко 1,5%' },
    ] as never);
    vi.mocked(getOnecUsage).mockResolvedValue(stats([1, 0], [5, 0]));
    expect((await mapper.refineWithUsage('Молоко 3,2%', ordinary, 3)).onec_guid).toBe('b');
    expect(getOnecUsage).toHaveBeenCalledWith(3, ['a', 'b']);
  });
});
