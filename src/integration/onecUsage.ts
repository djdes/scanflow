import { createHash } from 'node:crypto';
import { onecNomenclatureRepo } from '../database/repositories/onecNomenclatureRepo';
import { logger } from '../utils/logger';

export interface OnecUsage {
  specifications: number;
  receipts: number;
}

export interface UsageSnapshot {
  available: boolean;
  checkedAt: string | null;
  rows: Map<string, OnecUsage>;
  reason?: 'not_configured' | 'unavailable';
}

export interface Source {
  url: string;
  token?: string;
  user?: string;
  password?: string;
}
interface Cached extends OnecUsage { checkedAt: string; expires: number }
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_CODE = /^[\p{L}\p{N}\s._/-]{1,32}$/u;
export const USAGE_BATCH_SIZE = 40;
const CACHE_MS = 60 * 60_000;
const FAILURE_MS = 60_000;
const TIMEOUT_MS = 12_000;
const cache = new Map<string, Map<string, Cached>>();
const failedUntil = new Map<string, number>();
const pending = new Map<string, Promise<void>>();

/**
 * Разбирает ONEC_USAGE_MCP_CONFIG. Если в окружении осталась старая запись
 * ROCTUP (:6003/mcp или :6004/mcp без user), автоматически переключает обе
 * боевые компании (1 = MAG, 3 = SUB) на прямые HTTP-сервисы feenlace/mcp-1c
 * на том же хосте 1С.
 */
export function parseOnecMcpConfig<T extends { url?: string; user?: string; token?: string }>(
  raw: string | undefined,
): Record<string, T> | null {
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Record<string, T>;
  const legacyEntry = Object.values(parsed).find(
    e => typeof e?.url === 'string' && /:600[34]\/mcp\b/.test(e.url) && !e.user,
  );
  if (legacyEntry?.url) {
    const host = new URL(legacyEntry.url).hostname;
    return {
      ...parsed,
      '1': { url: `http://${host}/mcp-1c/hs/mcp-1c`, user: 'Админ' } as unknown as T,
      '3': { url: `http://${host}/mcp-1c-subprod/hs/mcp-1c`, user: 'Директор' } as unknown as T,
    };
  }
  return parsed;
}

export function configuredUsageOwners(): number[] {
  const all = parseOnecMcpConfig<Source>(process.env.ONEC_USAGE_MCP_CONFIG);
  if (!all) return [];
  return Object.keys(all)
    .map(k => Number(k))
    .filter(id => Number.isSafeInteger(id) && id > 0);
}

/** Нет общего подключения: один и тот же GUID в двух компаниях не означает общие данные. */
export function usageSource(ownerUserId: number): Source | null {
  const raw = process.env.ONEC_USAGE_MCP_CONFIG;
  if (!raw || !Number.isSafeInteger(ownerUserId) || ownerUserId <= 0) return null;
  const all = parseOnecMcpConfig<Source>(raw);
  const source = all?.[String(ownerUserId)];
  if (!source) return null;
  const url = new URL(source.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Invalid 1C usage source configuration');
  }
  if (source.token?.trim()) {
    return { url: url.href, token: source.token };
  }
  if (source.user?.trim()) {
    return {
      url: url.href.replace(/\/+$/, ''),
      user: source.user.trim(),
      ...(source.password != null ? { password: String(source.password) } : {}),
    };
  }
  throw new Error('Invalid 1C usage source configuration');
}

/** Только SELECT. Ни даты, ни названия товара в текст запроса не интерполируются. */
export function buildUsageCode(guids: string[]): string {
  if (!guids.length || guids.length > USAGE_BATCH_SIZE || guids.some(g => !GUID.test(g))) {
    throw new Error('Invalid usage candidate GUIDs');
  }
  const query = `ВЫБРАТЬ С.Номенклатура КАК Номенклатура, 1 КАК Источник,
КОЛИЧЕСТВО(РАЗЛИЧНЫЕ С.Ссылка) КАК Частота
ИЗ Справочник.Спецификации.Состав КАК С
ГДЕ С.Номенклатура В (&Кандидаты) И НЕ С.Ссылка.ПометкаУдаления
СГРУППИРОВАТЬ ПО С.Номенклатура
ОБЪЕДИНИТЬ ВСЕ
ВЫБРАТЬ П.Номенклатура, 2, КОЛИЧЕСТВО(РАЗЛИЧНЫЕ П.Ссылка)
ИЗ Документ.ПриходнаяНакладная.Запасы КАК П
ГДЕ П.Номенклатура В (&Кандидаты) И П.Ссылка.Проведен И НЕ П.Ссылка.ПометкаУдаления
СГРУППИРОВАТЬ ПО П.Номенклатура`;
  return `Кандидаты = Новый Массив;
${guids.map(g => `Кандидаты.Добавить(Справочники.Номенклатура.ПолучитьСсылку(Новый УникальныйИдентификатор("${g}")));`).join('\n')}
Запрос = Новый Запрос;
Запрос.Текст = "${query.replace(/"/g, '""').replace(/\n/g, '\n|')}";
Запрос.УстановитьПараметр("Кандидаты", Кандидаты);
Выборка = Запрос.Выполнить().Выбрать();
Строки = Новый Массив;
Пока Выборка.Следующий() Цикл
 Строки.Добавить(Новый Структура("guid,kind,count", Строка(Выборка.Номенклатура.УникальныйИдентификатор()), Выборка.Источник, Выборка.Частота));
КонецЦикла;
Запись = Новый ЗаписьJSON;
Запись.УстановитьСтроку();
ЗаписатьJSON(Запись, Строки);
Результат = Запись.Закрыть();`;
}

