import { getDb } from '../database/db';
import { automationRepo, AutomationSettings } from '../database/repositories/automationRepo';
import { rowAlignmentProblems, priceShiftProblems, UsualPriceLookup } from '../ocr/invoiceValidator';
import { canonUnit } from '../mapping/unitConverter';
import { robustMedian } from '../pricing/medianOf';
import { isXmlInvoice } from '../xml';
import { storedInvoiceCompleteness } from '../services/invoiceCompleteness';

export interface QualitySubject {
  status: string;
  duplicate_of: number | null;
  invoice_number: string | null;
  invoice_date: string | null;
  supplier: string | null;
  total_sum: number | null;
  items_total_mismatch: number;
  items_count: number;
  unmapped_count: number;
  min_confidence: number | null;
  supplier_verified: number;
  /** invoices.supplier_match; 'name' — реквизиты подобраны по названию, а не по ИНН. */
  supplier_match?: string | null;
  /** Строки с флагом пересчёта (qty_flag): количество под вопросом. */
  flagged_items?: number;
  /** Признаки сдвига названий относительно чисел (строка без чисел, одно название у соседних строк, цены соседей). */
  alignment_problems?: string[];
  completeness_message?: string | null;
}

export interface QualityReason {
  code: string;
  message: string;
}

export interface QualityResult {
  allowed: boolean;
  score: number;
  reasons: QualityReason[];
  settings: AutomationSettings;
}

export function evaluateQualitySubject(subject: QualitySubject, settings: AutomationSettings): Omit<QualityResult, 'settings'> {
  const reasons: QualityReason[] = [];
  const add = (code: string, message: string) => reasons.push({ code, message });

  if (subject.status !== 'processed') add('status', 'Распознавание ещё не завершено успешно');
  if (subject.duplicate_of != null || subject.status === 'duplicate') add('duplicate', 'Документ отмечен как дубликат');
  if (!subject.invoice_number) add('invoice_number', 'Не распознан номер накладной');
  if (!subject.invoice_date) add('invoice_date', 'Не распознана дата накладной');
  if (!subject.supplier) add('supplier', 'Не распознан поставщик');
  if (subject.total_sum == null || subject.total_sum <= 0) add('total', 'Не распознана положительная сумма');
  if (subject.items_count <= 0) add('items', 'В документе нет товарных позиций');
  if (subject.completeness_message) add('incomplete_pages', subject.completeness_message);
  if (settings.block_total_mismatch && subject.items_total_mismatch === 1) {
    add('total_mismatch', 'Сумма позиций расходится с итогом накладной');
  }
  if (settings.require_all_mapped && subject.unmapped_count > 0) {
    add('unmapped', `Не сопоставлено с 1С: ${subject.unmapped_count}`);
  }
  if (subject.items_count > 0 && subject.min_confidence != null && subject.min_confidence < settings.min_mapping_confidence) {
    add('low_confidence', `Минимальная точность ${(subject.min_confidence * 100).toFixed(0)}% ниже порога ${(settings.min_mapping_confidence * 100).toFixed(0)}%`);
  }
  if (settings.max_total != null && (subject.total_sum ?? 0) > settings.max_total) {
    add('amount_limit', `Сумма выше лимита автопилота ${settings.max_total.toFixed(2)} ₽`);
  }
  if (settings.payment_approval_threshold != null
      && (subject.total_sum ?? 0) > settings.payment_approval_threshold) {
    add('approval_required', `Сумма требует согласования от ${settings.payment_approval_threshold.toFixed(2)} ₽`);
  }
  if (settings.require_verified_supplier && subject.supplier_verified !== 1) {
    add('supplier_unverified', 'Реквизиты поставщика не подтверждены');
  }
  // Карточку подобрали по названию: ИНН на фото с ней не совпал. Автопилот
  // такое не отправляет — сначала человек подтверждает поставщика.
  if ((subject.flagged_items ?? 0) > 0) {
    add('unit_suspect', `Количество под вопросом: ${subject.flagged_items} ${subject.flagged_items === 1 ? 'строка' : 'строк(и)'} — проверьте пересчёт единиц`);
  }
  if (subject.supplier_match === 'name') {
    add('supplier_by_name', 'Реквизиты поставщика подобраны по названию, а не по ИНН');
  }
  // Названия строк сдвинуты относительно чисел (фото под углом) — позиции и
  // количества в 1С ушли бы не те. Накладная 783, 30.09.2026.
  if ((subject.alignment_problems ?? []).length > 0) {
    add('rows_misaligned', `Строки, похоже, сдвинуты при распознавании: ${subject.alignment_problems!.join('; ')} — сверьте с фото`);
  }

  return {
    allowed: reasons.length === 0,
    score: Math.max(0, 100 - reasons.length * 14),
    reasons,
  };
}

