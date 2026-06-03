/**
 * Conservatively trim trailing size / caliber / packaging junk from a scanned
 * item name so an UNMATCHED item creates a clean Справочники.Номенклатура in 1C.
 *
 * Trims (iteratively, from the tail): caliber/diameter codes (d120, д80, ø60),
 * weight & volume tokens incl. ranges (3-4кг, 0,5 л, 500г, 10шт), a leftover
 * trailing size number, and a small whitelist of trailing packaging words.
 *
 * PRESERVES: percent fat content (3,2%, 45%), mid-name descriptors, and never
 * returns an empty/too-short result (falls back to the raw input). The raw scan
 * (invoice_items.original_name) is a separate column and is never touched.
 *
 * Idempotent: cleanItemName(cleanItemName(x)) === cleanItemName(x).
 */

// Accounting units we recognise as a "size" suffix. Tunable.
const UNIT = '(?:кг|гр|г|мл|л|шт|штук|уп|упак|пач|бут)';

// Caliber/diameter: "d120", "д 80", "ø60". 2–3 digits, on a token boundary,
// the letter not glued to a preceding word so it can't eat a real word's "d".
const CALIBER_RE = /(?:^|[\s(])[dдøØ]\s?\d{2,3}\b\.?/gi;

// Weight/volume incl. ranges. The UNIT must follow, so "3,2%" (percent, not a
// unit) is never matched. Negative lookahead stops "шт" eating "штурм".
const WEIGHT_RE = new RegExp(
  String.raw`\s*\d+(?:[.,]\d+)?(?:\s?[-–—]\s?\d+(?:[.,]\d+)?)?\s*${UNIT}\.?(?![а-яёa-z])`,
  'gi',
);

// Trailing packaging words (whitelist), only at the very end. Tunable list.
const TRAIL_PACK_RE = /\s*(?:пэт|в\/у|б\/у|вакуум\w*|в\s?вакууме|ведро|лоток|пакет)\.?\s*$/i;

// Leftover trailing standalone number/range. Requires the string to END in a
// digit, so "…3,2%" (ends in %) is preserved.
const TRAIL_NUM_RE = /[\s,;–-]+\d+(?:[.,]\d+)?(?:\s?[-–]\s?\d+(?:[.,]\d+)?)?\s*$/;

// Leftover trailing punctuation/separators.
const TRAIL_PUNCT_RE = /[\s,.;:–—-]+$/;

export function cleanItemName(raw: string): string {
  if (!raw) return raw;
  let s = raw;
  let prev: string;
  // Iterate to a fixed point: order of trailing tokens doesn't matter and the
  // function becomes idempotent.
  do {
    prev = s;
    s = s.replace(CALIBER_RE, ' ');
    s = s.replace(WEIGHT_RE, ' ');
    s = s.replace(TRAIL_PACK_RE, '');
    s = s.replace(TRAIL_NUM_RE, '');
    s = s.replace(TRAIL_PUNCT_RE, '');
    s = s.replace(/\s{2,}/g, ' ').trim();
  } while (s !== prev);

  // Never destroy the name entirely.
  if (s.length < 2) return raw.trim();
  return s;
}
