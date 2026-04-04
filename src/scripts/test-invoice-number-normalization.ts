/**
 * Test invoice number normalization for multi-page merge detection.
 * Fixes the bug where OCR read the same invoice number with different
 * Cyrillic/Latin homoglyphs on different pages, breaking merge.
 *
 * Usage: npm run test:invoice-number
 */
import '../config';
import { normalizeInvoiceNumber } from '../utils/invoiceNumber';
import { invoiceRepo } from '../database/repositories/invoiceRepo';
import { getDb } from '../database/db';

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

// ============================================================
// Test 1: Cyrillic/Latin homoglyphs
// ============================================================
function testHomoglyphs(): void {
  console.log('\n=== Test 1: Cyrillic/Latin homoglyph normalization ===');

  // The actual production bug: BM-611 (Latin) vs ВМ-611 (Cyrillic)
  assert(normalizeInvoiceNumber('BM-611') === normalizeInvoiceNumber('ВМ-611'),
    'BM-611 (Latin) === ВМ-611 (Cyrillic) after normalization');

  assert(normalizeInvoiceNumber('АВС-123') === normalizeInvoiceNumber('ABC-123'),
    'АВС-123 (Cyrillic) === ABC-123 (Latin)');

  // Cyrillic П has no Latin homoglyph, stays as П.
  // Cyrillic Н DOES have one (H), so ПН → ПH (hyphen stripped by normalization).
  assert(normalizeInvoiceNumber('ПН-457') === 'ПH457',
    'ПН-457 → ПH457 (Н→H, separator stripped, П stays)');

  // Mixed script (one letter Cyrillic, one Latin)
  assert(normalizeInvoiceNumber('BМ-611') === normalizeInvoiceNumber('ВM-611'),
    'Mixed script normalizes consistently');
}

// ============================================================
// Test 2: Case, whitespace, symbols
// ============================================================
function testCaseAndWhitespace(): void {
  console.log('\n=== Test 2: Case, whitespace, symbols ===');

  assert(normalizeInvoiceNumber('bm-611') === normalizeInvoiceNumber('BM-611'),
    'Lowercase === uppercase');

  assert(normalizeInvoiceNumber(' BM-611 ') === normalizeInvoiceNumber('BM-611'),
    'Leading/trailing whitespace stripped');

  assert(normalizeInvoiceNumber('BM 611') === normalizeInvoiceNumber('BM-611'),
    'Internal whitespace removed');

  assert(normalizeInvoiceNumber('№BM-611') === normalizeInvoiceNumber('BM-611'),
    'Leading № removed');

  assert(normalizeInvoiceNumber('#BM-611') === normalizeInvoiceNumber('BM-611'),
    'Leading # removed');
}

// ============================================================
// Test 3: Edge cases
// ============================================================
function testEdgeCases(): void {
  console.log('\n=== Test 3: Edge cases ===');

  assert(normalizeInvoiceNumber('') === '', 'Empty string returns empty');
  assert(normalizeInvoiceNumber('   ') === '', 'Whitespace-only returns empty');
  assert(normalizeInvoiceNumber('12345') === '12345', 'Pure digits unchanged');
  assert(normalizeInvoiceNumber('УПД-2026/03/23') === normalizeInvoiceNumber('УПД-2026/03/23'),
    'Idempotent on already-normalized');
}

// ============================================================
// Test 4: findRecentByNumber uses normalization
// ============================================================
function testFindRecentByNumber(): void {
  console.log('\n=== Test 4: findRecentByNumber handles homoglyphs ===');

  // Create test invoice with Latin BM-611
  const page1 = invoiceRepo.create({
    file_name: 'test-page1.jpg',
    file_path: '/tmp/test-page1.jpg',
    invoice_number: 'BM-611',
    invoice_date: '2026-03-23',
    supplier: 'ООО "Вкусный мир ТК"',
  });
  invoiceRepo.updateStatus(page1.id, 'processed');

  // Simulate page 2 arriving with Cyrillic ВМ-611
  const found = invoiceRepo.findRecentByNumber('ВМ-611', undefined, 10);
  assert(!!found, 'findRecentByNumber finds Latin BM-611 when searching for Cyrillic ВМ-611');
  assert(found?.id === page1.id, `Returns correct invoice: got id=${found?.id}, expected ${page1.id}`);

  // Also verify reverse direction
  const found2 = invoiceRepo.findRecentByNumber('BM-611', undefined, 10);
  assert(!!found2, 'findRecentByNumber finds original exact match');

  // Case insensitive match
  const found3 = invoiceRepo.findRecentByNumber('bm-611', undefined, 10);
  assert(!!found3, 'findRecentByNumber is case-insensitive');

  // Whitespace variation
  const found4 = invoiceRepo.findRecentByNumber('BM 611', undefined, 10);
  assert(!!found4, 'findRecentByNumber ignores internal whitespace');

  // Different number — should NOT match
  const notFound = invoiceRepo.findRecentByNumber('XX-999', undefined, 10);
  assert(!notFound, 'Different number correctly returns undefined');

  // Cleanup
  invoiceRepo.delete(page1.id);
}

// ============================================================
// Test 5: Supplier filter still works with normalization
// ============================================================
function testWithSupplier(): void {
  console.log('\n=== Test 5: Supplier filter compatibility ===');

  const a = invoiceRepo.create({
    file_name: 'a.jpg', file_path: '/tmp/a.jpg',
    invoice_number: 'BM-700',
    invoice_date: '2026-03-23',
    supplier: 'ООО "Алфа"',
  });
  invoiceRepo.updateStatus(a.id, 'processed');

  const b = invoiceRepo.create({
    file_name: 'b.jpg', file_path: '/tmp/b.jpg',
    invoice_number: 'BM-700',
    invoice_date: '2026-03-23',
    supplier: 'ООО "Бета"',
  });
  invoiceRepo.updateStatus(b.id, 'processed');

  // Search with supplier filter — should get only the matching one
  const foundA = invoiceRepo.findRecentByNumber('ВМ-700', 'ООО "Алфа"', 10);
  assert(foundA?.id === a.id, `Supplier "Алфа" filter: got id=${foundA?.id}, expected ${a.id}`);

  const foundB = invoiceRepo.findRecentByNumber('ВМ-700', 'ООО "Бета"', 10);
  assert(foundB?.id === b.id, `Supplier "Бета" filter: got id=${foundB?.id}, expected ${b.id}`);

  // Non-matching supplier
  const foundNone = invoiceRepo.findRecentByNumber('ВМ-700', 'ООО "Другая"', 10);
  assert(!foundNone, 'Non-matching supplier returns undefined');

  invoiceRepo.delete(a.id);
  invoiceRepo.delete(b.id);
}

// ============================================================
// Run all tests
// ============================================================
async function main(): Promise<void> {
  console.log('Invoice Number Normalization Tests');
  console.log('===================================');

  testHomoglyphs();
  testCaseAndWhitespace();
  testEdgeCases();
  testFindRecentByNumber();
  testWithSupplier();

  console.log('\n===================================');
  console.log(`Results: ${passCount} passed, ${failCount} failed`);

  getDb().close();

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
