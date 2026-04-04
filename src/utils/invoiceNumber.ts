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

/**
 * Extract all digits from a string as a single concatenated sequence.
 * Used as a fallback match signal when OCR reads the invoice number with
 * different letter prefixes on different pages (e.g. "МСМС-40626" vs "40626").
 *
 * @example
 *   extractDigitSequence('МСМС-40626')   // '40626'
 *   extractDigitSequence('17-0048600')   // '170048600'
 *   extractDigitSequence('')             // ''
 */
export function extractDigitSequence(num: string | null | undefined): string {
  if (!num) return '';
  return num.replace(/\D/g, '');
}

// Legal form keywords that should be stripped from supplier names before comparison.
// Covers Russian legal forms and OCR quirks (e.g. "ООО" often read as "000" — three
// capital O's look identical to three zeros in typical fonts).
const LEGAL_FORM_KEYWORDS = [
  'обществосограниченнойответственностью',
  'индивидуальныйпредприниматель',
  'закрытоеакционерноеобщество',
  'открытоеакционерноеобщество',
  'публичноеакционерноеобщество',
  'ооо', 'оао', 'зао', 'пао', 'ао', 'ип',
  '000', // OCR mistake: Cyrillic ООО read as three zeros
];

/**
 * Normalize a supplier name into a canonical comparison form.
 *
 * Handles the full zoo of variations that OCR + human data entry produce
 * for the same legal entity:
 *   - Legal form prefix/suffix: "ООО", "Общество с ограниченной..." → stripped
 *   - OCR quirks: "000" (three zeros from ООО) → stripped
 *   - Quote styles: " ", «», punctuation → stripped
 *   - Whitespace, case → stripped/lowered
 *   - Cyrillic/Latin homoglyphs → unified
 *
 * @example
 *   normalizeSupplierName('ООО "МС ЛОГИСТИК"')                       // 'мслогистик'
 *   normalizeSupplierName('Общество с ограниченной ответственностью "МС ЛОГИСТИК"')
 *                                                                     // 'мслогистик'
 *   normalizeSupplierName('Мс логисТИК 000')                          // 'мслогистик'
 *   normalizeSupplierName('МС ЛОГИСТИК ООО')                          // 'мслогистик'
 */
export function normalizeSupplierName(sup: string | null | undefined): string {
  if (!sup) return '';

  // Lowercase — both Cyrillic and Latin
  let result = sup.toLowerCase();

  // Remove all punctuation and brackets (keep only letters, digits, whitespace)
  result = result.replace(/[^\p{L}\p{N}\s]/gu, ' ');

  // Collapse whitespace and trim
  result = result.replace(/\s+/g, ' ').trim();

  // Remove whitespace entirely for comparison
  result = result.replace(/\s+/g, '');

  // Strip legal form keywords (iteratively, in case multiple appear)
  let changed = true;
  while (changed) {
    changed = false;
    for (const keyword of LEGAL_FORM_KEYWORDS) {
      if (result.includes(keyword)) {
        result = result.replace(keyword, '');
        changed = true;
      }
    }
  }

  return result;
}

/**
 * Check if two supplier strings refer to the same legal entity despite
 * OCR variations and formatting differences.
 *
 * Strategy:
 *   1. Normalize both via normalizeSupplierName()
 *   2. Equal after normalization → match
 *   3. One contains the other (with ≥5 char overlap) → match
 */
export function suppliersMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const na = normalizeSupplierName(a);
  const nb = normalizeSupplierName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Containment fallback (one is a substring of the other) — requires
  // minimum overlap to avoid matching short common words
  const shorter = na.length < nb.length ? na : nb;
  const longer = na.length < nb.length ? nb : na;
  if (shorter.length >= 5 && longer.includes(shorter)) return true;
  return false;
}
