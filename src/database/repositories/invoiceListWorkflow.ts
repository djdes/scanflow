import { FINAL_BANK_STATUSES, bankStatusKind } from '../../sber/payments';

// These statuses are fixed application constants, never request parameters.
const failedBankStatuses = FINAL_BANK_STATUSES.filter(s => bankStatusKind(s) === 'failed')
  .map(s => `'${s}'`).join(',');
export const FAILED_PAYMENT_SQL = `invoices.paid_externally = 0 AND EXISTS (
  SELECT 1 FROM sber_payments wp WHERE wp.invoice_id = invoices.id
    AND (wp.status = 'failed' OR wp.bank_status IN (${failedBankStatuses}))
)`;

/** Shared predicates for list tabs and summary cards. Values never come from SQL input. */
export const REVIEW_REASON_SQL = `CASE
  WHEN invoices.status = 'error' THEN 'error'
  WHEN invoices.status = 'duplicate'
    OR (invoices.status = 'processed' AND invoices.duplicate_of IS NOT NULL) THEN 'duplicate'
  WHEN invoices.status = 'processed' AND invoices.items_total_mismatch = 1
    AND invoices.attr_checked_total = 0 THEN 'total'
  WHEN invoices.status = 'processed' AND (
    COALESCE(TRIM(invoices.invoice_number), '') = '' OR invoices.invoice_date IS NULL
    OR COALESCE(TRIM(invoices.supplier), '') = '' OR COALESCE(TRIM(invoices.supplier_inn), '') = ''
    OR COALESCE(invoices.total_sum, 0) <= 0
  ) THEN 'header'
  WHEN invoices.status = 'processed' AND NOT EXISTS (
    SELECT 1 FROM invoice_items wi WHERE wi.invoice_id = invoices.id
  ) THEN 'items'
  WHEN invoices.status = 'processed' AND EXISTS (
    SELECT 1 FROM invoice_items wi WHERE wi.invoice_id = invoices.id
      AND COALESCE(wi.qty_flag, '') <> ''
  ) THEN 'quantity'
  WHEN invoices.status = 'processed' AND EXISTS (
    SELECT 1 FROM invoice_items wi WHERE wi.invoice_id = invoices.id
      AND COALESCE(wi.onec_guid, '') = ''
  ) THEN 'mapping'
  WHEN invoices.status = 'processed' AND invoices.supplier_match = 'name' THEN 'supplier'
  ELSE NULL END`;

export const INVOICE_VIEW_SQL = {
  attention: `(${REVIEW_REASON_SQL}) IS NOT NULL`,
  ready: `invoices.status = 'processed' AND invoices.approved_for_1c = 0
    AND (${REVIEW_REASON_SQL}) IS NULL`,
  queue: `invoices.status = 'processed' AND invoices.approved_for_1c = 1`,
  payment: `invoices.status IN ('processed', 'sent_to_1c')
    AND invoices.duplicate_of IS NULL AND invoices.paid_externally = 0
    AND COALESCE(TRIM(invoices.supplier_inn), '') <> '' AND invoices.total_sum > 0
    AND NOT EXISTS (SELECT 1 FROM sber_payments wp
      WHERE wp.invoice_id = invoices.id AND wp.status <> 'failed'
        AND COALESCE(wp.bank_status, '') NOT IN (${failedBankStatuses}))`,
} as const;

export type InvoiceListView = keyof typeof INVOICE_VIEW_SQL;

export function isInvoiceListView(value: unknown): value is InvoiceListView {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(INVOICE_VIEW_SQL, value);
}
