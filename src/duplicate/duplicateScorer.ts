import { normalizeInvoiceNumber, suppliersMatch } from '../utils/invoiceNumber';

export interface DuplicateItemLike {
  name?: string | null;
  original_name?: string | null;
  quantity?: number | null;
  total?: number | null;
}
export interface DuplicateDocumentLike {
  invoice_number: string | null;
  invoice_date: string | null;
  supplier: string | null;
  supplier_inn: string | null;
  total_sum: number | null;
  supplier_account?: string | null;
  supplier_bik?: string | null;
  items?: DuplicateItemLike[];
}

export interface DuplicateEvidence {
  score: number;
  reasons: string[];
  item_similarity: number | null;
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const old = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = old;
    }
  }
  return previous[b.length];
}

function normalizeItemName(value: string): Set<string> {
  const normalized = value.toLocaleLowerCase('ru-RU')
    .replace(/[^a-zа-яё0-9]+/gi, ' ')
    .trim();
  return new Set(normalized.split(/\s+/).filter(token => token.length > 1));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const value of a) if (b.has(value)) shared++;
  return shared / (a.size + b.size - shared);
}

function itemSimilarity(a: DuplicateItemLike[] = [], b: DuplicateItemLike[] = []): number | null {
  if (a.length === 0 || b.length === 0) return null;
  const smaller = a.length <= b.length ? a : b;
  const larger = a.length <= b.length ? b : a;
  let sum = 0;
  for (const item of smaller) {
    const name = item.name || item.original_name || '';
    let best = 0;
    for (const candidate of larger) {
      const candidateName = candidate.name || candidate.original_name || '';
      let score = jaccard(normalizeItemName(name), normalizeItemName(candidateName));
      if (item.total != null && candidate.total != null) {
        const tolerance = Math.max(1, Math.abs(item.total) * 0.01);
        if (Math.abs(item.total - candidate.total) <= tolerance) score = Math.min(1, score + 0.15);
      }
      if (item.quantity != null && candidate.quantity != null && Math.abs(item.quantity - candidate.quantity) < 0.001) {
        score = Math.min(1, score + 0.1);
      }
      best = Math.max(best, score);
    }
    sum += best;
  }
  const countRatio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
  return (sum / smaller.length) * 0.8 + countRatio * 0.2;
}

function dateDistanceDays(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const left = Date.parse(`${a}T00:00:00Z`);
  const right = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return Math.round(Math.abs(left - right) / 86400000);
}

export function scoreDuplicate(incoming: DuplicateDocumentLike, candidate: DuplicateDocumentLike): DuplicateEvidence {
  const reasons: string[] = [];
  let score = 0;

  const aNumber = normalizeInvoiceNumber(incoming.invoice_number);
  const bNumber = normalizeInvoiceNumber(candidate.invoice_number);
  const distance = editDistance(aNumber, bNumber);
  if (aNumber && aNumber === bNumber) { score += 0.25; reasons.push('Совпадает номер'); }
  else if (aNumber.length >= 4 && bNumber.length >= 4 && distance <= 1) { score += 0.215; reasons.push('Номер отличается на один символ'); }

  const supplierMatches = incoming.supplier_inn && candidate.supplier_inn
    ? incoming.supplier_inn === candidate.supplier_inn
    : suppliersMatch(incoming.supplier, candidate.supplier);
  if (supplierMatches) { score += 0.20; reasons.push('Совпадает поставщик'); }

  const dateDistance = dateDistanceDays(incoming.invoice_date, candidate.invoice_date);
  if (dateDistance === 0) { score += 0.15; reasons.push('Совпадает дата'); }
  else if (dateDistance != null && dateDistance <= 3) { score += 0.08; reasons.push(`Дата отличается на ${dateDistance} дн.`); }

  if (incoming.total_sum != null && candidate.total_sum != null) {
    const difference = Math.abs(incoming.total_sum - candidate.total_sum);
    const tolerance = Math.max(2, Math.abs(incoming.total_sum) * 0.005);
    if (difference <= 1) { score += 0.20; reasons.push('Совпадает сумма'); }
    else if (difference <= tolerance) { score += 0.16; reasons.push('Сумма отличается не более чем на 0,5%'); }
  }

  const items = itemSimilarity(incoming.items, candidate.items);
  if (items == null) {
    score += 0.11; // neutral: preserves the established business-key detector
  } else if (items >= 0.8) {
    score += 0.15; reasons.push(`Состав позиций совпадает на ${Math.round(items * 100)}%`);
  } else if (items >= 0.6) {
    score += 0.09; reasons.push(`Состав позиций похож на ${Math.round(items * 100)}%`);
  }

  const accountMatch = incoming.supplier_account && candidate.supplier_account
    && incoming.supplier_account === candidate.supplier_account;
  const bicMatch = incoming.supplier_bik && candidate.supplier_bik
    && incoming.supplier_bik === candidate.supplier_bik;
  if (accountMatch || bicMatch) { score += 0.05; reasons.push('Совпадают банковские реквизиты'); }

  return { score: Math.min(1, score), reasons, item_similarity: items };
}
