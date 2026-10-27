import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCatalogPageQuery,
  catalogMcpSource,
  configuredCatalogMcpOwners,
  fetchCatalogFromMcp,
  syncCatalogFromMcp,
} from '../../src/integration/onecCatalogMcp';
import { onecNomenclatureRepo } from '../../src/database/repositories/onecNomenclatureRepo';
import { syncStateRepo } from '../../src/database/repositories/syncStateRepo';
import { runAfterCatalogSync } from '../../src/services/catalogSyncWatcher';

vi.mock('../../src/utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../src/integration/integrationLog', () => ({ logIntegrationEvent: vi.fn() }));
vi.mock('../../src/database/repositories/onecNomenclatureRepo', () => ({
  onecNomenclatureRepo: { replaceAll: vi.fn() },
}));
vi.mock('../../src/database/repositories/syncStateRepo', () => ({
  syncStateRepo: {
    getNomenclatureSyncState: vi.fn(),
    clearNomenclatureSync: vi.fn(),
  },
}));
vi.mock('../../src/services/catalogSyncWatcher', () => ({
  runAfterCatalogSync: vi.fn(),
}));

const FOLDER_GUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ITEM_GUID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ZERO_GUID = '00000000-0000-0000-0000-000000000000';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ONEC_USAGE_MCP_CONFIG', JSON.stringify({
    1: { url: 'http://onec-mag.test/mcp-1c/hs/mcp-1c', user: 'Админ' },
    3: { url: 'http://onec-sub.test/mcp-1c-subprod/hs/mcp-1c', user: 'Директор' },
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('1C MCP catalog synchronization', () => {
  it('parses configured MCP catalog sources per company without cross-tenant fallback', () => {
    expect(configuredCatalogMcpOwners()).toEqual([1, 3]);
    expect(catalogMcpSource(1)).toMatchObject({
      url: 'http://onec-mag.test/mcp-1c/hs/mcp-1c',
      user: 'Админ',
    });
    expect(catalogMcpSource(2)).toBeNull();
  });

  it('auto-upgrades legacy :6003/mcp single-company config to feenlace/mcp-1c for companies 1 (MAG) and 3 (SUB)', () => {
    vi.stubEnv('ONEC_USAGE_MCP_CONFIG', JSON.stringify({
      3: { url: 'http://onec-lan.test:6003/mcp', token: 'legacy-token' },
    }));
    expect(configuredCatalogMcpOwners()).toEqual([1, 3]);
    expect(catalogMcpSource(1)).toMatchObject({
      url: 'http://onec-lan.test/mcp-1c/hs/mcp-1c',
      user: 'Админ',
    });
    expect(catalogMcpSource(3)).toMatchObject({
      url: 'http://onec-lan.test/mcp-1c-subprod/hs/mcp-1c',
      user: 'Директор',
    });
  });

  it('includes folders and excludes only archived categories in the 1C query', () => {
    const q = buildCatalogPageQuery(true);
    expect(q).toContain('Номенклатура.ЭтоГруппа');
    expect(q).toContain('НЕ Номенклатура.КатегорияНоменклатуры.Наименование В');
    expect(q).toContain('"Списанное"');
    expect(q).toContain('Номенклатура.Код >= &AfterCode');
    expect(buildCatalogPageQuery(false)).toContain('Номенклатура.Код > &AfterCode');
  });

  it('fetches items and folders, normalizes zero parent_guid to null, and replaces company catalog atomically', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      columns: ['guid', 'parent_guid', 'code', 'name', 'full_name', 'unit', 'is_folder'],
      rows: [
        [FOLDER_GUID.toUpperCase(), ZERO_GUID, '00-00000001', 'Сырье', '', '', true],
        [ITEM_GUID.toUpperCase(), FOLDER_GUID, '00-00000002', 'Молоко 3,2%', 'Молоко ультрапастеризованное 3,2%', 'л', false],
      ],
      row_count: 2,
    }), { status: 200 })));

    vi.mocked(onecNomenclatureRepo.replaceAll).mockResolvedValue({ deleted: 10, upserted: 2 });
    vi.mocked(syncStateRepo.getNomenclatureSyncState).mockResolvedValue({ requested: true, since: '2026-10-27 12:00:00' });
    vi.mocked(syncStateRepo.clearNomenclatureSync).mockResolvedValue({ cleared: true });

    const items = await fetchCatalogFromMcp(1);
    expect(items).toEqual([
      {
        guid: FOLDER_GUID,
        parent_guid: null,
        code: '00-00000001',
        name: 'Сырье',
        full_name: null,
        unit: null,
        is_folder: true,
        is_weighted: false,
      },
      {
        guid: ITEM_GUID,
        parent_guid: FOLDER_GUID,
        code: '00-00000002',
        name: 'Молоко 3,2%',
        full_name: 'Молоко ультрапастеризованное 3,2%',
        unit: 'л',
        is_folder: false,
        is_weighted: false,
      },
    ]);

    const fakeMapper = { invalidateCache: vi.fn() };
    const result = await syncCatalogFromMcp(1, fakeMapper as never, 'test');
    expect(result).toEqual({
      ownerUserId: 1,
      upserted: 2,
      deleted: 10,
      items: 1,
      folders: 1,
    });
    expect(onecNomenclatureRepo.replaceAll).toHaveBeenCalledWith(items, 1);
    expect(fakeMapper.invalidateCache).toHaveBeenCalledWith(1);
    expect(runAfterCatalogSync).toHaveBeenCalledWith(1);
    expect(syncStateRepo.clearNomenclatureSync).toHaveBeenCalledWith('2026-10-27 12:00:00', 1);
  });

  it('refuses to wipe the catalog if MCP returns an empty list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      columns: ['guid', 'parent_guid', 'code', 'name', 'full_name', 'unit', 'is_folder'],
      rows: [],
      row_count: 0,
    }), { status: 200 })));

    await expect(syncCatalogFromMcp(3)).rejects.toThrow(/0 items/);
    expect(onecNomenclatureRepo.replaceAll).not.toHaveBeenCalled();
  });
});
