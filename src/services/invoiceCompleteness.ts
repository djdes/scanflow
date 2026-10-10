import { getDb } from '../database/db';
import { invoiceCompleteness, type InvoiceCompleteness } from '../ocr/invoiceCompleteness';

export async function storedInvoiceCompleteness(invoiceId: number): Promise<InvoiceCompleteness> {
  const rows = await getDb().prepare(`
    SELECT i.ocr_engine, i.file_name, i.pages_confirmed, ii.id AS item_id, ii.row_no
    FROM invoices i LEFT JOIN invoice_items ii ON ii.invoice_id = i.id
    WHERE i.id = ? ORDER BY ii.id
  `).all<{ ocr_engine: string | null; file_name: string | null; pages_confirmed: number | null; item_id: number | null; row_no: number | null }>(invoiceId);
  return invoiceCompleteness({ ...rows[0], items: rows.filter(r => r.item_id != null) });
}
