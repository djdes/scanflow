/**
 * Test invoice number normalization for multi-page merge detection.
 * Fixes the bug where OCR read the same invoice number with different
 * Cyrillic/Latin homoglyphs on different pages, breaking merge.
 *
 * Usage: npm run test:invoice-number
 */
import '../config';
import {
  normalizeInvoiceNumber,
  extractDigitSequence,
  normalizeSupplierName,
  suppliersMatch,
  canonicalizeSupplierName,
} from '../utils/invoiceNumber';
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
// Test 4: extractDigitSequence
// ============================================================
function testExtractDigits(): void {
  console.log('\n=== Test 4: extractDigitSequence ===');

  assert(extractDigitSequence('МСМС-40626') === '40626',
    'МСМС-40626 → 40626');
  assert(extractDigitSequence('40626') === '40626',
    '40626 → 40626');
  assert(extractDigitSequence('17-0048600') === '170048600',
    '17-0048600 → 170048600 (concatenated)');
  assert(extractDigitSequence('BM-611') === '611',
    'BM-611 → 611');
  assert(extractDigitSequence('') === '', 'empty → empty');
  assert(extractDigitSequence('ABC') === '', 'no digits → empty');
  assert(extractDigitSequence(null) === '', 'null → empty');
}

// ============================================================
// Test 5: normalizeSupplierName
// ============================================================
function testNormalizeSupplier(): void {
  console.log('\n=== Test 5: normalizeSupplierName ===');

  // The 4 actual supplier strings from production that should all collapse
  // to the same canonical form "мслогистик":
  const variants = [
    'Общество с ограниченной ответственностью "МС ЛОГИСТИК"',
    'ООО "МС ЛОГИСТИК"',
    'Мс логисТИК 000',  // OCR reads three О's as three zeros
    'МС ЛОГИСТИК ООО',
  ];
  const normalized = variants.map(normalizeSupplierName);
  console.log('  Normalized variants:', normalized);

  for (let i = 1; i < normalized.length; i++) {
    assert(normalized[i] === normalized[0],
      `variant ${i} normalizes same as variant 0 ("${normalized[i]}" vs "${normalized[0]}")`);
  }

  // Basic cases
  assert(normalizeSupplierName('') === '', 'empty');
  assert(normalizeSupplierName(null) === '', 'null');
  assert(normalizeSupplierName('ИП Иванов И.И.') !== '', 'ИП preserved with name');
}

// ============================================================
// Test 6: suppliersMatch
// ============================================================
function testSuppliersMatch(): void {
  console.log('\n=== Test 6: suppliersMatch ===');

  assert(suppliersMatch(
    'Общество с ограниченной ответственностью "МС ЛОГИСТИК"',
    'Мс логисТИК 000'
  ), 'Full form matches short form');

  assert(suppliersMatch(
    'ООО "МС ЛОГИСТИК"',
    'МС ЛОГИСТИК ООО'
  ), 'Different word order matches');

  assert(suppliersMatch(
    'ООО "Вкусный мир ТК"',
    'ООО "Вкусный мир ТК"'
  ), 'Identical suppliers match');

  // Negative cases — different companies must NOT match
  assert(!suppliersMatch(
    'ООО "МС ЛОГИСТИК"',
    'ООО "Свит Лайф Фудсервис"'
  ), 'Different companies do NOT match');

  assert(!suppliersMatch('', 'ООО "Test"'),
    'Empty does not match anything');
  assert(!suppliersMatch('ООО "Test"', null),
    'null does not match anything');
}

