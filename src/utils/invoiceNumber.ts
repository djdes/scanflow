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
 * Canonical legal forms that should always be used in stored/displayed
 * supplier names. Order matters: longer patterns (full phrases) are tried
 * BEFORE their abbreviations, so "Общество с ограниченной ответственностью"
 * is matched before bare "ООО".
 *
 * Each rule has TWO patterns — one anchored at the start of the string and
 * one at the end. A legal form buried in the middle of a string (e.g. bank
 * details like "ВОЛГО-ВЯТСКИЙ БАНК ПАО Сбербанк...") must NOT be treated
 * as a supplier legal form.
 *
 * JS \b (word boundary) only works with Latin \w, not Cyrillic — so we use
 * Unicode-aware lookarounds (?<!\p{L})...(?!\p{L}) with the /u flag.
 */
interface LegalFormRule {
  startPattern: RegExp;
  endPattern: RegExp;
  short: string;
  quoteName: boolean;
}

const LEGAL_FORM_RULES: LegalFormRule[] = [
  // Full phrases (longer patterns first)
  {
    startPattern: /^общество\s+с\s+ограниченной\s+ответственностью(?!\p{L})/iu,
    endPattern: /(?<!\p{L})общество\s+с\s+ограниченной\s+ответственностью\s*$/iu,
    short: 'ООО', quoteName: true,
  },
  {
    startPattern: /^публичное\s+акционерное\s+общество(?!\p{L})/iu,
    endPattern: /(?<!\p{L})публичное\s+акционерное\s+общество\s*$/iu,
    short: 'ПАО', quoteName: true,
  },
  {
    startPattern: /^открытое\s+акционерное\s+общество(?!\p{L})/iu,
    endPattern: /(?<!\p{L})открытое\s+акционерное\s+общество\s*$/iu,
    short: 'ОАО', quoteName: true,
  },
  {
    startPattern: /^закрытое\s+акционерное\s+общество(?!\p{L})/iu,
    endPattern: /(?<!\p{L})закрытое\s+акционерное\s+общество\s*$/iu,
    short: 'ЗАО', quoteName: true,
  },
  {
    startPattern: /^акционерное\s+общество(?!\p{L})/iu,
    endPattern: /(?<!\p{L})акционерное\s+общество\s*$/iu,
    short: 'АО', quoteName: true,
  },
  {
    startPattern: /^индивидуальный\s+предприниматель(?!\p{L})/iu,
    endPattern: /(?<!\p{L})индивидуальный\s+предприниматель\s*$/iu,
    short: 'ИП', quoteName: false,
  },

  // Short forms, including OCR quirks (Latin OOO, three zeros 000 from Cyrillic ООО)
  {
    startPattern: /^ООО(?!\p{L})/iu,
    endPattern: /(?<!\p{L})ООО\s*$/iu,
    short: 'ООО', quoteName: true,
  },
  {
    startPattern: /^OOO(?!\p{L})/iu,
    endPattern: /(?<!\p{L})OOO\s*$/iu,
    short: 'ООО', quoteName: true,
  },
  {
    startPattern: /^000(?!\p{L})/iu,
    endPattern: /(?<!\p{L})000\s*$/iu,
    short: 'ООО', quoteName: true,
  },
  {
    startPattern: /^ПАО(?!\p{L})/iu,
    endPattern: /(?<!\p{L})ПАО\s*$/iu,
    short: 'ПАО', quoteName: true,
  },
  {
    startPattern: /^ОАО(?!\p{L})/iu,
    endPattern: /(?<!\p{L})ОАО\s*$/iu,
    short: 'ОАО', quoteName: true,
  },
  {
    startPattern: /^ЗАО(?!\p{L})/iu,
    endPattern: /(?<!\p{L})ЗАО\s*$/iu,
    short: 'ЗАО', quoteName: true,
  },
  {
    startPattern: /^АО(?!\p{L})/iu,
    endPattern: /(?<!\p{L})АО\s*$/iu,
    short: 'АО', quoteName: true,
  },
  {
    startPattern: /^ИП(?!\p{L})/iu,
    endPattern: /(?<!\p{L})ИП\s*$/iu,
    short: 'ИП', quoteName: false,
  },
];

