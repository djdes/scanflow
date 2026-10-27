import { onecNomenclatureRepo, OnecNomenclatureInput } from '../database/repositories/onecNomenclatureRepo';
import { syncStateRepo } from '../database/repositories/syncStateRepo';
import { NomenclatureMapper } from '../mapping/nomenclatureMapper';
import { runAfterCatalogSync } from '../services/catalogSyncWatcher';
import { logger } from '../utils/logger';
import { logIntegrationEvent } from './integrationLog';
import { parseOnecMcpConfig } from './onecUsage';

export const DEFAULT_EXCLUDED_CATEGORIES = [
  'Списанное',
  'Резерв Сезонное',
  'SubExpress-Архив',
  'РЕЗЕРВ',
  'ПРОРАБОТКА',
];

export const CATALOG_PAGE_SIZE = 1000;
const MAX_PAGES = 50;
const TIMEOUT_MS = 20_000;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZERO_GUID = '00000000-0000-0000-0000-000000000000';

export interface CatalogMcpSource {
  url: string;
  user: string;
  password: string;
  excludedCategories: string[];
}

export interface CatalogSyncResult {
  ownerUserId: number;
  upserted: number;
  deleted: number;
  items: number;
  folders: number;
}

interface RawSourceConfig {
  url?: string;
  catalogUrl?: string;
  user?: string;
  password?: string;
  excludedCategories?: string[];
}

interface McpQueryResponse {
  columns?: string[];
  rows?: unknown[][];
  row_count?: number;
  error?: string;
}

let defaultMapper: NomenclatureMapper | null = null;
const inflightSyncs = new Map<number, Promise<CatalogSyncResult>>();

export function setCatalogMcpMapper(mapper: NomenclatureMapper | null): void {
  defaultMapper = mapper;
}

function rawConfigJson(): string | undefined {
  return process.env.ONEC_CATALOG_MCP_CONFIG || process.env.ONEC_USAGE_MCP_CONFIG;
}

/**
 * Возвращает настройки HTTP-сервиса feenlace/mcp-1c для синхронизации каталога
 * конкретной компании, либо null, если для компании не настроен HTTP-источник с user.
 */
export function catalogMcpSource(ownerUserId: number): CatalogMcpSource | null {
  const raw = rawConfigJson();
  if (!raw || !Number.isSafeInteger(ownerUserId) || ownerUserId <= 0) return null;
  const all = parseOnecMcpConfig<RawSourceConfig>(raw);
  const source = all?.[String(ownerUserId)];
  if (!source || !source.user?.trim()) return null;
  const rawUrl = source.catalogUrl || source.url;
  if (!rawUrl) throw new Error('Invalid 1C catalog MCP source URL');
  const parsed = new URL(rawUrl);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Invalid 1C catalog MCP source configuration');
  }
  const excludedCategories = Array.isArray(source.excludedCategories) && source.excludedCategories.length > 0
    ? source.excludedCategories.map(c => String(c).trim()).filter(Boolean)
    : DEFAULT_EXCLUDED_CATEGORIES;
  if (excludedCategories.some(c => c.includes('"') || /[\r\n]/.test(c))) {
    throw new Error('Invalid excluded category name in 1C catalog MCP configuration');
  }
  return {
    url: parsed.href.replace(/\/+$/, ''),
    user: source.user.trim(),
    password: String(source.password ?? ''),
    excludedCategories,
  };
}

/** Список ID компаний, у которых настроен MCP-источник каталога 1С. */
export function configuredCatalogMcpOwners(): number[] {
  const raw = rawConfigJson();
  if (!raw) return [];
  try {
    const all = parseOnecMcpConfig<RawSourceConfig>(raw);
    if (!all) return [];
    const owners: number[] = [];
    for (const key of Object.keys(all)) {
      const owner = Number(key);
      if (Number.isSafeInteger(owner) && owner > 0 && catalogMcpSource(owner)) {
        owners.push(owner);
      }
    }
    return owners;
  } catch {
    return [];
  }
}

