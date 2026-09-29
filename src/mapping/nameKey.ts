/**
 * Ключ товара и «жёсткие» атрибуты названия.
 *
 * itemNameKey — нормализованный ключ, одинаковый для разных написаний одного
 * товара: регистр, ё, скобки, запятая в числе, порядок слов, логистические
 * счётчики («1/12», «(х50/1000)», «240г*24») и «ГОСТ» не важны. На проде одна
 * позиция 1С в среднем имеет 7 разных написаний (до 19) — ключ позволяет
 * одному правилу покрыть их все. Размеры/объёмы/массы в ключе остаются:
 * «Контейнер 750мл» и «Контейнер 500мл» — разные товары.
 *
 * extractAttrs/attrsConflict — проверка кандидата при подборе: если атрибут
 * (объём, масса, габарит, размер S/M/L, жирность, калибр, артикул) есть с обеих
 * сторон и не совпал — это другой товар («750мл» ≠ «500мл», перчатки M ≠ S).
 */

// Латиница, которую OCR подсовывает внутрь русских слов.
const LAT2CYR: Record<string, string> = {
  a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у',
};

const MEASURE_RE = /(\d+(?:\.\d+)?)\s*(кг|гр|г|мл|л)(?![а-яa-z])/g;

function hasCyr(w: string): boolean { return /[а-я]/.test(w); }
function hasLat(w: string): boolean { return /[a-z]/.test(w); }

/** Нижний регистр, ё→е, латиница внутри русских слов → кириллица, «7,5» → «7.5». */
function baseNormalize(name: string): string {
  let s = (name || '').toLowerCase().replace(/ё/g, 'е');
  s = s.replace(/[a-zа-я]+/g, w => (hasCyr(w) && hasLat(w)) ? w.replace(/[a-z]/g, ch => LAT2CYR[ch] ?? ch) : w);
  s = s.replace(/(\d),(\d)/g, '$1.$2');
  // OCR путает цифры с похожими буквами внутри чисел: «1З2» → «132», «1О0» → «100».
  s = s.replace(/(\d)[зz](?=\d)/g, '$13').replace(/(\d)[оo](?=\d)/g, '$10');
  // …и в начале числа, если «буква» стоит отдельно от слова: «З,2%», «З50мл», «*З50».
  s = s.replace(/(^|[^а-яa-z])з(?=[.,]?\d)/g, '$13').replace(/(^|[^а-яa-z])[оo](?=[.,]\d)/g, '$10');
  s = s.replace(/(\d),(\d)/g, '$1.$2');
  return s;
}

/** Логистика упаковки: «(х50/1000)», «*100/2500», «1/12», «100шт/упак», «10пач/упак», ГОСТ. */
function stripPackNoise(s: string): string {
  return s
    .replace(/гост(?:\s*р)?[\s\d.\-]*/g, ' ')
    .replace(/\(?\s*[xх*×]\s*\d+\s*\/\s*\d+\s*\)?/g, ' ')
    .replace(/(^|[^\d.])1\s*\/\s*\d{1,3}(?![\d.])/g, '$1 ')
    .replace(/\d+\s*(?:шт|штук|пач|пак|пакетов|рул|бут|бан)\.?\s*\/\s*(?:упак|уп|кор|короб|меш|ящ|рул|пал)\.?/g, ' ');
}

export function itemNameKey(name: string): string {
  let s = stripPackNoise(baseNormalize(name));
  s = s.replace(MEASURE_RE, (_m, n: string, u: string) => ` ${Number(n)}${u === 'гр' ? 'г' : u} `);
  // Счётчик при мере: «240г*24» → «240г», «10х1кг» → «1кг».
  s = s.replace(/(\d(?:кг|г|мл|л))\s*[*xх×]\s*\d+(?![\d.])/g, '$1');
  s = s.replace(/(^|\s)\d+\s*[*xх×]\s*(?=\d+(?:\.\d+)?(?:кг|г|мл|л)(?![а-яa-z]))/g, '$1');
  s = s.replace(/[^\p{L}\p{N}.%\-/]+/gu, ' ');
  const tokens = s.split(/\s+/)
    .map(t => t.replace(/^[.\-/]+|[.\-/]+$/g, ''))
    .filter(t => t && /[\p{L}\p{N}]/u.test(t));
  return Array.from(new Set(tokens)).sort().join(' ');
}

