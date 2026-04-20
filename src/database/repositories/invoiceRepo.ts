import { getDb } from '../db';
import {
  normalizeInvoiceNumber,
  extractDigitSequence,
  suppliersMatch,
} from '../../utils/invoiceNumber';

export interface Invoice {
  id: number;
  file_name: string;
  file_path: string;
  invoice_number: string | null;
  invoice_date: string | null;
  supplier: string | null;
  total_sum: number | null;
  invoice_type: string | null;
  supplier_inn: string | null;
  supplier_bik: string | null;
  supplier_account: string | null;
  supplier_corr_account: string | null;
  supplier_address: string | null;
  vat_sum: number | null;
  raw_text: string | null;
  status: string;
  ocr_engine: string | null;
  error_message: string | null;
  created_at: string;
  sent_at: string | null;
  approved_for_1c: number;
  approved_at: string | null;
  file_hash: string | null;
  items_total_mismatch: number;
}

export interface InvoiceItem {
  id: number;
  invoice_id: number;
  original_name: string;
  mapped_name: string | null;
  quantity: number | null;
  unit: string | null;
  price: number | null;
  total: number | null;
  vat_rate: number | null;
  mapping_confidence: number;
  onec_guid: string | null;
}

export interface CreateInvoiceData {
  file_name: string;
  file_path: string;
  invoice_number?: string;
  invoice_date?: string;
  supplier?: string;
  invoice_type?: string;
  supplier_inn?: string;
  supplier_bik?: string;
  supplier_account?: string;
  supplier_corr_account?: string;
  supplier_address?: string;
  total_sum?: number;
  vat_sum?: number;
  raw_text?: string;
  ocr_engine?: string;
  file_hash?: string | null;
}

// Thrown by invoiceRepo.create() when two uploads race on the same file content.
// Carries the existing invoice row so the caller can reuse it.
export class DuplicateFileHashError extends Error {
  constructor(public existing: Invoice) {
    super(`File hash already registered on invoice ${existing.id}`);
    this.name = 'DuplicateFileHashError';
  }
}

export interface CreateInvoiceItemData {
  invoice_id: number;
  original_name: string;
  mapped_name?: string;
  quantity?: number;
  unit?: string;
  price?: number;
  total?: number;
  vat_rate?: number;
  mapping_confidence?: number;
  onec_guid?: string | null;
}