export function buildUsageHttpQuery(codes: string[]): string {
  if (!codes.length || codes.length > USAGE_BATCH_SIZE || codes.some(c => !SAFE_CODE.test(c))) {
    throw new Error('Invalid usage candidate codes');
  }
  const list = codes.map(c => `"${c}"`).join(', ');
  return `ВЫБРАТЬ
  УникальныйИдентификатор(С.Номенклатура) КАК guid,
  1 КАК kind,
  КОЛИЧЕСТВО(РАЗЛИЧНЫЕ С.Ссылка) КАК count
ИЗ Справочник.Спецификации.Состав КАК С
ГДЕ С.Номенклатура.Код В (${list})
  И НЕ С.Ссылка.ПометкаУдаления
СГРУППИРОВАТЬ ПО
  УникальныйИдентификатор(С.Номенклатура)
ОБЪЕДИНИТЬ ВСЕ
ВЫБРАТЬ
  УникальныйИдентификатор(П.Номенклатура) КАК guid,
  2 КАК kind,
  КОЛИЧЕСТВО(РАЗЛИЧНЫЕ П.Ссылка) КАК count
ИЗ Документ.ПриходнаяНакладная.Запасы КАК П
ГДЕ П.Номенклатура.Код В (${list})
  И П.Ссылка.Проведен
  И НЕ П.Ссылка.ПометкаУдаления
СГРУППИРОВАТЬ ПО
  УникальныйИдентификатор(П.Номенклатура)`;
}

interface Rpc { result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> }; error?: unknown }

export function parseUsageRpc(raw: string): Rpc {
  // В SSE могут идти уведомления/keepalive перед ответом с result.
  const messages = raw.trim().startsWith('{') ? [raw] : raw.split(/\r?\n\r?\n/)
    .map(event => event.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n'))
    .filter(Boolean);
  for (let i = messages.length - 1; i >= 0; i--) {
    const value = JSON.parse(messages[i]) as Rpc;
    if ('result' in value || 'error' in value) return value;
  }
  throw new Error('MCP response missing');
}

export function parseUsageRows(rpc: Rpc, guids: string[]): Map<string, OnecUsage> {
  if (rpc.error || rpc.result?.isError) throw new Error('MCP usage request failed');
  const block = rpc.result?.content?.find(c => c.type === 'text');
  const outer = JSON.parse(block?.text ?? '') as { success?: boolean; data?: unknown; truncated?: boolean };
  if (outer.success !== true || outer.truncated) throw new Error('Incomplete MCP usage result');
  let data = outer.data;
  // Toolkit упаковывает строку JSON ещё в одну JSON-строку; формат зависит от настройки JSON/TOON.
  for (let i = 0; i < 3 && typeof data === 'string'; i++) data = JSON.parse(data);
  if (!Array.isArray(data) || data.length > guids.length * 2) throw new Error('Invalid MCP usage result');
  const rows = new Map(guids.map(g => [g.toLowerCase(), { specifications: 0, receipts: 0 }]));
  const seen = new Set<string>();
  for (const row of data) {
    const guid = typeof row?.guid === 'string' ? row.guid.toLowerCase() : '';
    const target = rows.get(guid);
    const key = `${guid}:${row?.kind}`;
    if (!target || ![1, 2].includes(row.kind) || !Number.isSafeInteger(row.count) || row.count < 0 || seen.has(key)) {
      throw new Error('Invalid MCP usage row');
    }
    seen.add(key);
    target[row.kind === 1 ? 'specifications' : 'receipts'] = row.count;
  }
  return rows;
}

async function readUsageViaHttpQuery(ownerUserId: number, source: Source, guids: string[]): Promise<Map<string, OnecUsage>> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const auth = Buffer.from(`${source.user ?? ''}:${source.password ?? ''}`, 'utf8').toString('base64');
  const wanted = new Set(guids.map(g => g.toLowerCase()));
  let codes: string[] = [];
  try {
    const items = await onecNomenclatureRepo.listItems({ ownerUserId, excludeFolders: true });
    if (Array.isArray(items)) {
      codes = [...new Set(
        items
          .filter(it => it?.guid && wanted.has(it.guid.toLowerCase()) && it.code && SAFE_CODE.test(it.code.trim()))
          .map(it => it.code!.trim()),
      )];
    }
  } catch {
    codes = [];
  }

  const query = codes.length > 0
    ? buildUsageHttpQuery(codes)
    : 'ВЫБРАТЬ ПЕРВЫЕ 1 УникальныйИдентификатор(Ссылка) КАК guid, 1 КАК kind, 0 КАК count ИЗ Справочник.Номенклатура ГДЕ Ложь';

  const res = await fetch(`${source.url.replace(/\/+$/, '')}/query`, {
    method: 'POST',
    signal,
    redirect: 'error',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ query, parameters: {}, limit: 1000 }),
  });
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
  const payload = (await res.json()) as { columns?: string[]; rows?: unknown[][]; error?: string };
  if (payload.error || !Array.isArray(payload.columns) || !Array.isArray(payload.rows)) {
    throw new Error('Invalid MCP query usage response');
  }

  const rows = new Map(guids.map(g => [g.toLowerCase(), { specifications: 0, receipts: 0 }]));
  const idxGuid = payload.columns.indexOf('guid');
  const idxKind = payload.columns.indexOf('kind');
  const idxCount = payload.columns.indexOf('count');
  if (idxGuid < 0 || idxKind < 0 || idxCount < 0) {
    throw new Error('Missing MCP query usage columns');
  }

  const seen = new Set<string>();
  for (const r of payload.rows) {
    if (!Array.isArray(r)) continue;
    const guid = String(r[idxGuid] ?? '').trim().toLowerCase();
    const target = rows.get(guid);
    if (!target) continue;
    const kind = Number(r[idxKind]);
    const count = Number(r[idxCount]);
    const key = `${guid}:${kind}`;
    if (![1, 2].includes(kind) || !Number.isSafeInteger(count) || count < 0 || seen.has(key)) {
      throw new Error('Invalid MCP usage row');
    }
    seen.add(key);
    target[kind === 1 ? 'specifications' : 'receipts'] = count;
  }
  return rows;
}