export interface ItemAttrs {
  volumesMl: number[];
  massesG: number[];
  dims: string[];
  sizes: string[];
  fats: string[];
  calibers: string[];
  codes: string[];
}

const UNIT_SUFFIXES = new Set(['г', 'гр', 'кг', 'мл', 'л', 'мм', 'см', 'м', 'шт', 'п', 'пач', 'пак', 'рул', 'уп', 'т']);

function uniq<T>(xs: T[]): T[] { return Array.from(new Set(xs)); }
function num(n: string): number { return Math.round(Number(n) * 1000) / 1000; }

export function extractAttrs(name: string): ItemAttrs {
  const out: ItemAttrs = { volumesMl: [], massesG: [], dims: [], sizes: [], fats: [], calibers: [], codes: [] };
  const orig = (name || '').toLowerCase().replace(/ё/g, 'е');
  let s = stripPackNoise(baseNormalize(name));

  // Жирность: «67%», диапазон «26.5-28.5%».
  s = s.replace(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*%/g, (_m, a: string, b: string) => { out.fats.push(`${num(a)}-${num(b)}`); return ' '; });
  s = s.replace(/(\d+(?:\.\d+)?)\s*%/g, (_m, a: string) => { out.fats.push(String(num(a))); return ' '; });

  // Диапазоны («300-500г», «4-5кг», «9-12») и дроби-калибры («21/25», «300/500»; «1/N» — счётчик).
  s = s.replace(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*(?:кг|гр|г|мл|л)?(?![а-яa-z\d])/g, (_m, a: string, b: string) => { out.calibers.push(`${num(a)}-${num(b)}`); return ' '; });
  s = s.replace(/(\d{1,4})\s*\/\s*(\d{1,4})(?![\d])/g, (m, a: string, b: string) => {
    if (Number(a) < 2) return m;
    out.calibers.push(`${num(a)}-${num(b)}`);
    return ' ';
  });

  // Габариты «139х102х86мм», «32*40»; не «240г*24» и не «20*14г» (это счёт × мера).
  s = s.replace(/(\d+(?:\.\d+)?)\s*[xх*×]\s*(\d+(?:\.\d+)?)(?:\s*[xх*×]\s*(\d+(?:\.\d+)?))?(?!\s*(?:кг|гр|г|мл|л)(?![а-яa-z]))(?![\d.])/g,
    (m, a: string, b: string, c: string | undefined, offset: number, whole: string) => {
      // Первое число сразу после буквы меры («240г*24») — это счёт, не габарит.
      if (/[а-яa-z]$/.test(whole.slice(0, offset))) return m;
      out.dims.push([a, b, c].filter(Boolean).map(x => String(num(x as string))).join('x'));
      return ' ';
    });

  // Меры.
  for (const m of s.matchAll(MEASURE_RE)) {
    const v = Number(m[1]);
    const u = m[2];
    if (!isFinite(v) || v <= 0) continue;
    if (u === 'мл') out.volumesMl.push(num(String(v)));
    else if (u === 'л') out.volumesMl.push(num(String(v * 1000)));
    else if (u === 'кг') out.massesG.push(num(String(v * 1000)));
    else out.massesG.push(num(String(v)));
  }

  // Размеры S/M/L: латиница где угодно (не после цифры); кириллица — только у перчаток.
  for (const m of orig.matchAll(/(^|[^\p{L}\d])(xxxl|xxl|xl|xs|s|m|l)(?=$|[^\p{L}])/gu)) out.sizes.push(m[2]);
  if (orig.includes('перчат')) {
    const cyr: Record<string, string> = { 'м': 'm', 'с': 's', 'л': 'l', 'хл': 'xl' };
    for (const m of orig.matchAll(/(^|[^\p{L}\d])(хл|м|с|л)(?=$|[^\p{L}])/gu)) out.sizes.push(cyr[m[2]]);
  }

  // Артикулы: «к-139», «спк-115», «d=115», «е-21».
  for (const raw of s.split(/[^\p{L}\p{N}\-=]+/u)) {
    const t = raw.replace(/^-+|-+$/g, '');
    if (!t) continue;
    let code: string | null = null;
    const m1 = t.match(/^(\p{L}{1,4})[-=]?(\d{2,5})(\p{L}?)$/u);
    // «х150», «x24» — счётчик упаковки, а не артикул.
    if (m1 && !/^[xх×]$/.test(m1[1]) && !UNIT_SUFFIXES.has(m1[1]) && !(m1[3] && UNIT_SUFFIXES.has(m1[3]))) code = t;
    // Артикул без разделителей: «D=38», «D-38» и «D38» — одно и то же.
    if (code) out.codes.push(code.replace(/[a-z]/g, ch => LAT2CYR[ch] ?? ch).replace(/[-=]/g, ''));
  }

  out.volumesMl = uniq(out.volumesMl);
  out.massesG = uniq(out.massesG);
  out.dims = uniq(out.dims);
  out.sizes = uniq(out.sizes);
  out.fats = uniq(out.fats);
  out.calibers = uniq(out.calibers);
  out.codes = uniq(out.codes);
  return out;
}

