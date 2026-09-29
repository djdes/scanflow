/**
 * Контрольная сумма ИНН: 10 цифр — организация (одна контрольная цифра),
 * 12 цифр — ИП/физлицо (две контрольные цифры).
 *
 * Алгоритм тот же, что в src/ocr/invoiceValidator.ts (isValidInn — проверка
 * распознанного ИНН перед repair-запросом к модели). Этот модуль — общая точка
 * для справочника поставщиков и автопривязки: OCR путает соседние цифры
 * (7724357632 → 7724357832), такой ИНН попадает в карточку и затем выглядит
 * «двойником» настоящего поставщика.
 */
const WEIGHTS_10 = [2, 4, 10, 3, 5, 9, 4, 6, 8];
const WEIGHTS_12_FIRST = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
const WEIGHTS_12_SECOND = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];

function checkDigit(digits: number[], weights: number[]): number {
  let sum = 0;
  for (let i = 0; i < weights.length; i++) sum += weights[i] * digits[i];
  return (sum % 11) % 10;
}

/** true — ровно 10 или 12 цифр и контрольные цифры сходятся. Пустое/null — false. */
export function isValidInn(inn: string | null | undefined): boolean {
  if (inn == null) return false;
  const s = String(inn).trim();
  if (!/^(\d{10}|\d{12})$/.test(s)) return false;
  const d = s.split('').map(Number);
  if (d.length === 10) return checkDigit(d, WEIGHTS_10) === d[9];
  return checkDigit(d, WEIGHTS_12_FIRST) === d[10] && checkDigit(d, WEIGHTS_12_SECOND) === d[11];
}