// ============================================================
// Test 7: findRecentByNumber uses normalization
// ============================================================
function testFindRecentByNumber(): void {
  console.log('\n=== Test 7: findRecentByNumber handles homoglyphs ===');

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
  console.log('\n=== Test 8: Supplier filter compatibility ===');

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
// Test: canonicalizeSupplierName — rewrite to canonical storage form
// ============================================================
function testCanonicalizeSupplier(): void {
  console.log('\n=== Test: canonicalizeSupplierName ===');

  // ООО variants → canonical "ООО "Name""
  assert(canonicalizeSupplierName('Общество с ограниченной ответственностью "МС ЛОГИСТИК"')
    === 'ООО "МС ЛОГИСТИК"',
    'Полная форма → ООО "МС ЛОГИСТИК"');

  assert(canonicalizeSupplierName('ООО "МС ЛОГИСТИК"')
    === 'ООО "МС ЛОГИСТИК"',
    'Уже канонический → без изменений');

  assert(canonicalizeSupplierName('МС ЛОГИСТИК ООО')
    === 'ООО "МС ЛОГИСТИК"',
    'ООО в конце → переезд в начало + кавычки');

  assert(canonicalizeSupplierName('Мс логисТИК 000')
    === 'ООО "Мс логисТИК"',
    '000 (OCR zeros) → ООО');

  assert(canonicalizeSupplierName('OOO "Test Company"')
    === 'ООО "Test Company"',
    'Latin OOO → Cyrillic ООО');

  // ИП: no quotes around name
  assert(canonicalizeSupplierName('ИП Иванов И.И.')
    === 'ИП Иванов И.И.',
    'ИП уже канонический');

  assert(canonicalizeSupplierName('Индивидуальный предприниматель Иванов И.И.')
    === 'ИП Иванов И.И.',
    'Полная форма ИП → сокращённая');

  // Other legal forms
  assert(canonicalizeSupplierName('Акционерное общество "Ромашка"')
    === 'АО "Ромашка"',
    'АО полная форма → АО');

  assert(canonicalizeSupplierName('Публичное акционерное общество "Газпром"')
    === 'ПАО "Газпром"',
    'ПАО полная форма → ПАО');

  assert(canonicalizeSupplierName('Закрытое акционерное общество "Бета"')
    === 'ЗАО "Бета"',
    'ЗАО полная форма → ЗАО');

  // Edge cases
  assert(canonicalizeSupplierName('') === '', 'empty → empty');
  assert(canonicalizeSupplierName(null) === '', 'null → empty');
  assert(canonicalizeSupplierName('Яндекс') === 'Яндекс',
    'без легальной формы → без изменений');

  // Idempotency
  const once = canonicalizeSupplierName('Общество с ограниченной ответственностью "МС ЛОГИСТИК"');
  const twice = canonicalizeSupplierName(once);
  assert(once === twice, 'идемпотентно');
}

// ============================================================
// Test 9: Production bug — МСМС-40626 vs 40626 with supplier variations
// ============================================================
function testDigitSequenceFallback(): void {
  console.log('\n=== Test 9: Digit-sequence fallback (МСМС-40626 ↔ 40626) ===');

  // Page 1: full invoice number with prefix
  const page1 = invoiceRepo.create({
    file_name: 'test-msms-page1.jpg',
    file_path: '/tmp/test-msms-page1.jpg',
    invoice_number: 'МСМС-40626',
    invoice_date: '2026-03-24',
    supplier: 'Общество с ограниченной ответственностью "МС ЛОГИСТИК"',
  });
  invoiceRepo.updateStatus(page1.id, 'processed');

  // Page 2 arrives with truncated number (OCR missed the prefix) and different
  // supplier form
  const found = invoiceRepo.findRecentByNumber(
    '40626',
    'Мс логисТИК 000',
    10
  );
  assert(!!found, 'findRecentByNumber finds page 1 from truncated number + alt supplier');
  assert(found?.id === page1.id, `Matches correct invoice: got ${found?.id}, expected ${page1.id}`);

  // Negative case: same digit sequence but DIFFERENT supplier should NOT merge
  const unrelated = invoiceRepo.create({
    file_name: 'unrelated.jpg',
    file_path: '/tmp/unrelated.jpg',
    invoice_number: 'INV-40626',
    invoice_date: '2026-03-24',
    supplier: 'ООО "Совершенно другая компания"',
  });
  invoiceRepo.updateStatus(unrelated.id, 'processed');

  const notFoundForDifferentSupplier = invoiceRepo.findRecentByNumber(
    '40626',
    'ООО "Третья фирма"',
    10
  );
  // Should return undefined since neither page1 nor unrelated matches "Третья фирма" supplier
  assert(!notFoundForDifferentSupplier,
    'Digit match fails when supplier does not match any candidate');

  // But searching for the first variant's supplier should still find page1
  const foundAgain = invoiceRepo.findRecentByNumber(
    '40626',
    'ООО "МС ЛОГИСТИК"',
    10
  );
  assert(foundAgain?.id === page1.id,
    `Still finds page 1 with another supplier variant: ${foundAgain?.id}`);

  invoiceRepo.delete(page1.id);
  invoiceRepo.delete(unrelated.id);
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
  testExtractDigits();
  testNormalizeSupplier();
  testSuppliersMatch();
  testCanonicalizeSupplier();
  testFindRecentByNumber();
  testWithSupplier();
  testDigitSequenceFallback();

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
