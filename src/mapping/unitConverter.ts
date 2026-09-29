/**
 * Пересчёт строки накладной в единицу учёта 1С (пакет v2, п.1–2).
 *
 * Чистая функция: на вход — значения «как в накладной» (raw), название товара,
 * единица позиции 1С и подсказки (правило, старая упаковка с сопоставления,
 * подсказка Claude, медиана цены); на выход — количество/единица/цена в
 * единицах 1С + формула-пояснение и флаг, если уверенности нет.
 *
 * Главные свойства:
 *   - сумма строки НИКОГДА не меняется (деньги не зависят от того, как считать);
 *   - считаем всегда от raw → повторный вызов даёт тот же результат (до v2
 *     повторный /remap умножал количество ещё раз);
 *   - «4-5кг», «300-500г» — это переменный вес/калибр, не вес упаковки;
 *   - «240г*24», «10х1кг», «500*5г», «1/12», «(х50/1000)», «100шт/упак» —
 *     количество в упаковке учитывается (до v2 для штучных позиций 1С терялось);
 *   - когда кандидатов несколько (банка или коробка?), выбирает цена: история
 *     цен позиции, а без неё — правдоподобие цены за кг/л.
 */

export type UnitClass = 'count' | 'mass' | 'volume';

export interface CanonUnit {
  unit: string;                 // каноническое написание: шт, упак, кор, кг, г, л, мл…
  cls: UnitClass;
  base: 'шт' | 'кг' | 'л';
  toBase: number;               // сколько base в одной такой единице (г → 0.001)
  isCase: boolean;              // «ящик» с несколькими штуками внутри (упак/кор/ящ/блок)
}

const UNIT_DEFS: Array<{ names: string[]; unit: string; cls: UnitClass; base: 'шт' | 'кг' | 'л'; toBase: number; isCase?: boolean }> = [
  { names: ['шт', 'штук', 'штука', 'штуки', 'pcs', 'ед', 'единица'], unit: 'шт', cls: 'count', base: 'шт', toBase: 1 },
  { names: ['упак', 'упаковка', 'уп', 'упк'], unit: 'упак', cls: 'count', base: 'шт', toBase: 1, isCase: true },
  { names: ['кор', 'короб', 'коробка'], unit: 'кор', cls: 'count', base: 'шт', toBase: 1, isCase: true },
  { names: ['ящ', 'ящик'], unit: 'ящ', cls: 'count', base: 'шт', toBase: 1, isCase: true },
  { names: ['блок'], unit: 'блок', cls: 'count', base: 'шт', toBase: 1, isCase: true },
  { names: ['пач', 'пачка'], unit: 'пач', cls: 'count', base: 'шт', toBase: 1 },
  { names: ['бут', 'бутылка'], unit: 'бут', cls: 'count', base: 'шт', toBase: 1 },
  { names: ['бан', 'банка'], unit: 'бан', cls: 'count', base: 'шт', toBase: 1 },
  { names: ['пак', 'пакет'], unit: 'пак', cls: 'count', base: 'шт', toBase: 1 },
  { names: ['рул', 'рулон'], unit: 'рул', cls: 'count', base: 'шт', toBase: 1 },
  { names: ['меш', 'мешок'], unit: 'меш', cls: 'count', base: 'шт', toBase: 1 },
  { names: ['ведро', 'вед'], unit: 'ведро', cls: 'count', base: 'шт', toBase: 1 },
  { names: ['набор', 'компл', 'комплект'], unit: 'компл', cls: 'count', base: 'шт', toBase: 1 },
  { names: ['пара', 'пар'], unit: 'пара', cls: 'count', base: 'шт', toBase: 1 },
  { names: ['кг', 'килограмм', 'кило'], unit: 'кг', cls: 'mass', base: 'кг', toBase: 1 },
  { names: ['г', 'гр', 'грамм'], unit: 'г', cls: 'mass', base: 'кг', toBase: 0.001 },
  { names: ['т', 'тонна'], unit: 'т', cls: 'mass', base: 'кг', toBase: 1000 },
  { names: ['л', 'литр', 'дм3'], unit: 'л', cls: 'volume', base: 'л', toBase: 1 },
  { names: ['мл', 'миллилитр'], unit: 'мл', cls: 'volume', base: 'л', toBase: 0.001 },
];
const UNIT_INDEX = new Map<string, CanonUnit>();
for (const d of UNIT_DEFS) {
  for (const n of d.names) UNIT_INDEX.set(n, { unit: d.unit, cls: d.cls, base: d.base, toBase: d.toBase, isCase: !!d.isCase });
}

