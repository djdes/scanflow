/**
 * Русские слова для текстов, которые видит человек: склонение по числу вместо
 * «товар(ов)» и деньги «50 000 ₽» вместо «50000.00 ₽» (2026-11-23).
 */

/** plural(5, 'строка', 'строки', 'строк') → 'строк'. */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(Math.trunc(Number(n) || 0));
  const m10 = a % 10;
  const m100 = a % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** rub(50000) → '50 000 ₽', rub(1234.5) → '1 234,5 ₽' (неразрывные пробелы, как у Intl). */
export function rub(value: number): string {
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value)} ₽`;
}