/**
 * Rewrite a supplier name to a canonical storage/display form.
 *
 * Detects the legal form (ООО, ИП, ОАО, ЗАО, ПАО, АО) regardless of how
 * it's written in the source (full phrase, abbreviation, OCR quirks like
 * Latin "OOO" or three zeros "000"), strips it from wherever it appears
 * in the string, cleans up the remaining name, and rebuilds the output as:
 *
 *   - `ООО "Name"` for company forms (quoted)
 *   - `ИП Name`    for individual entrepreneurs (no quotes)
 *
 * If no legal form is detected, returns the original trimmed string.
 *
 * Applied at storage time in fileWatcher so all new invoices have
 * consistent supplier names. Idempotent — safe to call repeatedly.
 *
 * @example
 *   canonicalizeSupplierName('Общество с ограниченной ответственностью "МС ЛОГИСТИК"')
 *     // → 'ООО "МС ЛОГИСТИК"'
 *   canonicalizeSupplierName('Мс логисТИК 000')
 *     // → 'ООО "Мс логисТИК"'
 *   canonicalizeSupplierName('МС ЛОГИСТИК ООО')
 *     // → 'ООО "МС ЛОГИСТИК"'
 *   canonicalizeSupplierName('Индивидуальный предприниматель Иванов И.И.')
 *     // → 'ИП Иванов И.И.'
 */
export function canonicalizeSupplierName(sup: string | null | undefined): string {
  if (!sup) return '';

  const trimmed = sup.trim();

  let detectedForm: string | null = null;
  let quoteName = true;
  let remaining = trimmed;

  // Try each rule in order; first match wins. Check start anchor first,
  // then end anchor. Matches in the middle of the string are ignored so
  // that strings like "ВОЛГО-ВЯТСКИЙ БАНК ПАО Сбербанк..." don't get
  // falsely treated as suppliers.
  for (const rule of LEGAL_FORM_RULES) {
    if (rule.startPattern.test(trimmed)) {
      detectedForm = rule.short;
      quoteName = rule.quoteName;
      remaining = trimmed.replace(rule.startPattern, ' ');
      break;
    }
    if (rule.endPattern.test(trimmed)) {
      detectedForm = rule.short;
      quoteName = rule.quoteName;
      remaining = trimmed.replace(rule.endPattern, ' ');
      break;
    }
  }

  // Clean up remaining name:
  //   - normalize various quote styles to ASCII "
  //   - collapse whitespace
  //   - trim whitespace and some leading/trailing punctuation, but DO NOT
  //     strip trailing periods (they're part of initials: "Иванов И.И.")
  remaining = remaining
    .replace(/[«»""„"]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s,:;\-]+|[\s,:;\-]+$/g, '')
    .trim();

  // Strip surrounding quotes from the bare name (we'll re-add them if needed)
  if (remaining.startsWith('"') && remaining.endsWith('"')) {
    remaining = remaining.slice(1, -1).trim();
  }

  if (!detectedForm) {
    return sup.trim();
  }

  if (!remaining) {
    return detectedForm;
  }

  if (quoteName) {
    return `${detectedForm} "${remaining}"`;
  }
  return `${detectedForm} ${remaining}`;
}

/**
 * Check if two supplier strings refer to the same legal entity despite
 * OCR variations and formatting differences.
 *
 * Strategy:
 *   1. Normalize both via normalizeSupplierName()
 *   2. Equal after normalization → match
 *   3. One contains the other (with ≥5 char overlap) → match
 *   4. Levenshtein similarity ≥ 0.75 on strings ≥ 10 chars → match
 *      (catches OCR drift like "велесоф" vs "веселофф" on long names;
 *      0.75 allows ~4 edits on an 18-char string, which is the typical
 *      OCR error budget without being lax enough to merge different names)
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
  // Fuzzy fallback for OCR drift. Only applied to reasonably long strings
  // (both ≥ 10 chars normalized) so "Ромашка" and "Ромашки" can still match
  // by containment while short random pairs don't get matched just because
  // their Levenshtein ratio looks OK.
  if (shorter.length >= 10 && longer.length >= 10) {
    const dist = levenshtein(na, nb);
    const similarity = 1 - dist / longer.length;
    if (similarity >= 0.75) return true;
  }
  return false;
}

/**
 * Classic Levenshtein edit distance — number of insertions/deletions/substitutions
 * needed to turn `a` into `b`. O(a.length * b.length) time and O(min) space.
 * Inline so we don't pull in a dependency for a one-off utility.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Ensure a is the shorter — keeps the row buffer smaller.
  if (a.length > b.length) { const t = a; a = b; b = t; }
  const prev = new Array(a.length + 1);
  const curr = new Array(a.length + 1);
  for (let i = 0; i <= a.length; i++) prev[i] = i;
  for (let j = 1; j <= b.length; j++) {
    curr[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[i] = Math.min(
        curr[i - 1] + 1,       // insertion
        prev[i] + 1,           // deletion
        prev[i - 1] + cost,    // substitution
      );
    }
    for (let i = 0; i <= a.length; i++) prev[i] = curr[i];
  }
  return prev[a.length];
}