export function canonUnit(raw: string | null | undefined): CanonUnit | null {
  if (!raw) return null;
  const s = String(raw).toLowerCase().replace(/ё/g, 'е').replace(/\(.*?\)/g, ' ').replace(/[.\s]+/g, ' ').trim();
  if (!s) return null;
  return UNIT_INDEX.get(s) ?? UNIT_INDEX.get(s.split(' ')[0]) ?? null;
}

type MeasureUnit = 'кг' | 'г' | 'л' | 'мл';
export interface Measure { value: number; unit: MeasureUnit; kind: 'nominal' | 'net' | 'drained' }
export interface PackInfo {
  measures: Measure[];
  ranges: Array<{ low: number; high: number; unit: MeasureUnit }>;
  perPack: number | null;
  perCase: number | null;
  /** perPack взят из «N×мера» / «мера×N» (штучная фасовка), а не из логистики. */
  countTimesMeasure: boolean;
}

/**
 * Товар — тара (контейнер, стакан, бутылка, мешок, перчатки…), если такое
 * слово стоит в начале названия («Мусорные мешки 180л», «Контейнер 500мл»).
 * Тогда объём в названии — вместимость, а не количество содержимого. Слово в
 * хвосте («Молоко 1л в пакете») тарой товар не делает.
 */
const CONTAINER_HEAD = /^(мешк|мешо|пакет|бутыл|стакан|контейнер|крышк|лоток|лотк|плошк|банк|подложк|пленк|фольг|салфет|перчат|вкладыш|соусник|тарелк|трубочк|пергамент|ведр|канистр|коробк|упаковк|емкост|вилк|ложк|нож[иа]?$)/;
export function isContainerProduct(name: string): boolean {
  // Слова до первой цифры: «Мусорные мешки 180л» → тара, «Молоко 3,2% 1л в пакете» → нет.
  const head = (name || '').toLowerCase().replace(/ё/g, 'е').split(/\d/)[0];
  const words = head.split(/[^а-яa-z]+/).filter(w => w.length >= 3);
  return words.slice(0, 2).some(w => CONTAINER_HEAD.test(w));
}

const MU = '(кг|гр|г|мл|л)';
const normMU = (u: string): MeasureUnit => (u === 'гр' ? 'г' : u) as MeasureUnit;

