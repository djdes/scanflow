import { itemNameKey } from '../mapping/nameKey';
import { canonUnit, parsePack } from '../mapping/unitConverter';

/**
 * Детерминированный «разбор правок» (пакет v2, п.15) — чистые функции.
 *
 * На входе — то, что накопилось за последние недели: ручные правки
 * количества (edit_log) и строки, где пересчёт единиц не уверен (qty_flag).
 * На выходе — ПРЕДЛОЖЕНИЯ правил пересчёта «поставщик + товар». Сами правила
 * создаются только после подтверждения человеком (страница «Предложения правил»).
 */
export interface QtyEdit {
  name: string;
  supplier_key: string;
  raw_quantity: number;
  raw_unit: string;
  new_quantity: number;
  onec_unit: string;
  invoice_id: number;
  item_id: number;
}

export interface FlaggedLine {
  id: number;
  invoice_id: number;
  name: string;
  supplier_key: string;
  raw_quantity: number;
  raw_unit: string;
  raw_total: number;
  onec_unit: string | null;
  onec_name: string | null;
  flag: string;
  median: number | null;
}

export interface UnitRuleProposal {
  kind: 'unit_rule';
  supplier_key: string;
  name_key: string;
  title: string;
  payload: { raw_unit: string; target_unit: string; factor: number; name: string };
  evidence: { count: number; examples: Array<Record<string, unknown>>; why: string };
  source: 'miner' | 'llm';
}

const fmt = (x: number) => String(Math.round(x * 1000) / 1000).replace('.', ',');
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Ручные правки количества с устойчивым коэффициентом (±3%) → правило. */
export function mineFromEdits(edits: QtyEdit[]): UnitRuleProposal[] {
  const groups = new Map<string, QtyEdit[]>();
  for (const e of edits) {
    const from = canonUnit(e.raw_unit);
    const to = canonUnit(e.onec_unit);
    if (!from || !to || !(e.raw_quantity > 0) || !(e.new_quantity > 0)) continue;
    // Правка в той же единице — исправление OCR, а не пересчёт.
    if (from.unit === to.unit) continue;
    const key = [e.supplier_key, itemNameKey(e.name), from.unit, to.unit].join('|');
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(e);
  }
  const out: UnitRuleProposal[] = [];
  for (const [key, list] of groups) {
    const factors = list.map(e => e.new_quantity / e.raw_quantity);
    const m = median(factors);
    if (!factors.every(f => Math.abs(f - m) <= 0.03 * m)) continue;
    const [supplierKey, nameKey, fromU, toU] = key.split('|');
    const factor = Math.round(m * 10000) / 10000;
    out.push({
      kind: 'unit_rule', supplier_key: supplierKey, name_key: nameKey,
      title: `«${list[0].name}»: 1 ${fromU} = ${fmt(factor)} ${toU}${list.length > 1 ? ` (исправлено вручную ${list.length} раз)` : ' (исправлено вручную)'}`,
      payload: { raw_unit: fromU, target_unit: toU, factor, name: list[0].name },
      evidence: {
        count: list.length,
        examples: list.slice(0, 5).map(e => ({ invoice_id: e.invoice_id, item_id: e.item_id, from: `${e.raw_quantity} ${fromU}`, to: `${e.new_quantity} ${toU}` })),
        why: 'одинаковый коэффициент в ручных правках количества',
      },
      source: 'miner',
    });
  }
  return out;
}

/** «Круглые» коэффициенты из названия: вес единицы, упаковка × вес, штук в упаковке. */
function niceFactors(name: string, targetUnit: string): number[] {
  const to = canonUnit(targetUnit);
  if (!to) return [];
  const pack = parsePack(name);
  const out: number[] = [];
  for (const m of pack.measures) {
    const mu = canonUnit(m.unit);
    if (!mu || mu.cls === 'count') continue;
    const per = (m.value * mu.toBase) / to.toBase;
    out.push(per);
    if (pack.perPack) out.push(per * pack.perPack);
    if (pack.perCase) out.push(per * pack.perCase);
  }
  if (to.cls === 'count') {
    if (pack.perPack) out.push(pack.perPack);
    if (pack.perCase) out.push(pack.perCase);
  }
  return out.filter(f => f > 0);
}

/**
 * Строки с выбросом цены: какой коэффициент вернул бы цену к обычной? Если он
 * совпадает (±12%) с «круглым» числом из названия — это почти наверняка
 * верная упаковка. Иначе не гадаем.
 */
export function mineFromPriceOutliers(lines: FlaggedLine[]): UnitRuleProposal[] {
  const groups = new Map<string, { line: FlaggedLine; factor: number }[]>();
  for (const l of lines) {
    if (l.flag !== 'price_outlier' || !l.median || !l.onec_unit || !(l.raw_quantity > 0) || !(l.raw_total > 0)) continue;
    const needed = l.raw_total / l.median / l.raw_quantity;
    const nice = niceFactors(l.name, l.onec_unit).find(f => Math.abs(f - needed) <= 0.12 * needed);
    if (!nice) continue;
    const from = canonUnit(l.raw_unit)?.unit ?? l.raw_unit;
    const to = canonUnit(l.onec_unit)?.unit ?? l.onec_unit;
    const key = [l.supplier_key, itemNameKey(l.name), from, to, Math.round(nice * 1000)].join('|');
    (groups.get(key) ?? groups.set(key, []).get(key)!).push({ line: l, factor: nice });
  }
  const out: UnitRuleProposal[] = [];
  for (const [key, list] of groups) {
    const [supplierKey, nameKey, fromU, toU] = key.split('|');
    const factor = Math.round(list[0].factor * 10000) / 10000;
    out.push({
      kind: 'unit_rule', supplier_key: supplierKey, name_key: nameKey,
      title: `«${list[0].line.name}»: 1 ${fromU} = ${fmt(factor)} ${toU} (цена выбивалась из обычной)`,
      payload: { raw_unit: fromU, target_unit: toU, factor, name: list[0].line.name },
      evidence: {
        count: list.length,
        examples: list.slice(0, 5).map(({ line }) => ({
          invoice_id: line.invoice_id, item_id: line.id,
          raw: `${line.raw_quantity} ${fromU} на ${line.raw_total} ₽`, usual_price: line.median,
          price_after: Math.round((line.raw_total / (line.raw_quantity * factor)) * 100) / 100,
        })),
        why: 'с этим коэффициентом цена за единицу 1С совпадает с обычной, и он есть в названии',
      },
      source: 'miner',
    });
  }
  return out;
}
