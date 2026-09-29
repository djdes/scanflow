/**
 * Median of a numeric array. Returns null for empty input.
 * Does not mutate the input.
 */
export function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Устойчивая медиана: отбрасывает значения дальше чем в `spread` раз от
 * обычной медианы и считает медиану заново. Нужна потому, что в истории цен
 * есть строки с неверно пересчитанным количеством (0,21 ₽/кг творога при
 * обычных 200 ₽) — одна такая строка не должна сдвигать «обычную цену».
 * null — если после отсева осталось меньше `minSamples` значений.
 */
export function robustMedian(values: number[], spread = 5, minSamples = 3): number | null {
  const clean = values.filter(v => Number.isFinite(v) && v > 0);
  const m = medianOf(clean);
  if (m === null) return null;
  const kept = clean.filter(v => v >= m / spread && v <= m * spread);
  if (kept.length < minSamples) return null;
  return medianOf(kept);
}
