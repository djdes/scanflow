import { getDb } from '../database/db';
import { automationRepo, AutomationSettings } from '../database/repositories/automationRepo';

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
           COUNT(ii.id) AS items_count,
           SUM(CASE WHEN ii.id IS NOT NULL AND (ii.onec_guid IS NULL OR ii.onec_guid = '') THEN 1 ELSE 0 END) AS unmapped_count,
           MIN(CASE WHEN ii.id IS NOT NULL THEN COALESCE(ii.mapping_confidence, 0) END) AS min_confidence,
           MAX(COALESCE(s.verified, 0)) AS supplier_verified
      FROM invoices i
      LEFT JOIN invoice_items ii ON ii.invoice_id = i.id
      LEFT JOIN suppliers s ON s.inn = i.supplier_inn
     WHERE i.id = ?
     GROUP BY i.id
  `).get<QualitySubject>(invoiceId);
  const settings = await automationRepo.get();
  if (!subject) {
    return { allowed: false, score: 0, reasons: [{ code: 'missing', message: 'Накладная не найдена' }], settings };
  }
  return { ...evaluateQualitySubject(subject, settings), settings };
}
