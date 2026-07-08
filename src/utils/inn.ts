/**
 * Russian taxpayer number (ИНН) validation — length AND checksum (ФНС algorithm).
 * A pure length/regex check passes OCR typos like a single wrong digit, which
 * then land in a Sber payment. The control-digit check catches most of those.
 *
 * 10-digit (organisations): 1 control digit.
 * 12-digit (individuals/ИП):  2 control digits.
 */

function controlDigit(digits: number[], weights: number[]): number {
  let sum = 0;
  for (let i = 0; i < weights.length; i++) sum += digits[i] * weights[i];
  return (sum % 11) % 10;
}

export function isValidInn(inn: string | null | undefined): boolean {
  if (!inn || !/^\d{10}$|^\d{12}$/.test(inn)) return false;
  const d = inn.split('').map(Number);

  if (d.length === 10) {
    const c = controlDigit(d, [2, 4, 10, 3, 5, 9, 4, 6, 8]);
    return c === d[9];
  }

  // 12 digits
  const c1 = controlDigit(d, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]);
  const c2 = controlDigit(d, [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]);
  return c1 === d[10] && c2 === d[11];
}