async function readUsage(ownerUserId: number, source: Source, guids: string[]): Promise<Map<string, OnecUsage>> {
  if (!source.token && source.user) {
    return readUsageViaHttpQuery(ownerUserId, source, guids);
  }
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let session: string | null = null;
  const post = async (body: unknown): Promise<string> => {
    const res = await fetch(source.url, {
      method: 'POST', signal, redirect: 'error',
      headers: {
        Authorization: `Bearer ${source.token}`, 'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
    session = res.headers.get('mcp-session-id') || session;
    const raw = await res.text();
    if (raw.length > 200_000) throw new Error('MCP usage response too large');
    return raw;
  };
  const init = parseUsageRpc(await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'scanflow-usage', version: '1.0.0' },
  } }));
  if (init.error || !init.result) throw new Error('MCP initialize failed');
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return parseUsageRows(parseUsageRpc(await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
    name: 'execute_code', arguments: { code: buildUsageCode(guids), execution_context: 'server' },
  } })), guids);
}

/** Кэшируются и нули; ошибка никогда не превращается в «использований нет». */
export async function getOnecUsage(ownerUserId: number, requested: string[]): Promise<UsageSnapshot> {
  const unavailable = (reason: UsageSnapshot['reason']): UsageSnapshot => ({ available: false, checkedAt: null, rows: new Map(), reason });
  let source: Source | null;
  try { source = usageSource(ownerUserId); } catch { return unavailable('unavailable'); }
  if (!source) return unavailable('not_configured');
  const guids = [...new Set(requested.map(g => g.toLowerCase()))];
  if (!guids.length || guids.some(g => !GUID.test(g))) return unavailable('unavailable');
  const secretIdentity = source.token ?? `${source.user ?? ''}:${source.password ?? ''}`;
  const key = `${ownerUserId}:${createHash('sha256').update(source.url + '\n' + secretIdentity).digest('hex')}`;
  let entries = cache.get(key);
  if (!entries) { entries = new Map(); cache.set(key, entries); }
  try {
    // Один запрос на компанию за раз; параллельный потребитель перечитывает кэш после ожидания.
    while (true) {
      const inflight = pending.get(key);
      if (inflight) { await inflight; continue; }
      const missing = guids.filter(g => (entries!.get(g)?.expires ?? 0) <= Date.now());
      if (!missing.length) break;
      if ((failedUntil.get(key) ?? 0) > Date.now()) return unavailable('unavailable');
      const batch = missing.slice(0, USAGE_BATCH_SIZE);
      const promise = (async () => {
        const rows = await readUsage(ownerUserId, source!, batch);
        const checkedAt = new Date().toISOString();
        for (const [guid, row] of rows) entries!.set(guid, { ...row, checkedAt, expires: Date.now() + CACHE_MS });
      })();
      pending.set(key, promise);
      try { await promise; } finally { if (pending.get(key) === promise) pending.delete(key); }
    }
    const rows = new Map(guids.map(g => [g, entries!.get(g)!]));
    // Самая старая проверка в наборе — честная дата для смешанного кэша.
    const checkedAt = [...rows.values()].map(r => r.checkedAt).sort()[0];
    return { available: true, checkedAt, rows };
  } catch {
    failedUntil.set(key, Date.now() + FAILURE_MS);
    logger.warn('1C usage statistics unavailable; keeping ordinary mapping', { ownerUserId });
    return unavailable('unavailable');
  }
}

export function resetOnecUsageCache(): void {
  cache.clear(); failedUntil.clear(); pending.clear();
}
