/**
 * Utilities for comparing invoice numbers across OCR results.
 *
 * Problem: OCR can produce visually identical but Unicode-different strings
 * for the same invoice number. Most commonly, Cyrillic letters that look
 * like Latin ones (В↔B, М↔M, А↔A, etc.) drift between pages of the same
 * document, breaking exact-match merge logic.
 *
 * Solution: normalize to a canonical ASCII-uppercase form for comparison.
 * Never mutate stored values — only normalize at compare time.
 */

// Cyrillic → Latin homoglyph mapping (letters that look identical in both scripts).
// Only includes characters where the shape is truly interchangeable.
const CYRILLIC_TO_LATIN: Record<string, string> = {
  'А': 'A', 'В': 'B', 'С': 'C', 'Е': 'E', 'Н': 'H', 'К': 'K',
  'М': 'M', 'О': 'O', 'Р': 'P', 'Т': 'T', 'Х': 'X', 'У': 'Y',
  'а': 'A', 'в': 'B', 'с': 'C', 'е': 'E', 'н': 'H', 'к': 'K',
  'м': 'M', 'о': 'O', 'р': 'P', 'т': 'T', 'х': 'X', 'у': 'Y',
};

/**
 * Normalize an invoice number into a canonical form for comparison.
 *
 * Steps:
 *   1. Trim whitespace
 *   2. Uppercase everything
 *   3. Map Cyrillic homoglyphs → Latin equivalents
 *   4. Strip leading № / # symbols
 *   5. Remove all separator characters (whitespace, hyphen, underscore,
 *      dot, slash) — OCR reads these inconsistently across pages
 *
 * @example
 *   normalizeInvoiceNumber('BM-611')   // 'BM611'
 *   normalizeInvoiceNumber('ВМ-611')   // 'BM611'  (Cyrillic input)
 *   normalizeInvoiceNumber('bm 611')   // 'BM611'
 *   normalizeInvoiceNumber('№BM-611')  // 'BM611'
 */
export function normalizeInvoiceNumber(num: string | null | undefined): string {
  if (!num) return '';

  // Uppercase first (maps both Cyrillic and Latin lowercase)
  let result = num.trim().toUpperCase();

  // Map Cyrillic letters to their Latin homoglyphs
  result = result.split('').map(ch => CYRILLIC_TO_LATIN[ch] || ch).join('');

  // Strip leading № / # symbols
  result = result.replace(/^[№#]+/, '');

  // Remove all separator characters (whitespace, hyphen, underscore, dot, slash, backslash)
  result = result.replace(/[\s\-_./\\]+/g, '');

  return result;
}

/**
 * Check if two invoice numbers refer to the same document despite
 * OCR-level differences (homoglyphs, case, whitespace).
 */
export function invoiceNumbersMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeInvoiceNumber(a);
  const nb = normalizeInvoiceNumber(b);
  return na !== '' && na === nb;
}