export function parsePack(name: string): PackInfo {
  const out: PackInfo = { measures: [], ranges: [], perPack: null, perCase: null, countTimesMeasure: false };
  let s = ` ${(name || '').toLowerCase().replace(/ё/g, 'е')} `;
  s = s.replace(/(\d),(\d)/g, '$1.$2')
    .replace(/(\d)[зz](?=\d)/g, '$13').replace(/(^|[^а-яa-z])з(?=[.]?\d)/g, '$13');
  const setPack = (n: number, fromCountMeasure = false) => {
    if (out.perPack == null && isFinite(n) && n >= 2 && n <= 100000) {
      out.perPack = n;
      out.countTimesMeasure = fromCountMeasure;
    }
  };

  // Диапазоны «4-5кг», «300-500г» — переменный вес/калибр, НЕ вес упаковки.
  s = s.replace(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*-\\s*(\\d+(?:\\.\\d+)?)\\s*${MU}(?![а-яa-z])`, 'g'), (_m, a: string, b: string, u: string) => {
    out.ranges.push({ low: Number(a), high: Number(b), unit: normMU(u) });
    return ' ';
  });
  // Логистика «(х50/1000)», «*100/2500»: 50 в упаковке, 1000 в коробе.
  s = s.replace(/[xх*×]\s*(\d+)\s*\/\s*(\d+)/g, (_m, a: string, b: string) => {
    setPack(Number(a));
    if (out.perCase == null) out.perCase = Number(b);
    return ' ';
  });
  // «100шт/упак», «10пач/упак», «25шт/рул», «5 рул/упак».
  s = s.replace(/(\d+)\s*(?:шт|штук|пач|пак|пакетов|пакетиков|рул|бут|бан|банок)\.?\s*\/\s*(?:упак|уп|кор|короб|меш|ящ|рул|блок|пал)\.?/g, (_m, a: string) => {
    setPack(Number(a));
    return ' ';
  });
  // «мера × N»: «240г*24».
  s = s.replace(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${MU}\\s*[*xх×]\\s*(\\d+)(?![\\d.])`, 'g'), (_m, v: string, u: string, n: string) => {
    out.measures.push({ value: Number(v), unit: normMU(u), kind: 'nominal' });
    setPack(Number(n), true);
    return ' ';
  });
  // «N × мера»: «10х1кг», «500*5г», «20*14г».
  s = s.replace(new RegExp(`(^|[^\\d.])(\\d+)\\s*[*xх×]\\s*(\\d+(?:\\.\\d+)?)\\s*${MU}(?![а-яa-z])`, 'g'), (_m, pre: string, n: string, v: string, u: string) => {
    out.measures.push({ value: Number(v), unit: normMU(u), kind: 'nominal' });
    setPack(Number(n), true);
    return `${pre} `;
  });
  // «1/12» — 12 штук в коробе.
  s = s.replace(/(^|[^\d.])1\s*\/\s*(\d{1,3})(?![\d.])/g, (_m, pre: string, n: string) => {
    setPack(Number(n));
    return `${pre} `;
  });
  // «180г/м2», «50г/м» — плотность материала, не вес единицы.
  s = s.replace(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${MU}\\s*\\/\\s*м`, 'g'), ' ');
  // Остальные меры; «сух. вес» — масса без заливки, вторая мера через «/» — нетто.
  const re = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${MU}(?![а-яa-z])`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const before = s.slice(Math.max(0, m.index - 14), m.index);
    let kind: Measure['kind'] = 'nominal';
    if (/сух|с\.\s*в|сухой/.test(before)) kind = 'drained';
    else if (/нетто|\/\s*$/.test(before)) kind = 'net';
    out.measures.push({ value: Number(m[1]), unit: normMU(m[2]), kind });
  }
  // «360шт», «(10 шт)» — штук в упаковке, если ничего точнее не нашлось.
  const pcs = s.match(/(\d+)\s*(?:шт|штук)(?![а-яa-z])/);
  if (pcs) setPack(Number(pcs[1]));
  return out;
}

export interface RawLine { quantity: number | null; unit: string | null; price: number | null; total: number | null }
export type ConvSource = 'same' | 'scale' | 'rule' | 'name' | 'name_count' | 'price_fit' | 'legacy' | 'manual' | 'none';
export type QtyFlag = 'price_outlier' | 'unit_mismatch' | 'needs_weight';

export interface ConvertInput {
  raw: RawLine;
  name: string;
  onecUnit: string | null;
  onecName?: string | null;
  rule?: { factor: number; targetUnit: string; source: string } | null;
  legacyPack?: { size: number; unit: string } | null;
  llmPackHint?: number | null;
  medianPrice?: number | null;
}

export interface ConvertResult {
  quantity: number | null;
  unit: string | null;
  price: number | null;
  total: number | null;
  factor: number;
  source: ConvSource;
  note: string | null;
  flag: QtyFlag | null;
  flagNote: string | null;
}

interface Cand { factor: number; source: ConvSource; note: string }

const MEASURE_TO_BASE: Record<MeasureUnit, number> = { 'кг': 1, 'г': 0.001, 'л': 1, 'мл': 0.001 };
const MEASURE_CLS: Record<MeasureUnit, UnitClass> = { 'кг': 'mass', 'г': 'mass', 'л': 'volume', 'мл': 'volume' };

