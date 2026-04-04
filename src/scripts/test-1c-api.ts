/**
 * Integration test for 1C API flow
 * Simulates the complete 1C external processing workflow:
 *   1. GET /health — check connectivity
 *   2. GET /api/invoices/pending — fetch invoices ready for 1C
 *   3. GET /api/invoices/:id — get invoice with items
 *   4. POST /api/invoices/:id/confirm — mark as sent_to_1c
 *
 * Also tests error cases:
 *   - 404 for non-existent invoice
 *   - Auth required for API endpoints
 *   - Double confirm (idempotency)
 *
 * Prerequisites: server must be running (npm run dev)
 * Usage: npm run test:1c-api
 */
import '../config';
import { config } from '../config';

// Allow overriding target via env vars for running against prod:
//   BASE_URL=https://scan.magday.ru API_KEY=... npx ts-node src/scripts/test-1c-api.ts
const BASE_URL = process.env.BASE_URL || `http://localhost:${config.apiPort}`;
const API_KEY = process.env.API_KEY || config.apiKey;

let passCount = 0;
let failCount = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passCount++;
  } else {
    console.log(`  ❌ FAIL: ${message}`);
    failCount++;
  }
}

async function fetchApi(path: string, options: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };
  if (!path.startsWith('/health')) {
    headers['X-API-Key'] = API_KEY;
  }
  return fetch(`${BASE_URL}${path}`, { ...options, headers });
}

// ============================================================
// Test 1: Health check (no auth required)
// ============================================================
async function testHealth(): Promise<void> {
  console.log('\n=== Test 1: Health check ===');

  const res = await fetch(`${BASE_URL}/health`);
  assert(res.ok, `GET /health returns 200, got ${res.status}`);

  const body = await res.json() as { status: string; timestamp: string };
  assert(body.status === 'ok', `Status is "ok": "${body.status}"`);
  assert(!!body.timestamp, `Has timestamp: "${body.timestamp}"`);
}

// ============================================================
// Test 2: Auth required
// ============================================================
async function testAuthRequired(): Promise<void> {
  console.log('\n=== Test 2: Auth required for API ===');

  const res = await fetch(`${BASE_URL}/api/invoices`);
  assert(res.status === 401, `GET /api/invoices without key returns 401, got ${res.status}`);

  const body = await res.json() as { error: string };
  assert(!!body.error, `Error message present: "${body.error}"`);
}

// ============================================================
// Test 3: GET /api/invoices/pending
// ============================================================
async function testPending(): Promise<{ pendingCount: number; firstId: number | null }> {
  console.log('\n=== Test 3: GET /api/invoices/pending ===');

  const res = await fetchApi('/api/invoices/pending');
  assert(res.ok, `Returns 200, got ${res.status}`);

  const body = await res.json() as { data: any[]; count: number };
  assert(Array.isArray(body.data), 'Response has data array');
  assert(typeof body.count === 'number', `Has count: ${body.count}`);

  if (body.data.length > 0) {
    const first = body.data[0];
    assert(!!first.id, `First invoice has id: ${first.id}`);
    assert(!!first.invoice_number || first.invoice_number === null, `Has invoice_number field`);
    assert(Array.isArray(first.items), `Has items array: ${first.items?.length} items`);

    if (first.items && first.items.length > 0) {
      const item = first.items[0];
      assert(!!item.original_name, `Item has original_name: "${item.original_name}"`);
      assert(item.quantity !== undefined || item.quantity === null, 'Item has quantity field');
      assert(item.price !== undefined || item.price === null, 'Item has price field');
    }

    console.log(`\n  📋 Found ${body.data.length} pending invoice(s)`);
    return { pendingCount: body.data.length, firstId: first.id };
  } else {
    console.log('  ℹ️  No pending invoices (need to process an image first)');
    return { pendingCount: 0, firstId: null };
  }
}

// ============================================================
// Test 4: GET /api/invoices/:id (single invoice)
// ============================================================
async function testGetInvoice(id: number): Promise<void> {
  console.log(`\n=== Test 4: GET /api/invoices/${id} ===`);

  const res = await fetchApi(`/api/invoices/${id}`);
  assert(res.ok, `Returns 200, got ${res.status}`);

  const body = await res.json() as { data: any };
  assert(!!body.data, 'Response has data');
  assert(body.data.id === id, `Invoice id matches: ${body.data.id}`);
  assert(Array.isArray(body.data.items), `Has items: ${body.data.items?.length}`);
  assert(typeof body.data.status === 'string', `Has status: "${body.data.status}"`);
  assert(typeof body.data.total_sum === 'number' || body.data.total_sum === null,
    `Has total_sum: ${body.data.total_sum}`);

  console.log(`  📄 Invoice #${body.data.invoice_number || 'N/A'} from ${body.data.supplier || 'unknown'}`);
  console.log(`     Status: ${body.data.status}, Items: ${body.data.items.length}, Total: ${body.data.total_sum}`);
}