export function buildCatalogPageQuery(
  firstPage: boolean,
  excludedCategories: string[] = DEFAULT_EXCLUDED_CATEGORIES,
): string {
  if (excludedCategories.some(c => c.includes('"') || /[\r\n]/.test(c))) {
    throw new Error('Invalid excluded category name');
  }
  const codeCompare = firstPage ? 'Номенклатура.Код >= &AfterCode' : 'Номенклатура.Код > &AfterCode';
  const categoryFilter = excludedCategories.length > 0
    ? `\n  И (Номенклатура.ЭтоГруппа
    ИЛИ Номенклатура.КатегорияНоменклатуры = ЗНАЧЕНИЕ(Справочник.КатегорииНоменклатуры.ПустаяСсылка)
    ИЛИ НЕ Номенклатура.КатегорияНоменклатуры.Наименование В (${excludedCategories.map(c => `"${c}"`).join(', ')}))`
    : '';
  return `ВЫБРАТЬ
  УникальныйИдентификатор(Номенклатура.Ссылка) КАК guid,
  УникальныйИдентификатор(Номенклатура.Родитель) КАК parent_guid,
  ЕСТЬNULL(Номенклатура.Код, "") КАК code,
  ЕСТЬNULL(Номенклатура.Наименование, "") КАК name,
  ЕСТЬNULL(Номенклатура.НаименованиеПолное, "") КАК full_name,
  ЕСТЬNULL(Номенклатура.ЕдиницаИзмерения.Наименование, "") КАК unit,
  Номенклатура.ЭтоГруппа КАК is_folder
ИЗ Справочник.Номенклатура КАК Номенклатура
ГДЕ НЕ Номенклатура.ПометкаУдаления
  И ${codeCompare}${categoryFilter}
УПОРЯДОЧИТЬ ПО
  Номенклатура.Код ВОЗР`;
}

export async function fetchCatalogFromMcp(ownerUserId: number): Promise<OnecNomenclatureInput[]> {
  const source = catalogMcpSource(ownerUserId);
  if (!source) throw new Error(`1C catalog MCP source not configured for company ${ownerUserId}`);

  const auth = Buffer.from(`${source.user}:${source.password}`, 'utf8').toString('base64');
  const byGuid = new Map<string, OnecNomenclatureInput>();
  let afterCode = '';

  for (let page = 0; page < MAX_PAGES; page++) {
    const query = buildCatalogPageQuery(page === 0, source.excludedCategories);
    const res = await fetch(`${source.url}/query`, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        query,
        parameters: { AfterCode: afterCode },
        limit: CATALOG_PAGE_SIZE,
      }),
    });
    if (!res.ok) {
      throw new Error(`1C catalog MCP HTTP ${res.status}`);
    }
    const payload = (await res.json()) as McpQueryResponse;
    if (payload.error) {
      throw new Error(`1C catalog MCP query error: ${payload.error}`);
    }
    const cols = payload.columns;
    const rows = payload.rows;
    if (!Array.isArray(cols) || !Array.isArray(rows)) {
      throw new Error('Invalid 1C catalog MCP response format');
    }

    const idxGuid = cols.indexOf('guid');
    const idxParent = cols.indexOf('parent_guid');
    const idxCode = cols.indexOf('code');
    const idxName = cols.indexOf('name');
    const idxFullName = cols.indexOf('full_name');
    const idxUnit = cols.indexOf('unit');
    const idxIsFolder = cols.indexOf('is_folder');
    if (idxGuid < 0 || idxCode < 0 || idxName < 0 || idxIsFolder < 0) {
      throw new Error('Missing required columns in 1C catalog MCP response');
    }

    let lastRawCode = afterCode;
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      const guid = String(row[idxGuid] ?? '').trim().toLowerCase();
      const rawCode = String(row[idxCode] ?? '');
      const name = String(row[idxName] ?? '').trim();
      lastRawCode = rawCode;
      if (!GUID_RE.test(guid) || !name) continue;
      const rawParent = idxParent >= 0 ? String(row[idxParent] ?? '').trim().toLowerCase() : '';
      const parentGuid = GUID_RE.test(rawParent) && rawParent !== ZERO_GUID ? rawParent : null;
      const fullName = idxFullName >= 0 ? String(row[idxFullName] ?? '').trim() : '';
      const unit = idxUnit >= 0 ? String(row[idxUnit] ?? '').trim() : '';
      const isFolder = Boolean(row[idxIsFolder]);

      byGuid.set(guid, {
        guid,
        code: rawCode.trim() || null,
        name,
        full_name: fullName || null,
        unit: unit || null,
        parent_guid: parentGuid,
        is_folder: isFolder,
        is_weighted: false,
      });
    }

    if (rows.length < CATALOG_PAGE_SIZE) break;
    if (lastRawCode === afterCode) {
      throw new Error('1C catalog MCP pagination cursor did not advance');
    }
    afterCode = lastRawCode;
  }

  const items = [...byGuid.values()];
  if (items.length === 0) {
    throw new Error('1C catalog MCP returned 0 items');
  }
  return items;
}