// Правдоподобная цена за кг/л в общепите (без истории цен): вне коридора —
// скорее всего перепутаны граммы и килограммы или штука и коробка.
const PLAUSIBLE_PER_BASE = { min: 5, max: 30000 };

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r4 = (x: number) => Math.round(x * 10000) / 10000;
const fmt = (x: number) => String(r3(x)).replace('.', ',');

export function convertLine(input: ConvertInput): ConvertResult {
  const { raw, name } = input;
  const q = raw.quantity;
  const total = raw.total ?? (raw.price != null && q != null ? r4(raw.price * q) : null);
  const passthrough: ConvertResult = {
    quantity: q, unit: raw.unit, price: raw.price, total,
    factor: 1, source: 'none', note: null, flag: null, flagNote: null,
  };
  if (q == null || !(q > 0)) return passthrough;

  const from = canonUnit(raw.unit) ?? (canonUnit('шт') as CanonUnit);
  const target = input.onecUnit ? canonUnit(input.onecUnit) : null;
  const priceFor = (qty: number) => (total != null && qty > 0 ? r4(total / qty) : raw.price);

  // Нет единицы 1С: только каноническое написание; упаковки поставщика → «шт»
  // (прежнее поведение coerceToOnec1cUnit — 1С новые позиции ведёт в шт/кг/л).
  if (!target) {
    const unit = from.cls === 'count' ? 'шт' : from.unit;
    return { ...passthrough, unit, price: priceFor(q), source: 'same' };
  }
  const outUnit = input.onecUnit as string;

  const pack = parsePack(name);
  const cands: Cand[] = [];
  let noConversion: { flag: QtyFlag; note: string } | null = null;
  const fromLabel = from.unit;
  const toLabel = target.unit;

  if (input.rule && canonUnit(input.rule.targetUnit)?.unit === target.unit && input.rule.factor > 0) {
    cands.push({ factor: input.rule.factor, source: 'rule', note: `${fmt(q)} ${fromLabel} × ${fmt(input.rule.factor)} = ${fmt(q * input.rule.factor)} ${toLabel} (правило)` });
  }

  if (from.cls === target.cls && from.cls !== 'count') {
    // масса↔масса, объём↔объём
    const f = from.toBase / target.toBase;
    cands.push(f === 1
      ? { factor: 1, source: 'same', note: '' }
      : { factor: f, source: 'scale', note: `${fmt(q)} ${fromLabel} = ${fmt(q * f)} ${toLabel}` });
  } else if (from.cls !== 'count' && target.cls !== 'count') {
    // объём↔масса: плотность считаем 1
    const f = from.toBase / target.toBase;
    cands.push({ factor: f, source: 'scale', note: `${fmt(q)} ${fromLabel} = ${fmt(q * f)} ${toLabel} (1 л = 1 кг, плотность не учтена)` });
  } else if (from.cls === 'count' && target.cls !== 'count' && Math.abs(q - Math.round(q)) > 0.001) {
    // Дробные «штуки» (348,92 шт филе) — это уже вес: единицу OCR прочитал
    // неверно. Умножать на вес коробки нельзя (было бы 4 536 кг).
    cands.push({ factor: 1, source: 'same', note: `${fmt(q)} ${fromLabel} — количество дробное, считаем что это уже ${toLabel}` });
  } else if (from.cls === 'count' && target.cls !== 'count') {
    // штуки/упаковки → кг/л: нужен вес единицы. У тары (контейнер, стакан,
    // бутылка, мешок…) объём — это вместимость, а не содержимое: «Контейнер
    // 500мл» × 500 шт — не 250 кг. Массу тары (фасовка «1400гр») оставляем.
    const container = isContainerProduct(name);
    const usable = container ? pack.measures.filter(m => MEASURE_CLS[m.unit] === 'mass') : pack.measures;
    const same = usable.filter(m => MEASURE_CLS[m.unit] === target.cls);
    const ordered = [...same.filter(m => m.kind === 'nominal'), ...same.filter(m => m.kind === 'net'), ...same.filter(m => m.kind === 'drained')];
    let m = ordered[0] ?? null;
    let densityNote = '';
    if (!m) {
      const cross = usable.find(x => MEASURE_CLS[x.unit] !== target.cls);
      if (cross) { m = cross; densityNote = ' (1 л = 1 кг, плотность не учтена)'; }
    }
    if (m) {
      const perUnit = (m.value * MEASURE_TO_BASE[m.unit]) / target.toBase;
      const perLabel = `${fmt(m.value)} ${m.unit}`;
      const packCount = from.isCase ? (pack.perPack ?? (input.llmPackHint && input.llmPackHint > 1 ? input.llmPackHint : null)) : null;
      if (from.isCase && packCount) {
        cands.push({ factor: packCount * perUnit, source: 'name_count', note: `${fmt(q)} ${fromLabel} × ${fmt(packCount)} × ${perLabel} = ${fmt(q * packCount * perUnit)} ${toLabel}${densityNote}` });
        cands.push({ factor: perUnit, source: 'name', note: `${fmt(q)} ${fromLabel} × ${perLabel} = ${fmt(q * perUnit)} ${toLabel}${densityNote}` });
      } else {
        cands.push({ factor: perUnit, source: 'name', note: `${fmt(q)} ${fromLabel} × ${perLabel} = ${fmt(q * perUnit)} ${toLabel}${densityNote}` });
        // «500*5г» за 1 шт — возможно, это коробка: запасной кандидат для проверки ценой.
        if (pack.perPack && pack.countTimesMeasure) {
          cands.push({ factor: pack.perPack * perUnit, source: 'name_count', note: `${fmt(q)} ${fromLabel} × ${fmt(pack.perPack)} × ${perLabel} = ${fmt(q * pack.perPack * perUnit)} ${toLabel}${densityNote}` });
        }
      }
    } else if (input.legacyPack && input.legacyPack.size > 0) {
      const lu = canonUnit(input.legacyPack.unit);
      if (lu && lu.cls !== 'count') {
        const perUnit = (input.legacyPack.size * lu.toBase) / target.toBase;
        const dn = lu.cls !== target.cls ? ' (1 л = 1 кг, плотность не учтена)' : '';
        cands.push({ factor: perUnit, source: 'legacy', note: `${fmt(q)} ${fromLabel} × ${fmt(input.legacyPack.size)} ${lu.unit} = ${fmt(q * perUnit)} ${toLabel} (сохранённая упаковка)${dn}` });
      }
    }
    if (!cands.length) {
      noConversion = pack.ranges.length
        ? { flag: 'needs_weight', note: `вес упаковки плавающий (${pack.ranges.map(r => `${fmt(r.low)}–${fmt(r.high)} ${r.unit}`).join(', ')}) — укажите фактический вес в ${toLabel}` }
        : { flag: 'unit_mismatch', note: `в 1С учёт в «${outUnit}», в накладной — «${raw.unit ?? 'шт'}», а вес единицы в названии не найден` };
    }
  } else if (from.cls === 'count' && target.cls === 'count') {
    if (from.isCase && !target.isCase) {
      const n = from.unit === 'кор' || from.unit === 'ящ'
        ? (pack.perCase ?? pack.perPack)
        : (pack.perPack ?? null);
      const cnt = n ?? (input.llmPackHint && input.llmPackHint > 1 ? input.llmPackHint : null);
      cands.push(cnt
        ? { factor: cnt, source: 'name_count', note: `${fmt(q)} ${fromLabel} × ${fmt(cnt)} шт = ${fmt(q * cnt)} ${toLabel}` }
        : { factor: 1, source: 'same', note: '' });
    } else {
      cands.push({ factor: 1, source: 'same', note: '' });
    }
  } else {
    // кг/л → штуки: делим на вес штуки, если он в названии и получается целое.
    // Только для «крупных» штук (≥100 г/мл) и не больше 500 штук: при мелких
    // (стик 14 г) ошибочная единица «кг» в накладной давала бы тысячи штук.
    const pieceMeasures = pack.measures.filter(m => MEASURE_CLS[m.unit] === from.cls);
    for (const pm of pieceMeasures) {
      const pieceBase = pm.value * MEASURE_TO_BASE[pm.unit];
      if (pieceBase < 0.1) continue;
      const pieces = (q * from.toBase) / pieceBase;
      const rounded = Math.round(pieces);
      if (rounded >= 1 && rounded <= 500 && Math.abs(pieces - rounded) <= 0.05 * pieces) {
        cands.push({ factor: rounded / q, source: 'name', note: `${fmt(q)} ${fromLabel} ÷ ${fmt(pm.value)} ${pm.unit} = ${rounded} ${toLabel}` });
        break;
      }
    }
    if (!cands.length) {
      noConversion = { flag: 'unit_mismatch', note: `в 1С учёт в «${outUnit}», в накладной — «${raw.unit ?? ''}»: без веса штуки пересчитать нельзя` };
    }
  }

  if (!cands.length) {
    return {
      ...passthrough, price: priceFor(q),
      source: 'none', flag: noConversion?.flag ?? 'unit_mismatch', flagNote: noConversion?.note ?? null,
    };
  }

  // Выбор кандидата: по медиане цены позиции; без неё — по правдоподобию цены.
  const priceOf = (c: Cand) => (total != null ? total / (q * c.factor) : null);
  let chosen = cands[0];
  let flag: QtyFlag | null = null;
  let flagNote: string | null = null;
  let fitNote = '';
  const median = input.medianPrice && input.medianPrice > 0 ? input.medianPrice : null;
  if (median && total != null) {
    // История цен может ОТВЕРГНУТЬ неправдоподобный вариант по умолчанию, но не
    // перебить правдоподобный: в истории есть строки, пересчитанные до v2 с
    // ошибкой («Масло фритюрное 5л 1/2» — 15 кг вместо 30), и подгонка под них
    // закрепляла бы старую ошибку.
    const ratioOf = (c: Cand) => (priceOf(c) as number) / median;
    const within = (r: number) => r >= 1 / 3 && r <= 3;
    if (!within(ratioOf(cands[0]))) {
      const score = (c: Cand) => Math.abs(Math.log(ratioOf(c)));
      const best = cands.reduce((a, b) => (score(b) < score(a) ? b : a));
      if (best !== cands[0] && within(ratioOf(best))) {
        chosen = best;
        fitNote = ' — подобрано по истории цен';
      } else {
        const ratio = ratioOf(cands[0]);
        flag = 'price_outlier';
        flagNote = `цена ${fmt(priceOf(cands[0]) as number)} ₽ за ${toLabel} отличается от обычной (${fmt(median)} ₽) в ${fmt(Math.max(ratio, 1 / ratio))} раза — проверьте количество`;
      }
    }
  } else if (total != null && target.cls !== 'count' && cands.length > 1) {
    const plausible = (c: Cand) => { const p = priceOf(c) as number; return p >= PLAUSIBLE_PER_BASE.min && p <= PLAUSIBLE_PER_BASE.max; };
    if (!plausible(cands[0])) {
      const alt = cands.find(plausible);
      if (alt) { chosen = alt; fitNote = ' — подобрано по правдоподобию цены, проверьте'; }
    }
  }
  if (!flag && total != null && target.cls !== 'count' && !median) {
    const p = priceOf(chosen) as number;
    if (p < PLAUSIBLE_PER_BASE.min || p > PLAUSIBLE_PER_BASE.max) {
      flag = 'price_outlier';
      flagNote = `цена ${fmt(p)} ₽ за ${toLabel} неправдоподобна — проверьте количество`;
    }
  }

  const newQty = r3(q * chosen.factor);
  const source: ConvSource = fitNote ? 'price_fit' : chosen.source;
  return {
    quantity: newQty,
    unit: outUnit,
    price: priceFor(newQty),
    total,
    factor: chosen.factor,
    source,
    note: chosen.note ? chosen.note + fitNote : null,
    flag,
    flagNote,
  };
}
