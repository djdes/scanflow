import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildUsageCode, getOnecUsage, parseUsageRows, parseUsageRpc, resetOnecUsageCache, usageSource } from '../../src/integration/onecUsage';

vi.mock('../../src/utils/logger', () => ({ logger: { warn: vi.fn() } }));
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const source = { url: 'http://onec.test/mcp', token: 'test-only' };
const rpc = (rows: unknown, success = true) => ({ result: { content: [{ type: 'text', text: JSON.stringify({ success, data: JSON.stringify(JSON.stringify(rows)) }) }] } });
let calls: unknown[];

beforeEach(() => {
  resetOnecUsageCache(); calls = [];
  vi.stubEnv('ONEC_USAGE_MCP_CONFIG', JSON.stringify({ 3: source, 4: source }));
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body); calls.push(body);
    return new Response(body.method === 'tools/call'
      ? JSON.stringify(rpc(body.params.arguments.code.includes(A) ? [{ guid: A, kind: 1, count: 2 }, { guid: A, kind: 2, count: 3 }] : []))
      : body.method === 'initialize' ? JSON.stringify({ result: {} }) : '', { status: 200, headers: { 'mcp-session-id': 'test' } });
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('MCP statistics', () => {
  it('caches counts and genuine zeroes; separates owners even with the same endpoint', async () => {
    const first = await getOnecUsage(3, [A, B]);
    expect(first.available).toBe(true);
    expect(first.rows.get(A)).toMatchObject({ specifications: 2, receipts: 3 });
    expect(first.rows.get(B)).toMatchObject({ specifications: 0, receipts: 0 });
    await getOnecUsage(3, [B, A]);
    expect(calls).toHaveLength(3);
    await getOnecUsage(4, [A]);
    expect(calls).toHaveLength(6);
  });
  it('has no fallback to another company connection', async () => {
    expect(usageSource(1)).toBeNull();
    expect(await getOnecUsage(1, [A])).toMatchObject({ available: false, reason: 'not_configured' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('coalesces simultaneous requests and serializes disjoint batches', async () => {
    const results = await Promise.all([getOnecUsage(3, [A]), getOnecUsage(3, [A, B]), getOnecUsage(3, [A])]);
    expect(results.every(r => r.available)).toBe(true);
    expect(calls).toHaveLength(6);
  });
  it('refreshes expired counts and checks every candidate in bounded batches', async () => {
    vi.useFakeTimers();
    await getOnecUsage(3, [A]);
    vi.setSystemTime(Date.now() + 60 * 60_000 + 1);
    expect((await getOnecUsage(3, [A])).available).toBe(true);
    expect(calls).toHaveLength(6);
    resetOnecUsageCache(); calls = [];
    const guids = Array.from({ length: 41 }, (_, i) => `${i.toString(16).padStart(8, '0')}-aaaa-bbbb-cccc-000000000000`);
    const result = await getOnecUsage(3, guids);
    expect(result.available).toBe(true);
    expect(result.rows.size).toBe(41);
    expect(calls).toHaveLength(6);
  });
  it('does not cache failures as zeroes or retry a failing server for every row', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    expect(await getOnecUsage(3, [A])).toMatchObject({ available: false, reason: 'unavailable' });
    expect(await getOnecUsage(3, [B])).toMatchObject({ available: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects partial, duplicate, unrelated and negative results', () => {
    for (const rows of [[{ guid: B, kind: 1, count: 1 }], [{ guid: A, kind: 1, count: -1 }], [{ guid: A, kind: 1, count: 1 }, { guid: A, kind: 1, count: 2 }]]) {
      expect(() => parseUsageRows(rpc(rows), [A])).toThrow();
    }
    expect(() => parseUsageRows(rpc([], false), [A])).toThrow();
  });
  it('reads SSE notifications before the tool result', () => {
    const expected = rpc([]);
    const raw = `event: message\ndata: {"method":"notifications/progress"}\n\nevent: message\ndata: ${JSON.stringify(expected)}\n\n`;
    expect(parseUsageRpc(raw)).toEqual(expected);
  });
  it('uses distinct document references over full history; validates interpolated GUIDs', () => {
    const code = buildUsageCode([A]);
    expect(code).toContain('КОЛИЧЕСТВО(РАЗЛИЧНЫЕ С.Ссылка)');
    expect(code).toContain('КОЛИЧЕСТВО(РАЗЛИЧНЫЕ П.Ссылка)');
    expect(code).toContain('П.Ссылка.Проведен');
    expect(code).not.toContain('Дата >');
    expect(() => buildUsageCode(['"; Выполнить("bad")'])).toThrow();
    expect(() => buildUsageCode(Array(41).fill(A))).toThrow();
  });
});
