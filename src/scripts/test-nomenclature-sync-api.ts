/**
 * Integration test for /api/nomenclature/* endpoints.
 * Prerequisites: server must be running on localhost:{API_PORT}.
 * Usage: BASE_URL=http://localhost:3000 API_KEY=your-secret-api-key npx ts-node src/scripts/test-nomenclature-sync-api.ts
 */
import '../config';
import { config } from '../config';

const BASE_URL = process.env.BASE_URL || `http://localhost:${config.apiPort}`;
const API_KEY = process.env.API_KEY || config.apiKey;

let passCount = 0;
let failCount = 0;
function assert(condition: boolean, message: string): void {
  if (condition) { console.log(`  ✅ ${message}`); passCount++; }
  else { console.log(`  ❌ FAIL: ${message}`); failCount++; }
}

async function fetchApi(path: string, options: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-API-Key': API_KEY,
    ...((options.headers as Record<string, string>) || {}),
  };
  return fetch(`${BASE_URL}${path}`, { ...options, headers });
}

async function main(): Promise<void> {
  console.log('Nomenclature sync API tests');
  console.log(`Server: ${BASE_URL}`);
  console.log('===========================');

  console.log('\n=== POST /api/nomenclature/sync upserts batch ===');
  const syncRes = await fetchApi('/api/nomenclature/sync', {
    method: 'POST',
    body: JSON.stringify({
      items: [
        { guid: 'test-api-1', code: 'НФ-TST1', name: 'Test Картофель', unit: 'кг', is_folder: false, is_weighted: true },
        { guid: 'test-api-2', code: 'НФ-TST2', name: 'Test Морковь', unit: 'кг', is_folder: false, is_weighted: true },
        { guid: 'test-api-grp', code: null, name: 'Test Овощи', is_folder: true, is_weighted: false },
      ],
    }),
  });
  assert(syncRes.ok, `sync returns 2xx, got ${syncRes.status}`);
  const syncBody = await syncRes.json() as { data: { upserted: number; total: number } };
  assert(syncBody.data.upserted === 3, `upserted 3, got ${syncBody.data.upserted}`);

  console.log('\n=== GET /api/nomenclature/stats ===');
  const statsRes = await fetchApi('/api/nomenclature/stats');
  const statsBody = await statsRes.json() as { data: { total: number; folders: number; items: number; last_synced_at: string | null } };
  assert(statsBody.data.total >= 3, `total ≥ 3, got ${statsBody.data.total}`);
  assert(statsBody.data.last_synced_at !== null, 'last_synced_at populated');

  console.log('\n=== GET /api/nomenclature?exclude_folders=true ===');
  const listRes = await fetchApi('/api/nomenclature?exclude_folders=true');
  const listBody = await listRes.json() as { data: Array<{ guid: string; is_folder: number }>; count: number };
  const testRows = listBody.data.filter(r => r.guid.startsWith('test-api-'));
  assert(testRows.every(r => r.is_folder === 0), 'all returned rows are non-folders');
  assert(testRows.length === 2, `returned 2 test items, got ${testRows.length}`);

  console.log('\n=== POST sync rejects empty body ===');
  const badRes = await fetchApi('/api/nomenclature/sync', { method: 'POST', body: JSON.stringify({}) });
  assert(badRes.status === 400, `empty body → 400, got ${badRes.status}`);

  console.log('\n=== POST sync rejects whitespace-only guid ===');
  const wsRes = await fetchApi('/api/nomenclature/sync', {
    method: 'POST',
    body: JSON.stringify({
      items: [{ guid: '   ', name: 'Valid Name', is_folder: false, is_weighted: false }],
    }),
  });
  assert(wsRes.status === 400, `whitespace guid → 400, got ${wsRes.status}`);

  console.log('\n=== POST sync rejects whitespace-only name ===');
  const wsNameRes = await fetchApi('/api/nomenclature/sync', {
    method: 'POST',
    body: JSON.stringify({
      items: [{ guid: 'valid-guid-xyz', name: '   ', is_folder: false, is_weighted: false }],
    }),
  });
  assert(wsNameRes.status === 400, `whitespace name → 400, got ${wsNameRes.status}`);

  // Cleanup via direct DB access
  const { getDb } = await import('../database/db');
  const db = getDb();
  db.prepare("DELETE FROM onec_nomenclature WHERE guid LIKE 'test-api-%'").run();

  console.log(`\n===========================`);
  console.log(`Results: ${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
}

main().catch(err => {
  if (err?.cause?.code === 'ECONNREFUSED') {
    console.error('\n❌ Could not connect to server at', BASE_URL);
    console.error('   Start the server first: npm run dev');
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