export const invoiceRepo = {
  create(data: CreateInvoiceData): Invoice {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO invoices (file_name, file_path, invoice_number, invoice_date, supplier, invoice_type, supplier_inn, supplier_bik, supplier_account, supplier_corr_account, supplier_address, total_sum, vat_sum, raw_text, ocr_engine, file_hash)
      VALUES (@file_name, @file_path, @invoice_number, @invoice_date, @supplier, @invoice_type, @supplier_inn, @supplier_bik, @supplier_account, @supplier_corr_account, @supplier_address, @total_sum, @vat_sum, @raw_text, @ocr_engine, @file_hash)
    `);
    try {
      const result = stmt.run({
        file_name: data.file_name,
        file_path: data.file_path,
        invoice_number: data.invoice_number ?? null,
        invoice_date: data.invoice_date ?? null,
        supplier: data.supplier ?? null,
        invoice_type: data.invoice_type ?? null,
        supplier_inn: data.supplier_inn ?? null,
        supplier_bik: data.supplier_bik ?? null,
        supplier_account: data.supplier_account ?? null,
        supplier_corr_account: data.supplier_corr_account ?? null,
        supplier_address: data.supplier_address ?? null,
        total_sum: data.total_sum ?? null,
        vat_sum: data.vat_sum ?? null,
        raw_text: data.raw_text ?? null,
        ocr_engine: data.ocr_engine ?? null,
        file_hash: data.file_hash ?? null,
      });
      return this.getById(Number(result.lastInsertRowid))!;
    } catch (err) {
      const msg = (err as Error).message || '';
      // Partial unique index on file_hash — triggered when another concurrent
      // upload of the same content beat us to the INSERT. Surface the existing
      // invoice so the caller can reuse it instead of creating a duplicate.
      if (data.file_hash && msg.includes('UNIQUE') && msg.includes('file_hash')) {
        const existing = this.findByFileHash(data.file_hash);
        if (existing) throw new DuplicateFileHashError(existing);
      }
      throw err;
    }
  },

  getById(id: number): Invoice | undefined {
    const db = getDb();
    return db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as Invoice | undefined;
  },

  getAll(status?: string, limit: number = 100, offset: number = 0): Invoice[] {
    const db = getDb();
    if (status) {
      return db.prepare('SELECT * FROM invoices WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
        .all(status, limit, offset) as Invoice[];
    }
    return db.prepare('SELECT * FROM invoices ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as Invoice[];
  },

  /**
   * Накладные, которые пользователь явно отправил в 1С кнопкой "Отправить в 1С"
   * в дашборде. Возвращает только те что approved_for_1c=1 И в активных статусах
   * (не sent_to_1c ещё и не error).
   */
  getPending(): Invoice[] {
    const db = getDb();
    return db.prepare(
      `SELECT * FROM invoices
       WHERE approved_for_1c = 1
       AND status IN ('processed', 'parsing', 'ocr_processing')
       ORDER BY created_at DESC`
    ).all() as Invoice[];
  },

  /**
   * Fetch pending invoices + their items in 2 queries instead of N+1.
   * Used by GET /api/invoices/pending which is polled by the 1C side.
   */
  getPendingWithItems(
    opts: { limit?: number; offset?: number } = {}
  ): { rows: Array<Invoice & { items: InvoiceItem[] }>; total: number } {
    const db = getDb();
    const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
    const offset = Math.max(0, opts.offset ?? 0);

    const totalRow = db.prepare(
      `SELECT COUNT(*) as c FROM invoices
       WHERE approved_for_1c = 1
       AND status IN ('processed', 'parsing', 'ocr_processing')`
    ).get() as { c: number };

    const invoices = db.prepare(
      `SELECT * FROM invoices
       WHERE approved_for_1c = 1
       AND status IN ('processed', 'parsing', 'ocr_processing')
       ORDER BY created_at ASC
       LIMIT ? OFFSET ?`
    ).all(limit, offset) as Invoice[];

    if (invoices.length === 0) return { rows: [], total: totalRow.c };

    const ids = invoices.map(i => i.id);
    const placeholders = ids.map(() => '?').join(',');
    const items = db.prepare(
      `SELECT * FROM invoice_items WHERE invoice_id IN (${placeholders}) ORDER BY id`
    ).all(...ids) as InvoiceItem[];

    const itemsByInvoice = new Map<number, InvoiceItem[]>();
    for (const item of items) {
      if (!itemsByInvoice.has(item.invoice_id)) {
        itemsByInvoice.set(item.invoice_id, []);
      }
      itemsByInvoice.get(item.invoice_id)!.push(item);
    }

    return {
      rows: invoices.map(inv => ({ ...inv, items: itemsByInvoice.get(inv.id) ?? [] })),
      total: totalRow.c,
    };
  },

  /**
   * Пометить накладную как одобренную для 1С.
   * Не меняет status — он остаётся 'processed'.
   * 1C забирает накладную через /pending, создаёт документ, вызывает /confirm,
   * только после этого status становится 'sent_to_1c'.
   */
  approveForOneC(id: number): void {
    const db = getDb();
    db.prepare("UPDATE invoices SET approved_for_1c = 1, approved_at = datetime('now') WHERE id = ?").run(id);
  },

  /**
   * Отозвать одобрение (если передумали отправлять в 1С).
   */
  unapproveForOneC(id: number): void {
    const db = getDb();
    db.prepare('UPDATE invoices SET approved_for_1c = 0, approved_at = NULL WHERE id = ?').run(id);
  },

  updateStatus(id: number, status: string, errorMessage?: string): void {
    const db = getDb();
    if (errorMessage) {
      db.prepare('UPDATE invoices SET status = ?, error_message = ? WHERE id = ?').run(status, errorMessage, id);
    } else {
      db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run(status, id);
    }
  },

  updateInvoiceData(id: number, data: Partial<CreateInvoiceData>): void {
    const db = getDb();
    const fields: string[] = [];
    const values: Record<string, unknown> = { id };

    if (data.invoice_number !== undefined) { fields.push('invoice_number = @invoice_number'); values.invoice_number = data.invoice_number; }
    if (data.invoice_date !== undefined) { fields.push('invoice_date = @invoice_date'); values.invoice_date = data.invoice_date; }
    if (data.supplier !== undefined) { fields.push('supplier = @supplier'); values.supplier = data.supplier; }
    if (data.invoice_type !== undefined) { fields.push('invoice_type = @invoice_type'); values.invoice_type = data.invoice_type; }
    if (data.supplier_inn !== undefined) { fields.push('supplier_inn = @supplier_inn'); values.supplier_inn = data.supplier_inn; }
    if (data.supplier_bik !== undefined) { fields.push('supplier_bik = @supplier_bik'); values.supplier_bik = data.supplier_bik; }
    if (data.supplier_account !== undefined) { fields.push('supplier_account = @supplier_account'); values.supplier_account = data.supplier_account; }
    if (data.supplier_corr_account !== undefined) { fields.push('supplier_corr_account = @supplier_corr_account'); values.supplier_corr_account = data.supplier_corr_account; }
    if (data.supplier_address !== undefined) { fields.push('supplier_address = @supplier_address'); values.supplier_address = data.supplier_address; }
    if (data.total_sum !== undefined) { fields.push('total_sum = @total_sum'); values.total_sum = data.total_sum; }
    if (data.vat_sum !== undefined) { fields.push('vat_sum = @vat_sum'); values.vat_sum = data.vat_sum; }
    if (data.raw_text !== undefined) { fields.push('raw_text = @raw_text'); values.raw_text = data.raw_text; }
    if (data.ocr_engine !== undefined) { fields.push('ocr_engine = @ocr_engine'); values.ocr_engine = data.ocr_engine; }

    if (fields.length > 0) {
      db.prepare(`UPDATE invoices SET ${fields.join(', ')} WHERE id = @id`).run(values);
    }
  },

  markSent(id: number): void {
    const db = getDb();
    db.prepare("UPDATE invoices SET status = 'sent_to_1c', sent_at = datetime('now') WHERE id = ?").run(id);
  },

  addItem(data: CreateInvoiceItemData): InvoiceItem {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO invoice_items (invoice_id, original_name, mapped_name, quantity, unit, price, total, vat_rate, mapping_confidence, onec_guid)
      VALUES (@invoice_id, @original_name, @mapped_name, @quantity, @unit, @price, @total, @vat_rate, @mapping_confidence, @onec_guid)
    `);
    const result = stmt.run({
      invoice_id: data.invoice_id,
      original_name: data.original_name,
      mapped_name: data.mapped_name ?? null,
      quantity: data.quantity ?? null,
      unit: data.unit ?? null,
      price: data.price ?? null,
      total: data.total ?? null,
      vat_rate: data.vat_rate ?? null,
      mapping_confidence: data.mapping_confidence ?? 0,
      onec_guid: data.onec_guid ?? null,
    });
    return db.prepare('SELECT * FROM invoice_items WHERE id = ?').get(Number(result.lastInsertRowid)) as InvoiceItem;
  },

  getItems(invoiceId: number): InvoiceItem[] {
    const db = getDb();
    return db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id').all(invoiceId) as InvoiceItem[];
  },

  getItemById(id: number): InvoiceItem | undefined {
    const db = getDb();
    return db.prepare('SELECT * FROM invoice_items WHERE id = ?').get(id) as InvoiceItem | undefined;
  },

  /**
   * Set or clear the 1C GUID link for a single invoice line item. Also
   * updates the cached mapped_name for display. Caller is responsible for
   * updating nomenclature_mappings and mapping_supplier_usage.
   */
  mapItem(itemId: number, onecGuid: string | null, mappedName: string | null): InvoiceItem | undefined {
    const db = getDb();
    db.prepare(
      `UPDATE invoice_items SET onec_guid = ?, mapped_name = COALESCE(?, mapped_name) WHERE id = ?`
    ).run(onecGuid, mappedName, itemId);
    return db.prepare('SELECT * FROM invoice_items WHERE id = ?').get(itemId) as InvoiceItem | undefined;
  },

  /**
   * Update quantity / unit / price on an invoice item. Used by the pack
   * transform path in the item-map endpoint: when user confirms "1 мешок =
   * 50 кг", we rewrite the saved line so it shows the converted values
   * immediately on the detail page (and forwards them to 1С unchanged).
   * Total is preserved upstream — the caller already recomputed price from
   * the original total.
   */
  updateItemQuantity(
    itemId: number,
    quantity: number | null,
    unit: string | null,
    price: number | null,
  ): void {
    const db = getDb();
    db.prepare(
      `UPDATE invoice_items SET quantity = ?, unit = ?, price = ? WHERE id = ?`
    ).run(quantity, unit, price, itemId);
  },

  /**
   * Update mapping + confidence on an invoice item. Used by /remap endpoint
   * so that the UI "точность" column reflects the new fuzzy score.
   */
  updateItemMapping(itemId: number, onecGuid: string, mappedName: string, confidence: number): void {
    const db = getDb();
    db.prepare(
      `UPDATE invoice_items SET onec_guid = ?, mapped_name = ?, mapping_confidence = ? WHERE id = ?`
    ).run(onecGuid, mappedName, confidence, itemId);
  },

  getWithItems(id: number): (Invoice & { items: InvoiceItem[] }) | undefined {
    const invoice = this.getById(id);
    if (!invoice) return undefined;
    const items = this.getItems(id);
    return { ...invoice, items };
  },

  /**
   * Найти недавнюю накладную с таким же именем файла (защита от дублей).
   */
  findRecentByFileName(fileName: string, withinMinutes: number = 5): Invoice | undefined {
    const db = getDb();
    return db.prepare(
      `SELECT * FROM invoices
       WHERE (file_name = ? OR file_name LIKE ?)
       AND status != 'error'
       AND created_at > datetime('now', '-${withinMinutes} minutes')
       ORDER BY created_at DESC LIMIT 1`
    ).get(fileName, `%${fileName}%`) as Invoice | undefined;
  },

  /**
   * Найти накладную по SHA-256 хешу содержимого файла.
   * Используется для защиты от дублирующих загрузок одного и того же фото
   * (даже если оно переименовано).
   */
  findByFileHash(fileHash: string): Invoice | undefined {
    const db = getDb();
    return db.prepare(
      `SELECT * FROM invoices
       WHERE file_hash = ?
       AND status != 'error'
       ORDER BY created_at DESC
       LIMIT 1`
    ).get(fileHash) as Invoice | undefined;
  },

  /**
   * Сохранить SHA-256 хеш файла в накладную.
   */
  setFileHash(id: number, fileHash: string): void {
    const db = getDb();
    db.prepare('UPDATE invoices SET file_hash = ? WHERE id = ?').run(fileHash, id);
  },

  /**
   * Найти недавнюю накладную по паттерну имени файла (LIKE).
   * Используется для multi-page: photo_1_timestamp и photo_2_timestamp.
   */
  findRecentByFileNamePattern(pattern: string, excludeId: number, withinMinutes: number = 10): Invoice | undefined {
    const db = getDb();
    return db.prepare(
      `SELECT * FROM invoices
       WHERE file_name LIKE ?
       AND id != ?
       AND status != 'error'
       AND created_at > datetime('now', '-${withinMinutes} minutes')
       ORDER BY created_at DESC LIMIT 1`
    ).get(pattern, excludeId) as Invoice | undefined;
  },

  /**
   * Найти недавнюю накладную с таким же номером (и, опционально, поставщиком).
   * Используется для объединения многостраничных накладных.
   *
   * Две стратегии матчинга:
   *
   *   1. **Exact normalized match** — сравнение по нормализованному номеру:
   *      учитывает кириллические/латинские омоглифы (В↔B, М↔M, ...), регистр,
   *      пробелы, разделители, ведущие № / #.
   *
   *   2. **Digit-sequence fallback** (если exact провалился) — сравнение по
   *      последовательности цифр + fuzzy-match поставщика. Это нужно когда OCR
   *      читает на одной странице префикс буквами, а на другой — только цифры
   *      (напр. "МСМС-40626" на стр.1 и "40626" на стр.2). Требует:
   *        - одинаковая цифровая последовательность (минимум 3 цифры)
   *        - fuzzy-match поставщика (см. suppliersMatch)
   *
   *   Передаваемый supplier, если есть, участвует в обеих стратегиях (exact
   *   идёт через SQL = в 1-й стратегии, fallback — через fuzzy в JS).
   *
   * @param invoiceNumber - номер накладной (в любой форме)
   * @param supplier - поставщик (опционально, для fuzzy fallback в пункте 2)
   * @param withinMinutes - искать за последние N минут (по умолчанию 10)
   */
  findRecentByNumber(invoiceNumber: string, supplier?: string, withinMinutes: number = 10): Invoice | undefined {
    const targetNormalized = normalizeInvoiceNumber(invoiceNumber);
    if (!targetNormalized) return undefined;

    const targetDigits = extractDigitSequence(invoiceNumber);

    const db = getDb();

    // Загружаем ВСЕХ кандидатов в окне времени (не фильтруем по supplier в SQL,
    // чтобы fallback мог использовать fuzzy-match), затем сравниваем в JS.
    const candidates = db.prepare(
      `SELECT * FROM invoices
       WHERE invoice_number IS NOT NULL AND invoice_number != ''
       AND created_at > datetime('now', '-${withinMinutes} minutes')
       AND status IN ('processed', 'parsing', 'ocr_processing')
       ORDER BY created_at DESC`
    ).all() as Invoice[];

    // Pass 1: exact normalized match (with optional strict supplier filter)
    for (const candidate of candidates) {
      if (normalizeInvoiceNumber(candidate.invoice_number) === targetNormalized) {
        if (!supplier || candidate.supplier === supplier) {
          return candidate;
        }
      }
    }

    // Pass 2: digit-sequence fallback. Requires 3+ digits to avoid matching
    // common short sequences like "1" or "17".
    if (targetDigits.length >= 3) {
      for (const candidate of candidates) {
        const candDigits = extractDigitSequence(candidate.invoice_number);
        if (candDigits !== targetDigits) continue;

        // Both sides must have a supplier, and they must fuzzy-match.
        // This is the safety net — same digits alone is not enough.
        if (supplier && candidate.supplier && suppliersMatch(supplier, candidate.supplier)) {
          return candidate;
        }
      }
    }

    return undefined;
  },

  /**
   * Найти недавнюю накладную с таким же поставщиком (для объединения страниц при быстрой съёмке).
   */
  /**
   * Last-resort merge strategy: return the single most recently processed
   * invoice within `withinMinutes` minutes, excluding the given id. Used when
   * a scanned page has no invoice_number AND no supplier extracted (common
   * for page 2+ of a multi-page УПД/ТОРГ-12 — the top half with all the
   * header metadata is on page 1, and page 2 is just the bottom of the table
   * plus signatures). Without this fallback such pages become orphans.
   *
   * Intentionally does NOT look at 'parsing' rows — only 'processed' — so
   * that concurrent uploads of two different invoices can't accidentally
   * merge with each other mid-processing.
   */
  findMostRecentProcessedForContinuation(excludeId: number, withinMinutes: number = 2): Invoice | undefined {
    const db = getDb();
    return db.prepare(
      `SELECT * FROM invoices
       WHERE id != ?
       AND status = 'processed'
       AND created_at > datetime('now', '-${withinMinutes} minutes')
       ORDER BY created_at DESC
       LIMIT 1`
    ).get(excludeId) as Invoice | undefined;
  },

  /**
   * Cleanup: mark rows stuck in 'parsing' or 'ocr_processing' for longer
   * than `staleMinutes` as 'error'. Called on startup to recover from
   * crashes / deploys that interrupted in-flight processing and left rows
   * stranded. Without this the dashboard fills up with ghost rows that
   * can't be deleted through normal merge flow.
   */
  markStaleAsFailed(staleMinutes: number = 5): number {
    const db = getDb();
    // Any non-terminal status older than N minutes is a leftover from a crash.
    // Terminal statuses that must NEVER be swept: processed, sent_to_1c, error.
    const result = db.prepare(
      `UPDATE invoices
       SET status = 'error',
           error_message = COALESCE(error_message, 'Processing interrupted (stuck in non-terminal status)')
       WHERE status NOT IN ('processed', 'sent_to_1c', 'error')
       AND created_at < datetime('now', '-${staleMinutes} minutes')`
    ).run();
    return result.changes;
  },

  findRecentBySupplier(supplier: string, excludeId: number, withinMinutes: number = 2): Invoice | undefined {
    const db = getDb();
    const candidates = db.prepare(
      `SELECT * FROM invoices
       WHERE supplier IS NOT NULL AND supplier != ''
       AND id != ?
       AND created_at > datetime('now', '-${withinMinutes} minutes')
       AND status IN ('processed', 'parsing', 'ocr_processing')
       ORDER BY created_at DESC`
    ).all(excludeId) as Invoice[];

    for (const candidate of candidates) {
      if (candidate.supplier && suppliersMatch(supplier, candidate.supplier)) {
        return candidate;
      }
    }
    return undefined;
  },

  /**
   * Добавить дополнительный файл к существующей накладной.
   * Используется для многостраничных накладных.
   */
  appendFileName(id: number, newFileName: string): void {
    const db = getDb();
    const invoice = this.getById(id);
    if (invoice) {
      const updatedName = invoice.file_name.includes(newFileName)
        ? invoice.file_name
        : `${invoice.file_name}, ${newFileName}`;
      db.prepare('UPDATE invoices SET file_name = ? WHERE id = ?').run(updatedName, id);
    }
  },

  /**
   * Добавить сырой текст OCR к существующей накладной (для многостраничных).
   */
  appendRawText(id: number, additionalText: string): void {
    const db = getDb();
    const invoice = this.getById(id);
    if (invoice && invoice.raw_text) {
      const separator = '\n\n--- СТРАНИЦА ---\n\n';
      const updatedText = invoice.raw_text + separator + additionalText;
      db.prepare('UPDATE invoices SET raw_text = ? WHERE id = ?').run(updatedText, id);
    }
  },

  /**
   * Пересчёт итоговой суммы + проверка расхождения с суммой позиций.
   *
   * Historically this method overwrote total_sum with sum(items.total). That
   * discards information — when Claude extracts a total from the document,
   * it's often more trustworthy than the line-by-line OCR (НДС rounding,
   * dropped pennies, etc.). So: we preserve a document-level total if it's
   * already set and "close enough" to the items sum; otherwise we overwrite.
   *
   * Mismatch rule: >1% relative difference OR >1 ruble absolute difference,
   * whichever is larger — avoids nuisance flags on tiny totals.
   *
   * items_total_mismatch is set so the UI can flag the invoice for human review.
   */
  recalculateTotal(id: number): void {
    const db = getDb();
    const { total: itemsTotal } = db.prepare(
      'SELECT COALESCE(SUM(total), 0) as total FROM invoice_items WHERE invoice_id = ?'
    ).get(id) as { total: number };
    const invoice = db.prepare('SELECT total_sum FROM invoices WHERE id = ?').get(id) as { total_sum: number | null } | undefined;
    const documentTotal = invoice?.total_sum ?? null;

    let mismatch = 0;
    let nextTotal: number = itemsTotal;

    if (documentTotal != null && documentTotal > 0 && itemsTotal > 0) {
      const diff = Math.abs(documentTotal - itemsTotal);
      const relative = diff / Math.max(documentTotal, itemsTotal);
      mismatch = (diff > 1 && relative > 0.01) ? 1 : 0;
      // Trust the document total when consistent with items — it usually
      // includes rounding the line-by-line sum can't replicate.
      nextTotal = mismatch ? itemsTotal : documentTotal;
    }

    db.prepare(
      'UPDATE invoices SET total_sum = ?, items_total_mismatch = ? WHERE id = ?'
    ).run(nextTotal, mismatch, id);
  },

  /**
   * Удалить все товары накладной (для пересоздания при multi-page merge).
   */
  deleteItems(invoiceId: number): void {
    const db = getDb();
    db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(invoiceId);
  },

  /**
   * Удалить накладную и все её товары.
   */
  delete(id: number): { file_name: string | null } {
    const db = getDb();
    const invoice = this.getById(id);
    const fileName = invoice?.file_name ?? null;
    db.transaction(() => {
      db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(id);
      db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
    })();
    return { file_name: fileName };
  },

  /**
   * Получить статистику по статусам (для дашборда).
   */
  getStats(): { byStatus: { status: string; count: number }[]; total: number } {
    const db = getDb();
    const byStatus = db.prepare(
      'SELECT status, COUNT(*) as count FROM invoices GROUP BY status'
    ).all() as { status: string; count: number }[];
    const total = db.prepare('SELECT COUNT(*) as count FROM invoices').get() as { count: number };
    return { byStatus, total: total.count };
  },

  getAnalyzerConfig(): { mode: string; anthropic_api_key: string | null; claude_model: string } {
    const db = getDb();
    const row = db.prepare('SELECT mode, anthropic_api_key, claude_model FROM analyzer_config WHERE id = 1').get() as
      { mode: string; anthropic_api_key: string | null; claude_model: string | null } | undefined;
    return {
      mode: row?.mode ?? 'hybrid',
      anthropic_api_key: row?.anthropic_api_key ?? null,
      claude_model: row?.claude_model ?? 'claude-sonnet-4-6',
    };
  },

  updateAnalyzerConfig(mode: string, anthropicApiKey?: string | null, claudeModel?: string | null): void {
    const db = getDb();
    if (claudeModel) {
      db.prepare('UPDATE analyzer_config SET mode = ?, anthropic_api_key = ?, claude_model = ? WHERE id = 1')
        .run(mode, anthropicApiKey ?? null, claudeModel);
    } else {
      db.prepare('UPDATE analyzer_config SET mode = ?, anthropic_api_key = ? WHERE id = 1')
        .run(mode, anthropicApiKey ?? null);
    }
  },
};
