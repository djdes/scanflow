/**
 * Коды ОКЕИ (общероссийский классификатор единиц измерения) → единица так, как
 * её пишут в накладных и понимает пересчёт единиц (src/mapping/unitConverter.ts:
 * шт, упак, кг, г, л, мл…). Неизвестный код — null: тогда берётся наименование
 * единицы из самого документа (НаимЕдИзм).
 *
 * 625 «лист» — не «л.»: после отбрасывания точки это совпало бы с литром.
 */
const OKEI_UNITS: Record<string, string> = {
  '003': 'мм',
  '004': 'см',
  '006': 'м',
  '008': 'км',
  '018': 'пог. м',
  '050': 'см2',
  '055': 'м2',
  '111': 'мл',      // кубический сантиметр = миллилитр
  '112': 'л',       // литр = кубический дециметр
  '113': 'м3',
  '161': 'мг',
  '163': 'г',
  '166': 'кг',
  '168': 'т',
  '356': 'ч',
  '359': 'сут',
  '362': 'мес',
  '616': 'боб',
  '625': 'лист',
  '642': 'ед',
  '657': 'изд',
  '704': 'набор',
  '715': 'пара',
  '728': 'пач',
  '736': 'рул',
  '778': 'упак',
  '796': 'шт',
  '797': '100 шт',
  '798': 'тыс. шт',
  '812': 'ящ',
  '839': 'компл',
  '868': 'бут',
  '870': 'ампул',
  '872': 'флак',
  '876': 'усл. ед',
};

/**
 * Единицы-«множители»: количество в них — сотни/тысячи штук. Пересчёт единиц
 * их не понимает (посчитает как штуки), поэтому разбор XML предупреждает.
 */
const MULTIPLIER_CODES = new Set(['797', '798']);

function normalizeCode(code: string | null | undefined): string | null {
  if (code == null) return null;
  let c = String(code).trim();
  if (!/^\d{1,4}$/.test(c)) return null;
  if (c.length === 4 && c.startsWith('0')) c = c.slice(1);
  return c.padStart(3, '0');
}

export function unitFromOkei(code: string | null | undefined): string | null {
  const c = normalizeCode(code);
  return c ? OKEI_UNITS[c] ?? null : null;
}

export function isMultiplierOkei(code: string | null | undefined): boolean {
  const c = normalizeCode(code);
  return c != null && MULTIPLIER_CODES.has(c);
}