// ============================================================
// Test 5: GET /api/invoices/:id — 404 for non-existent
// ============================================================
async function testNotFound(): Promise<void> {
  console.log('\n=== Test 5: 404 for non-existent invoice ===');

  const res = await fetchApi('/api/invoices/999999');
  assert(res.status === 404, `Returns 404, got ${res.status}`);

  const body = await res.json() as { error: string };
  assert(!!body.error, `Error message present: "${body.error}"`);
}

// ============================================================
// Test 6: POST /api/invoices/:id/confirm
// ============================================================
async function testConfirm(id: number): Promise<void> {
  console.log(`\n=== Test 6: POST /api/invoices/${id}/confirm ===`);

  const res = await fetchApi(`/api/invoices/${id}/confirm`, { method: 'POST' });
  assert(res.ok, `Returns 200, got ${res.status}`);

  const body = await res.json() as { data: { id: number; status: string } };
  assert(body.data.id === id, `Confirmed id: ${body.data.id}`);
  assert(body.data.status === 'sent_to_1c', `Status changed to sent_to_1c: "${body.data.status}"`);

  // Verify in the full invoice endpoint
  const verifyRes = await fetchApi(`/api/invoices/${id}`);
  const verifyBody = await verifyRes.json() as { data: any };
  assert(verifyBody.data.status === 'sent_to_1c', `Verified status is sent_to_1c: "${verifyBody.data.status}"`);
  assert(!!verifyBody.data.sent_at, `Has sent_at timestamp: "${verifyBody.data.sent_at}"`);
}

// ============================================================
// Test 7: Double confirm (idempotency)
// ============================================================
async function testDoubleConfirm(id: number): Promise<void> {
  console.log(`\n=== Test 7: Double confirm (idempotency) ===`);

  const res = await fetchApi(`/api/invoices/${id}/confirm`, { method: 'POST' });
  assert(res.ok, `Second confirm returns 200, got ${res.status}`);

  const body = await res.json() as { data: { id: number; status: string } };
  assert(body.data.status === 'sent_to_1c', `Status still sent_to_1c: "${body.data.status}"`);
}

// ============================================================
// Test 8: Stats endpoint
// ============================================================
async function testStats(): Promise<void> {
  console.log('\n=== Test 8: GET /api/invoices/stats ===');

  const res = await fetchApi('/api/invoices/stats');
  assert(res.ok, `Returns 200, got ${res.status}`);

  const body = await res.json() as { data: { byStatus: any[]; total: number } };
  assert(Array.isArray(body.data.byStatus), 'Has byStatus array');
  assert(typeof body.data.total === 'number', `Has total: ${body.data.total}`);

  console.log(`  📊 Total invoices: ${body.data.total}`);
  for (const s of body.data.byStatus) {
    console.log(`     ${s.status}: ${s.count}`);
  }
}

// ============================================================
// Run all tests
// ============================================================
async function main(): Promise<void> {
  console.log('1C API Integration Tests');
  console.log(`Server: ${BASE_URL}`);
  console.log('========================');

  try {
    await testHealth();
    await testAuthRequired();
    const { firstId } = await testPending();
    await testNotFound();
    await testStats();

    if (firstId) {
      await testGetInvoice(firstId);
      await testConfirm(firstId);
      await testDoubleConfirm(firstId);
    } else {
      console.log('\n  ⚠️  Skipping confirm tests (no pending invoices)');
      console.log('  To test: process an image first via POST /api/upload');

      // Try to find any invoice for basic get test
      const listRes = await fetchApi('/api/invoices?limit=1');
      const listBody = await listRes.json() as { data: any[] };
      if (listBody.data.length > 0) {
        await testGetInvoice(listBody.data[0].id);
      }
    }

    console.log('\n========================');
    console.log(`Results: ${passCount} passed, ${failCount} failed`);

    if (failCount > 0) {
      process.exit(1);
    }
  } catch (err: any) {
    if (err.cause?.code === 'ECONNREFUSED') {
      console.error('\n❌ Could not connect to server at', BASE_URL);
      console.error('   Start the server first: npm run dev');
      process.exit(1);
    }
    throw err;
  }
}

main().catch(console.error);