function numsDisjoint(x: number[], y: number[]): boolean {
  if (!x.length || !y.length) return false;
  return !x.some(v => y.some(w => Math.abs(v - w) <= 0.01 * Math.max(v, w)));
}
function strsDisjoint(x: string[], y: string[]): boolean {
  if (!x.length || !y.length) return false;
  return !x.some(v => y.includes(v));
}
/** Габарит «139x102» совместим с «139x102x9»: одно — начало другого. */
function dimsDisjoint(x: string[], y: string[]): boolean {
  if (!x.length || !y.length) return false;
  const pre = (a: string, b: string) => a === b || b.startsWith(a + 'x') || a.startsWith(b + 'x');
  return !x.some(v => y.some(w => pre(v, w)));
}
/** Артикулы сравниваем по числовой части: «D115» и «СпК-115» — одна модель, «К-139» и «К-187» — разные. */
function codesDisjoint(x: string[], y: string[]): boolean {
  if (!x.length || !y.length) return false;
  const digits = (c: string) => c.replace(/\D/g, '');
  const dx = new Set(x.map(digits));
  return !y.some(c => dx.has(digits(c)));
}

/** null — совместимы; иначе человекочитаемая причина, почему это разные товары. */
export function attrsConflict(a: ItemAttrs, b: ItemAttrs): string | null {
  if (numsDisjoint(a.volumesMl, b.volumesMl)) return `объём: ${a.volumesMl.join('/')} мл ≠ ${b.volumesMl.join('/')} мл`;
  if (numsDisjoint(a.massesG, b.massesG)) return `масса: ${a.massesG.join('/')} г ≠ ${b.massesG.join('/')} г`;
  if (dimsDisjoint(a.dims, b.dims)) return `размер: ${a.dims.join('/')} ≠ ${b.dims.join('/')}`;
  if (strsDisjoint(a.sizes, b.sizes)) return `размер: ${a.sizes.join('/').toUpperCase()} ≠ ${b.sizes.join('/').toUpperCase()}`;
  if (strsDisjoint(a.fats, b.fats)) return `жирность: ${a.fats.join('/')}% ≠ ${b.fats.join('/')}%`;
  if (strsDisjoint(a.calibers, b.calibers)) return `калибр: ${a.calibers.join('/')} ≠ ${b.calibers.join('/')}`;
  if (codesDisjoint(a.codes, b.codes)) return `артикул: ${a.codes.join('/')} ≠ ${b.codes.join('/')}`;
  return null;
}