export async function evaluateInvoiceQuality(invoiceId: number): Promise<QualityResult> {
  const subject = await getDb().prepare(`
    SELECT i.status, i.duplicate_of, i.invoice_number, i.invoice_date,
           i.supplier, i.total_sum, COALESCE(i.items_total_mismatch, 0) AS items_total_mismatch,
           i.supplier_match,
           SUM(CASE WHEN ii.qty_flag IS NOT NULL THEN 1 ELSE 0 END) AS flagged_items,
           COUNT(ii.id) AS items_count,
           SUM(CASE WHEN ii.id IS NOT NULL AND (ii.onec_guid IS NULL OR ii.onec_guid = '') THEN 1 ELSE 0 END) AS unmapped_count,
           MIN(CASE WHEN ii.id IS NOT NULL THEN COALESCE(ii.mapping_confidence, 0) END) AS min_confidence,
           MAX(COALESCE(s.verified, 0)) AS supplier_verified
      FROM invoices i
      LEFT JOIN invoice_items ii ON ii.invoice_id = i.id
      LEFT JOIN supplier_cards s ON s.inn = i.supplier_inn AND s.owner_user_id = i.owner_user_id
     WHERE i.id = ?
     GROUP BY i.id
  `).get<QualitySubject>(invoiceId);
  const settings = await automationRepo.get();
  if (!subject) {
    return { allowed: false, score: 0, reasons: [{ code: 'missing', message: 'Накладная не найдена' }], settings };
  }
  subject.alignment_problems = await storedAlignmentProblems(invoiceId);
  subject.completeness_message = (await storedInvoiceCompleteness(invoiceId)).message;
  return { ...evaluateQualitySubject(subject, settings), settings };
}

/**
 * Признаки сдвига по сохранённым строкам (как напечатано — raw_*, иначе
 * итоговые значения), в порядке записи. Номер строки из «№» в базе не хранится,
 * поэтому проверяются строка без чисел и одно название у соседних строк.
 * Электронный документ (XML) не распознаётся — сдвинуться строкам не из-за чего,
 * а одно название у соседних строк там обычное дело (две партии, две цены).
 */
export async function storedAlignmentProblems(invoiceId: number): Promise<string[]> {
  const rows = await getDb().prepare(`
    SELECT ii.original_name, COALESCE(ii.raw_quantity, ii.quantity) AS q, COALESCE(ii.raw_unit, ii.unit) AS u,
           COALESCE(ii.raw_price, ii.price) AS p, COALESCE(ii.raw_total, ii.total) AS t, ii.row_no, i.owner_user_id,
           i.ocr_engine, i.file_name
      FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
     WHERE ii.invoice_id = ? ORDER BY COALESCE(ii.row_no, 1000000), ii.id
  `).all<{ original_name: string; q: number | null; u: string | null; p: number | null; t: number | null; row_no: number | null; owner_user_id: number | null; ocr_engine: string | null; file_name: string | null }>(invoiceId);
  if (rows.length && isXmlInvoice(rows[0])) return [];
  // 0 в сохранённой строке — то же «нет числа», что null в ответе модели.
  const num = (v: unknown) => (v == null || Number(v) === 0 ? undefined : Number(v));
  const items = rows.map(r => ({
    name: r.original_name, quantity: num(r.q), unit: r.u ?? undefined, price: num(r.p), total: num(r.t), row_no: num(r.row_no),
  }));
  const problems = rowAlignmentProblems(items);
  const owner = rows[0]?.owner_user_id;
  if (owner != null && items.length >= 3) {
    const usual = await usualPriceLookup(owner, invoiceId, items.map(it => it.name));
    problems.push(...priceShiftProblems(items, usual));
  }
  return problems;
}

const priceKey = (name: unknown, unit: unknown) =>
  `${String(name ?? '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim()}|${canonUnit(unit as string | null)?.unit ?? String(unit ?? '').toLowerCase().trim()}`;

/**
 * Обычная цена по истории компании: устойчивая медиана последних 20 строк с тем
 * же названием и единицей (как напечатано), без этой накладной; меньше 3 — null.
 */
async function usualPriceLookup(ownerUserId: number, excludeInvoiceId: number, names: string[]): Promise<UsualPriceLookup> {
  const uniq = [...new Set(names.map(n => String(n ?? '').trim()).filter(Boolean))].slice(0, 200);
  if (!uniq.length) return () => null;
  const rows = await getDb().prepare(`
    SELECT ii.original_name AS name, COALESCE(ii.raw_unit, ii.unit) AS unit, COALESCE(ii.raw_price, ii.price) AS price
      FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
     WHERE i.owner_user_id = ? AND ii.invoice_id <> ? AND ii.original_name IN (${uniq.map(() => '?').join(',')})
       AND COALESCE(ii.raw_price, ii.price) > 0
     ORDER BY ii.id DESC LIMIT 5000
  `).all<{ name: string; unit: string | null; price: number | string }>(ownerUserId, excludeInvoiceId, ...uniq);
  const byKey = new Map<string, number[]>();
  for (const r of rows) {
    const k = priceKey(r.name, r.unit);
    const list = byKey.get(k) ?? [];
    if (list.length < 20) list.push(Number(r.price));
    byKey.set(k, list);
  }
  return (name, unit) => robustMedian(byKey.get(priceKey(name, unit)) ?? [], 5, 3);
}