export async function syncCatalogFromMcp(
  ownerUserId: number,
  mapper?: NomenclatureMapper | null,
  reason = 'manual',
): Promise<CatalogSyncResult> {
  const existing = inflightSyncs.get(ownerUserId);
  if (existing) return existing;

  const task = (async (): Promise<CatalogSyncResult> => {
    const items = await fetchCatalogFromMcp(ownerUserId);
    const foldersCount = items.filter(i => i.is_folder).length;
    const itemsCount = items.length - foldersCount;

    const { deleted, upserted } = await onecNomenclatureRepo.replaceAll(items, ownerUserId);
    const activeMapper = mapper ?? defaultMapper;
    activeMapper?.invalidateCache(ownerUserId);

    await runAfterCatalogSync(ownerUserId);

    try {
      const st = await syncStateRepo.getNomenclatureSyncState(ownerUserId);
      if (st.requested && st.since) {
        await syncStateRepo.clearNomenclatureSync(st.since, ownerUserId);
      }
    } catch (err) {
      logger.warn('Failed to clear nomenclature sync flag after MCP sync', {
        ownerUserId,
        error: (err as Error).message,
      });
    }

    logger.info('1C nomenclature catalog synced via MCP', {
      ownerUserId,
      reason,
      upserted,
      deleted,
      items: itemsCount,
      folders: foldersCount,
    });

    void logIntegrationEvent({
      integration: 'nomenclature',
      event_type: 'catalog_synced',
      owner_user_id: ownerUserId,
      summary: `Каталог 1С синхронизирован по MCP (${reason}): ${itemsCount} товаров, ${foldersCount} папок`,
      detail: { source: 'mcp', reason, upserted, deleted, items: itemsCount, folders: foldersCount },
    });

    return {
      ownerUserId,
      upserted,
      deleted,
      items: itemsCount,
      folders: foldersCount,
    };
  })();

  inflightSyncs.set(ownerUserId, task);
  try {
    return await task;
  } finally {
    if (inflightSyncs.get(ownerUserId) === task) {
      inflightSyncs.delete(ownerUserId);
    }
  }
}

export async function syncAllCatalogsFromMcp(
  mapper?: NomenclatureMapper | null,
  reason = 'cron',
): Promise<CatalogSyncResult[]> {
  const owners = configuredCatalogMcpOwners();
  const results: CatalogSyncResult[] = [];
  for (const owner of owners) {
    try {
      results.push(await syncCatalogFromMcp(owner, mapper, reason));
    } catch (err) {
      logger.error('1C catalog MCP sync failed', {
        ownerUserId: owner,
        reason,
        error: (err as Error).message,
      });
    }
  }
  return results;
}
