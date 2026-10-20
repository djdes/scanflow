import { createHash } from 'node:crypto';

export const COST_UNITS = ['piece', 'label', 'sheet', 'pair'] as const;
export type CostUnit = typeof COST_UNITS[number];
export interface CostLine {
  id: number; invoice_id: number; original_name: string;
  quantity: number | null; unit: string | null; price: number | null; total: number | null;
  raw_quantity?: number | null; raw_unit?: string | null; raw_price?: number | null; raw_total?: number | null;
}
export interface CostFormula { units_per_pack: number; unit_kind: CostUnit }
export interface CostCalculation extends CostFormula {
  packages: number; source_unit: string; total_units: number; total: number; unit_price: number;
  evidence: string; source: 'name' | 'rule' | 'manual';
}
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Keep sizes/counts/punctuation: a 100-piece pack must never inherit a 50-piece formula. */
export const costNameKey = (name: string) => sha(name.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim());
export const costRawUnit = (line: CostLine) => String(line.raw_quantity != null ? line.raw_unit ?? '' : line.unit ?? '')
  .toLowerCase().replace(/[.\s]/g, '');
const COUNT_UNITS = /^(?:шт|штука|штуки|штук|рул|рулон|рулоны|рулонов|уп|упак|упаковка|упаковки|пач|пачка|кор|коробка|компл|набор)$/;
export function validCostFormula(value: unknown): value is CostFormula {
  const formula = value as CostFormula | null;
  return !!formula && typeof formula.units_per_pack === 'number' && Number.isSafeInteger(formula.units_per_pack)
    && formula.units_per_pack >= 1 && formula.units_per_pack <= 1e9 && COST_UNITS.includes(formula.unit_kind);
}
export function costBasis(line: CostLine): { packages: number; total: number; source_unit: string } | null {
  const hasRaw = line.raw_quantity != null;
  const packages = hasRaw ? line.raw_quantity : line.quantity;
  const source_unit = costRawUnit(line);
  if (typeof packages !== 'number' || !Number.isFinite(packages) || packages <= 0 || packages > 1e12 || !COUNT_UNITS.test(source_unit)) return null;
  // The document amount takes precedence. Never divide a converted kg quantity by a roll count.
  const amount = line.total ?? line.raw_total;
  const sourcePrice = hasRaw ? line.raw_price : line.price;
  const total = amount ?? (sourcePrice != null ? packages * sourcePrice : null);
  if (typeof total !== 'number' || !Number.isFinite(total) || total < 0 || total > 1e14) return null;
  return { packages, total, source_unit };
}
export function detectCostFormula(name: string): (CostFormula & { evidence: string }) | null {
  const text = name.normalize('NFKC').toLowerCase();
  const number = '(?:[1-9]\\d{0,2}(?:[ \\u00a0\\u202f]\\d{3})+|[1-9]\\d*)';
  const count = new RegExp(`(${number})\\s*(шт(?:ук(?:а|и)?)?\\.?|этикет(?:ок|ки|ка)|лист(?:ов|а)?|пар(?:а|ы)?)(?![а-яa-z])`, 'gi');
  const hits = [...text.matchAll(count)];
  // Different count statements may describe nested cartons or alternative packaging.
  if (hits.length !== 1) return null;
  const hit = hits[0];
  const prefix = text.slice(0, hit.index);
  // Do not reinterpret decimal counts, dimensions, ranges or an unlabelled multiplier.
  if (/[\d.,/×xх*+-]\s*$/.test(prefix) || /\d\s*[-–]\s*$/.test(prefix)) return null;
  const isLabel = /этикет/.test(text);
  if (/\d+\s*(?:рулон|рул\.|упаков|пачк|короб)/.test(text)) return null;
  const isPackaging = /рулон|\broll\b|упаков|упак|пачк|короб|в\s+наб[оo]ре/.test(text);
  if (!isLabel && !isPackaging) return null;
  let units = Number(hit[1].replace(/\s/g, ''));
  let evidence = hit[0];
  // Explicit statement: «рядов 2 по 2 000 шт» = 4 000 labels in a roll.
  const row = prefix.match(/(?:рядов|ряда|ряд)\s+(\d+)\s+по\s*$/);
  if (row) { units *= Number(row[1]); evidence = `${row[1]} ряд. × ${hit[0]}`; }
  // A row count elsewhere is ambiguous: ask the person rather than silently ignore it.
  else if (/(?:рядов|ряда|ряд)\s*\d|\d+\s*ряд/.test(text)) return null;
  const unit_kind: CostUnit = isLabel ? 'label' : /лист/.test(hit[2]) ? 'sheet' : /пар/.test(hit[2]) ? 'pair' : 'piece';
  const formula = { units_per_pack: units, unit_kind };
  return validCostFormula(formula) && units > 1 ? { ...formula, evidence } : null;
}
export function calculateUnitCost(line: CostLine, formula?: CostFormula | null, source?: CostCalculation['source']): CostCalculation | null {
  const basis = costBasis(line);
  const detected = formula ? null : detectCostFormula(line.original_name);
  const selected = formula ?? detected;
  if (!basis || !validCostFormula(selected)) return null;
  const total_units = basis.packages * selected.units_per_pack;
  if (!Number.isFinite(total_units) || total_units <= 0 || total_units > Number.MAX_SAFE_INTEGER) return null;
  const unit_price = basis.total / total_units;
  if (!Number.isFinite(unit_price)) return null;
  return { units_per_pack: selected.units_per_pack, unit_kind: selected.unit_kind, ...basis,
    total_units, unit_price, evidence: detected?.evidence ?? '', source: source ?? (formula ? 'rule' : 'name') };
}
/** Optimistic token includes source values AND the currently saved formula. */
export function costReviewToken(line: CostLine, supplierKey: string, rule: CostFormula | null): string {
  return sha([line.id, line.invoice_id, line.original_name, supplierKey,
    line.quantity, line.unit, line.price, line.total, line.raw_quantity ?? null, line.raw_unit ?? null,
    line.raw_price ?? null, line.raw_total ?? null, rule?.units_per_pack ?? null, rule?.unit_kind ?? null]);
}
