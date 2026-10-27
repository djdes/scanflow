import { getDb } from '../database/db';
import { invoiceRepo, type Invoice } from '../database/repositories/invoiceRepo';
import { mergeBlockedByNumber } from './mergeDecision';
import { isXmlInvoice } from '../xml';
import { acquireRecognitionActivity } from './recognitionActivity';

export class ManualMergeError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Keep the source until all its items, source regions and page links have moved. */
export async function mergeInvoicePages(sourceId: number, targetId: number, owner: number) {
  const release = acquireRecognitionActivity();
  if (!release) throw new ManualMergeError(409, 'Сейчас идёт распознавание. Повторите объединение после его завершения.');
  try {
    return await getDb().transaction(async db => {
      // Lock in a stable order, and coordinate with the persistent worker across processes.
      const held = await db.prepare('SELECT expires_at > NOW() AS busy FROM recognition_worker_lease WHERE id = 1 FOR UPDATE').get<{ busy: number }>();
      if (held?.busy) throw new ManualMergeError(409, 'Сейчас идёт распознавание. Дождитесь его завершения.');
      const rows = await db.prepare('SELECT * FROM invoices WHERE id IN (?, ?) ORDER BY id FOR UPDATE').all<Invoice>(sourceId, targetId);
      const source = rows.find(row => row.id === sourceId), target = rows.find(row => row.id === targetId);
      if (!source || !target || source.owner_user_id !== owner || target.owner_user_id !== owner) throw new ManualMergeError(404, 'Накладная не найдена');
      if (isXmlInvoice(source) || isXmlInvoice(target)) throw new ManualMergeError(409, 'XML содержит цельный документ — объединять его с фотографиями нельзя.');
      if (mergeBlockedByNumber(source, target)
        || (source.invoice_date && target.invoice_date && source.invoice_date !== target.invoice_date)
        || (source.supplier_inn && target.supplier_inn && source.supplier_inn !== target.supplier_inn)) {
        throw new ManualMergeError(409, 'У накладных различаются номер, дата или ИНН поставщика. Объединять их нельзя.');
      }
      const payment = await db.prepare("SELECT id FROM sber_payments WHERE invoice_id IN (?, ?) AND status <> 'failed' LIMIT 1").get(sourceId, targetId);
      if (payment || source.paid_externally || target.paid_externally) throw new ManualMergeError(409, 'У накладной уже есть оплата или платёжный документ. Сначала проверьте оплату.');
      if ([source, target].some(row => ['new', 'ocr_processing', 'parsing', 'waiting_ai', 'error', 'duplicate'].includes(row.status) || row.duplicate_of)) {
        throw new ManualMergeError(409, 'Сначала завершите распознавание обеих страниц и проверьте дубликаты.');
      }
      const pending = await db.prepare("SELECT id FROM recognition_jobs WHERE state IN ('queued','processing','retry') AND (invoice_id IN (?, ?) OR (owner_user_id = ? AND file_hash IN (?, ?))) LIMIT 1")
        .get(sourceId, targetId, owner, source.file_hash, target.file_hash);
      if (pending) throw new ManualMergeError(409, 'Страница ещё находится в очереди распознавания. Дождитесь завершения.');
      await db.prepare(`INSERT INTO invoice_source_regions (invoice_id, filename, target_key, x, y, width, height, printed_text, origin)
        SELECT ?, s.filename, s.target_key, s.x, s.y, s.width, s.height, s.printed_text, s.origin FROM invoice_source_regions s WHERE s.invoice_id = ?
        ON DUPLICATE KEY UPDATE invoice_source_regions.id = invoice_source_regions.id`).run(targetId, sourceId);
      await db.prepare('DELETE FROM invoice_source_regions WHERE invoice_id = ?').run(sourceId);
      await db.prepare('UPDATE invoice_items SET invoice_id = ?, qty_confirmed = 0, qty_confirmed_at = NULL, qty_confirmed_by = NULL WHERE invoice_id = ?').run(targetId, sourceId);
      const files = [...new Set([target.file_name, source.file_name].flatMap(value => (value || '').split(',').map(v => v.trim()).filter(Boolean)))].join(',');
      const raw = [target.raw_text, source.raw_text].filter(Boolean).join('\n\n--- СТРАНИЦА ---\n\n');
      await db.prepare(`UPDATE invoices SET file_name = ?, raw_text = ?, total_sum = ?, pages_confirmed = 0,
        invoice_number = COALESCE(NULLIF(invoice_number, ''), ?), invoice_date = COALESCE(invoice_date, ?),
        supplier = COALESCE(NULLIF(supplier, ''), ?), supplier_inn = COALESCE(NULLIF(supplier_inn, ''), ?)
        WHERE id = ?`).run(files, raw || null, Math.max(Number(source.total_sum || 0), Number(target.total_sum || 0)),
          source.invoice_number, source.invoice_date, source.supplier, source.supplier_inn, targetId);
      await db.prepare('UPDATE invoice_merges SET target_id = ? WHERE target_id = ?').run(targetId, sourceId);
      await db.prepare('INSERT INTO invoice_merges (source_id, target_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE target_id = VALUES(target_id)').run(sourceId, targetId);
      await db.prepare('UPDATE recognition_jobs SET invoice_id = ? WHERE invoice_id = ?').run(targetId, sourceId);
      await db.prepare('DELETE FROM invoices WHERE id = ?').run(sourceId);
      await invoiceRepo.recalculateTotal(targetId, { forceDerive: true }, db);
      return { files, previousFiles: target.file_name };
    });
  } finally { release(); }
}
