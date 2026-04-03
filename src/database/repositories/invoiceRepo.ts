import { getDb } from '../db';

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
}

export const invoiceRepo = {
  create(data: CreateInvoiceData): Invoice {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO invoices (file_name, file_path, invoice_number, invoice_date, supplier, invoice_type, supplier_inn, supplier_bik, supplier_account, supplier_corr_account, supplier_address, total_sum, vat_sum, raw_text, ocr_engine)
      VALUES (@file_name, @file_path, @invoice_number, @invoice_date, @supplier, @invoice_type, @supplier_inn, @supplier_bik, @supplier_account, @supplier_corr_account, @supplier_address, @total_sum, @vat_sum, @raw_text, @ocr_engine)
    `);
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
    });
    return this.getById(Number(result.lastInsertRowid))!;
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

  getPending(): Invoice[] {
    return this.getAll('processed');
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
      INSERT INTO invoice_items (invoice_id, original_name, mapped_name, quantity, unit, price, total, vat_rate, mapping_confidence)
      VALUES (@invoice_id, @original_name, @mapped_name, @quantity, @unit, @price, @total, @vat_rate, @mapping_confidence)
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
    });
    return db.prepare('SELECT * FROM invoice_items WHERE id = ?').get(Number(result.lastInsertRowid)) as InvoiceItem;
  },

  getItems(invoiceId: number): InvoiceItem[] {
    const db = getDb();
    return db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id').all(invoiceId) as InvoiceItem[];
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
   * Найти недавнюю накладную с таким же номером и поставщиком.
   * Используется для объединения многостраничных накладных.
   *
   * @param invoiceNumber - номер накладной
   * @param supplier - поставщик (опционально)
   * @param withinMinutes - искать за последние N минут (по умолчанию 10)
   */
  findRecentByNumber(invoiceNumber: string, supplier?: string, withinMinutes: number = 10): Invoice | undefined {
    const db = getDb();

    // Ищем накладную с таким же номером, созданную недавно
    const query = supplier
      ? `SELECT * FROM invoices
         WHERE invoice_number = ? AND supplier = ?
         AND created_at > datetime('now', '-${withinMinutes} minutes')
         AND status IN ('processed', 'parsing', 'ocr_processing')
         ORDER BY created_at DESC LIMIT 1`
      : `SELECT * FROM invoices
         WHERE invoice_number = ?
         AND created_at > datetime('now', '-${withinMinutes} minutes')
         AND status IN ('processed', 'parsing', 'ocr_processing')
         ORDER BY created_at DESC LIMIT 1`;

    return supplier
      ? db.prepare(query).get(invoiceNumber, supplier) as Invoice | undefined
      : db.prepare(query).get(invoiceNumber) as Invoice | undefined;
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
   * Обновить итоговую сумму накладной (пересчитать из товаров).
   */
  recalculateTotal(id: number): void {
    const db = getDb();
    const result = db.prepare(
      'SELECT COALESCE(SUM(total), 0) as total FROM invoice_items WHERE invoice_id = ?'
    ).get(id) as { total: number };
    db.prepare('UPDATE invoices SET total_sum = ? WHERE id = ?').run(result.total, id);
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
  delete(id: number): void {
    const db = getDb();
    db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(id);
    db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
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

  getAnalyzerConfig(): { mode: string; anthropic_api_key: string | null } {
    const db = getDb();
    const row = db.prepare('SELECT mode, anthropic_api_key FROM analyzer_config WHERE id = 1').get() as
      { mode: string; anthropic_api_key: string | null } | undefined;
    return row ?? { mode: 'hybrid', anthropic_api_key: null };
  },

  updateAnalyzerConfig(mode: string, anthropicApiKey?: string | null): void {
    const db = getDb();
    db.prepare('UPDATE analyzer_config SET mode = ?, anthropic_api_key = ? WHERE id = 1')
      .run(mode, anthropicApiKey ?? null);
  },
};
