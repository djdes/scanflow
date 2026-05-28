import { getDb } from '../db';
import {
  normalizeInvoiceNumber,
  extractDigitSequence,
  suppliersMatch,
} from '../../utils/invoiceNumber';
import { recomputeMedianForGuids } from '../../pricing/priceStats';

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
  supplier_kpp: string | null;
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
  telegram_message_id: number | null;
  duplicate_of: number | null;
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
  supplier_kpp?: string;
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

/**
 * Fire-and-forget recompute of median price stats for the given GUIDs.
 * Errors are logged but never re-thrown — the parent invoice write has
 * already committed by the time we get here, and a failed stats refresh
 * must not surface as a user-visible failure.
 */
function triggerStatsRecompute(guids: Array<string | null | undefined>): void {
  void recomputeMedianForGuids(guids).catch(() => { /* logged inside */ });
}

export const invoiceRepo = {
  async create(data: CreateInvoiceData): Promise<Invoice> {
    const db = getDb();
    try {
      const result = await db.prepare(`
        INSERT INTO invoices (file_name, file_path, invoice_number, invoice_date, supplier, invoice_type, supplier_inn, supplier_kpp, supplier_bik, supplier_account, supplier_corr_account, supplier_address, total_sum, vat_sum, raw_text, ocr_engine, file_hash)
        VALUES (:file_name, :file_path, :invoice_number, :invoice_date, :supplier, :invoice_type, :supplier_inn, :supplier_kpp, :supplier_bik, :supplier_account, :supplier_corr_account, :supplier_address, :total_sum, :vat_sum, :raw_text, :ocr_engine, :file_hash)
      `).run({
        file_name: data.file_name,
        file_path: data.file_path,
        invoice_number: data.invoice_number ?? null,
        invoice_date: data.invoice_date ?? null,
        supplier: data.supplier ?? null,
        invoice_type: data.invoice_type ?? null,
        supplier_inn: data.supplier_inn ?? null,
        supplier_kpp: data.supplier_kpp ?? null,
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
      return (await this.getById(Number(result.lastInsertRowid)))!;
    } catch (err) {
      // Unique constraint on file_hash — triggered when another concurrent
      // upload of the same content beat us to the INSERT. Surface the existing
      // invoice so the caller can reuse it instead of creating a duplicate.
      const e = err as { code?: string; errno?: number; message?: string };
      const isDup =
        e?.code === 'ER_DUP_ENTRY' || e?.errno === 1062 ||
        (e?.message ?? '').includes('Duplicate entry');
      if (data.file_hash && isDup && (e?.message ?? '').toLowerCase().includes('file_hash')) {
        const existing = await this.findByFileHash(data.file_hash);
        if (existing) throw new DuplicateFileHashError(existing);
      }
      throw err;
    }
  },

  async getById(id: number): Promise<Invoice | undefined> {
    return getDb().prepare('SELECT * FROM invoices WHERE id = ?').get<Invoice>(id);
  },

  async getAll(status?: string, limit: number = 100, offset: number = 0): Promise<Invoice[]> {
    // mysql2's named-placeholder mode (our pool default) can't bind LIMIT/OFFSET
    // as params — server rejects with "Incorrect arguments to mysqld_stmt_execute".
    // Inline the integers after a safe Math.floor/clamp so it's not a literal injection.
    const lim = Math.max(1, Math.min(500, Math.floor(limit)));
    const off = Math.max(0, Math.floor(offset));
    if (status) {
      return getDb()
        .prepare(`SELECT * FROM invoices WHERE status = ? ORDER BY created_at DESC LIMIT ${lim} OFFSET ${off}`)
        .all<Invoice>(status);
    }
    return getDb()
      .prepare(`SELECT * FROM invoices ORDER BY created_at DESC LIMIT ${lim} OFFSET ${off}`)
      .all<Invoice>();
  },

  async getPending(): Promise<Invoice[]> {
    return getDb().prepare(
      `SELECT * FROM invoices
       WHERE approved_for_1c = 1
       AND status IN ('processed', 'parsing', 'ocr_processing')
       ORDER BY created_at DESC`
    ).all<Invoice>();
  },

  async getPendingWithItems(
    opts: { limit?: number; offset?: number } = {}
  ): Promise<{ rows: Array<Invoice & { items: InvoiceItem[] }>; total: number }> {
    const db = getDb();
    const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
    const offset = Math.max(0, opts.offset ?? 0);

    const totalRow = await db.prepare(
      `SELECT COUNT(*) as c FROM invoices
       WHERE approved_for_1c = 1
       AND status IN ('processed', 'parsing', 'ocr_processing')`
    ).get<{ c: number }>();
    const total = totalRow?.c ?? 0;

    const invoices = await db.prepare(
      `SELECT * FROM invoices
       WHERE approved_for_1c = 1
       AND status IN ('processed', 'parsing', 'ocr_processing')
       ORDER BY created_at ASC
       LIMIT ? OFFSET ?`
    ).all<Invoice>(limit, offset);

    if (invoices.length === 0) return { rows: [], total };

    const ids = invoices.map(i => i.id);
    const placeholders = ids.map(() => '?').join(',');
    const items = await db.prepare(
      `SELECT * FROM invoice_items WHERE invoice_id IN (${placeholders}) ORDER BY id`
    ).all<InvoiceItem>(...ids);

    const itemsByInvoice = new Map<number, InvoiceItem[]>();
    for (const item of items) {
      if (!itemsByInvoice.has(item.invoice_id)) itemsByInvoice.set(item.invoice_id, []);
      itemsByInvoice.get(item.invoice_id)!.push(item);
    }

    return {
      rows: invoices.map(inv => ({ ...inv, items: itemsByInvoice.get(inv.id) ?? [] })),
      total,
    };
  },

  async approveForOneC(id: number): Promise<void> {
    await getDb()
      .prepare("UPDATE invoices SET approved_for_1c = 1, approved_at = NOW() WHERE id = ?")
      .run(id);
  },

  async unapproveForOneC(id: number): Promise<void> {
    await getDb()
      .prepare('UPDATE invoices SET approved_for_1c = 0, approved_at = NULL WHERE id = ?')
      .run(id);
  },

  async updateFilePath(id: number, filePath: string): Promise<void> {
    await getDb().prepare('UPDATE invoices SET file_path = ? WHERE id = ?').run(filePath, id);
  },

  async updateStatus(id: number, status: string, errorMessage?: string): Promise<void> {
    const db = getDb();
    if (errorMessage) {
      await db.prepare('UPDATE invoices SET status = ?, error_message = ? WHERE id = ?').run(status, errorMessage, id);
    } else {
      await db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run(status, id);
    }
  },

  async updateInvoiceData(id: number, data: Partial<CreateInvoiceData>): Promise<void> {
    const fields: string[] = [];
    const values: Record<string, unknown> = { id };

    if (data.invoice_number !== undefined) { fields.push('invoice_number = :invoice_number'); values.invoice_number = data.invoice_number; }
    if (data.invoice_date !== undefined) { fields.push('invoice_date = :invoice_date'); values.invoice_date = data.invoice_date; }
    if (data.supplier !== undefined) { fields.push('supplier = :supplier'); values.supplier = data.supplier; }
    if (data.invoice_type !== undefined) { fields.push('invoice_type = :invoice_type'); values.invoice_type = data.invoice_type; }
    if (data.supplier_inn !== undefined) { fields.push('supplier_inn = :supplier_inn'); values.supplier_inn = data.supplier_inn; }
    if (data.supplier_kpp !== undefined) { fields.push('supplier_kpp = :supplier_kpp'); values.supplier_kpp = data.supplier_kpp; }
    if (data.supplier_bik !== undefined) { fields.push('supplier_bik = :supplier_bik'); values.supplier_bik = data.supplier_bik; }
    if (data.supplier_account !== undefined) { fields.push('supplier_account = :supplier_account'); values.supplier_account = data.supplier_account; }
    if (data.supplier_corr_account !== undefined) { fields.push('supplier_corr_account = :supplier_corr_account'); values.supplier_corr_account = data.supplier_corr_account; }
    if (data.supplier_address !== undefined) { fields.push('supplier_address = :supplier_address'); values.supplier_address = data.supplier_address; }
    if (data.total_sum !== undefined) { fields.push('total_sum = :total_sum'); values.total_sum = data.total_sum; }
    if (data.vat_sum !== undefined) { fields.push('vat_sum = :vat_sum'); values.vat_sum = data.vat_sum; }
    if (data.raw_text !== undefined) { fields.push('raw_text = :raw_text'); values.raw_text = data.raw_text; }
    if (data.ocr_engine !== undefined) { fields.push('ocr_engine = :ocr_engine'); values.ocr_engine = data.ocr_engine; }

    if (fields.length > 0) {
      await getDb()
        .prepare(`UPDATE invoices SET ${fields.join(', ')} WHERE id = :id`)
        .run(values);
    }
  },

  async markSent(id: number): Promise<void> {
    await getDb()
      .prepare("UPDATE invoices SET status = 'sent_to_1c', sent_at = NOW() WHERE id = ?")
      .run(id);
  },

  async addItem(data: CreateInvoiceItemData): Promise<InvoiceItem> {
    const db = getDb();
    const result = await db.prepare(`
      INSERT INTO invoice_items (invoice_id, original_name, mapped_name, quantity, unit, price, total, vat_rate, mapping_confidence, onec_guid)
      VALUES (:invoice_id, :original_name, :mapped_name, :quantity, :unit, :price, :total, :vat_rate, :mapping_confidence, :onec_guid)
    `).run({
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
    const created = (await db
      .prepare('SELECT * FROM invoice_items WHERE id = ?')
      .get<InvoiceItem>(Number(result.lastInsertRowid)))!;
    triggerStatsRecompute([created.onec_guid]);
    return created;
  },

  async getItems(invoiceId: number): Promise<InvoiceItem[]> {
    return getDb()
      .prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id')
      .all<InvoiceItem>(invoiceId);
  },

  async getItemById(id: number): Promise<InvoiceItem | undefined> {
    return getDb()
      .prepare('SELECT * FROM invoice_items WHERE id = ?')
      .get<InvoiceItem>(id);
  },

  async mapItem(itemId: number, onecGuid: string | null, mappedName: string | null): Promise<InvoiceItem | undefined> {
    const db = getDb();
    const prev = await db.prepare('SELECT onec_guid FROM invoice_items WHERE id = ?')
      .get<{ onec_guid: string | null }>(itemId);
    await db.prepare(
      `UPDATE invoice_items SET onec_guid = ?, mapped_name = COALESCE(?, mapped_name) WHERE id = ?`
    ).run(onecGuid, mappedName, itemId);
    triggerStatsRecompute([prev?.onec_guid, onecGuid]);
    return db.prepare('SELECT * FROM invoice_items WHERE id = ?').get<InvoiceItem>(itemId);
  },

  async updateItemQuantity(
    itemId: number,
    quantity: number | null,
    unit: string | null,
    price: number | null,
  ): Promise<void> {
    const db = getDb();
    await db.prepare(
      `UPDATE invoice_items SET quantity = ?, unit = ?, price = ? WHERE id = ?`
    ).run(quantity, unit, price, itemId);
    const after = await db.prepare('SELECT onec_guid FROM invoice_items WHERE id = ?')
      .get<{ onec_guid: string | null }>(itemId);
    triggerStatsRecompute([after?.onec_guid]);
  },

  async updateItemFields(
    itemId: number,
    fields: { quantity?: number | null; unit?: string | null; price?: number | null; total?: number | null },
  ): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if ('quantity' in fields) { sets.push('quantity = ?'); vals.push(fields.quantity); }
    if ('unit' in fields) { sets.push('unit = ?'); vals.push(fields.unit); }
    if ('price' in fields) { sets.push('price = ?'); vals.push(fields.price); }
    if ('total' in fields) { sets.push('total = ?'); vals.push(fields.total); }
    if (sets.length === 0) return;
    vals.push(itemId);
    const db = getDb();
    await db.prepare(`UPDATE invoice_items SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    if ('price' in fields || 'unit' in fields) {
      const after = await db.prepare('SELECT onec_guid FROM invoice_items WHERE id = ?')
        .get<{ onec_guid: string | null }>(itemId);
      triggerStatsRecompute([after?.onec_guid]);
    }
  },

  async updateItemMapping(itemId: number, onecGuid: string, mappedName: string, confidence: number): Promise<void> {
    const db = getDb();
    const prev = await db.prepare('SELECT onec_guid FROM invoice_items WHERE id = ?')
      .get<{ onec_guid: string | null }>(itemId);
    await db.prepare(
      `UPDATE invoice_items SET onec_guid = ?, mapped_name = ?, mapping_confidence = ? WHERE id = ?`
    ).run(onecGuid, mappedName, confidence, itemId);
    triggerStatsRecompute([prev?.onec_guid, onecGuid]);
  },

  async updateItemMappingName(itemId: number, mappedName: string, confidence: number): Promise<void> {
    await getDb().prepare(
      `UPDATE invoice_items SET mapped_name = ?, mapping_confidence = ? WHERE id = ?`
    ).run(mappedName, confidence, itemId);
  },

  async getWithItems(id: number): Promise<(Invoice & { items: Array<InvoiceItem & { median_price: number | null; median_price_unit: string | null; median_samples: number | null }> }) | undefined> {
    const invoice = await this.getById(id);
    if (!invoice) return undefined;
    const items = await getDb().prepare(
      `SELECT ii.*,
              ps.median_price       AS median_price,
              ps.price_unit         AS median_price_unit,
              ps.samples            AS median_samples
       FROM invoice_items ii
       LEFT JOIN nomenclature_price_stats ps ON ps.onec_guid = ii.onec_guid
       WHERE ii.invoice_id = ?
       ORDER BY ii.id`
    ).all<InvoiceItem & { median_price: number | null; median_price_unit: string | null; median_samples: number | null }>(id);
    return { ...invoice, items };
  },

  async findRecentByFileName(fileName: string, withinMinutes: number = 5): Promise<Invoice | undefined> {
    // Dedup ловит ТОЛЬКО реально завершённые накладные.
    return getDb().prepare(
      `SELECT * FROM invoices
       WHERE (file_name = ? OR file_name LIKE ?)
       AND status IN ('processed', 'sent_to_1c', 'duplicate')
       AND created_at > (NOW() - INTERVAL ${withinMinutes} MINUTE)
       ORDER BY created_at DESC LIMIT 1`
    ).get<Invoice>(fileName, `%${fileName}%`);
  },

  async findByFileName(fileName: string): Promise<Invoice | undefined> {
    return getDb().prepare(
      `SELECT * FROM invoices
       WHERE file_name = ? OR file_name LIKE ? OR file_name LIKE ? OR file_name LIKE ?
       ORDER BY created_at DESC
       LIMIT 1`
    ).get<Invoice>(
      fileName,
      `${fileName},%`,
      `%, ${fileName}`,
      `%, ${fileName},%`,
    );
  },

  async findByFileHash(fileHash: string): Promise<Invoice | undefined> {
    return getDb().prepare(
      `SELECT * FROM invoices
       WHERE file_hash = ?
       AND status != 'error'
       ORDER BY created_at DESC
       LIMIT 1`
    ).get<Invoice>(fileHash);
  },

  async setFileHash(id: number, fileHash: string): Promise<void> {
    await getDb().prepare('UPDATE invoices SET file_hash = ? WHERE id = ?').run(fileHash, id);
  },

  async findRecentByFileNamePattern(pattern: string, excludeId: number, withinMinutes: number = 10): Promise<Invoice | undefined> {
    return getDb().prepare(
      `SELECT * FROM invoices
       WHERE file_name LIKE ?
       AND id != ?
       AND status != 'error'
       AND created_at > (NOW() - INTERVAL ${withinMinutes} MINUTE)
       ORDER BY created_at DESC LIMIT 1`
    ).get<Invoice>(pattern, excludeId);
  },

  async findRecentByNumber(invoiceNumber: string, supplier?: string, withinMinutes: number = 10): Promise<Invoice | undefined> {
    const targetNormalized = normalizeInvoiceNumber(invoiceNumber);
    if (!targetNormalized) return undefined;

    const targetDigits = extractDigitSequence(invoiceNumber);

    const candidates = await getDb().prepare(
      `SELECT * FROM invoices
       WHERE invoice_number IS NOT NULL AND invoice_number != ''
       AND created_at > (NOW() - INTERVAL ${withinMinutes} MINUTE)
       AND status IN ('processed', 'parsing', 'ocr_processing')
       ORDER BY created_at DESC`
    ).all<Invoice>();

    for (const candidate of candidates) {
      if (normalizeInvoiceNumber(candidate.invoice_number) === targetNormalized) {
        if (!supplier || candidate.supplier === supplier) return candidate;
      }
    }

    if (targetDigits.length >= 3) {
      for (const candidate of candidates) {
        const candDigits = extractDigitSequence(candidate.invoice_number);
        if (candDigits !== targetDigits) continue;
        if (supplier && candidate.supplier && suppliersMatch(supplier, candidate.supplier)) {
          return candidate;
        }
      }
    }

    return undefined;
  },

  async findDuplicateOriginal(
    excludeId: number,
    invoiceNumber: string | null,
    supplierInn: string | null,
    supplierName: string | null,
    invoiceDate: string | null,
    totalSum: number | null,
    days: number = 30,
  ): Promise<Invoice | undefined> {
    if (!invoiceNumber || !invoiceDate || totalSum == null) return undefined;
    if (!supplierInn && !supplierName) return undefined;

    const targetNormalized = normalizeInvoiceNumber(invoiceNumber);
    if (!targetNormalized) return undefined;

    const candidates = await getDb().prepare(
      `SELECT * FROM invoices
       WHERE id != ?
         AND duplicate_of IS NULL
         AND status NOT IN ('duplicate', 'failed')
         AND invoice_number IS NOT NULL
         AND invoice_date = ?
         AND total_sum IS NOT NULL
         AND created_at > (NOW() - INTERVAL ${days} DAY)
       ORDER BY created_at DESC`
    ).all<Invoice>(excludeId, invoiceDate);

    for (const candidate of candidates) {
      if (normalizeInvoiceNumber(candidate.invoice_number) !== targetNormalized) continue;
      if (candidate.total_sum == null) continue;
      if (Math.abs(candidate.total_sum - totalSum) > 1.0) continue;

      if (supplierInn && candidate.supplier_inn) {
        if (supplierInn === candidate.supplier_inn) return candidate;
        continue;
      }
      if (supplierName && candidate.supplier && suppliersMatch(supplierName, candidate.supplier)) {
        return candidate;
      }
    }

    return undefined;
  },

  async markAsDuplicate(id: number, originalId: number): Promise<void> {
    await getDb().prepare(
      `UPDATE invoices SET duplicate_of = ?, status = 'duplicate' WHERE id = ?`
    ).run(originalId, id);
  },

  async unmarkAsDuplicate(id: number): Promise<void> {
    await getDb().prepare(
      `UPDATE invoices SET duplicate_of = NULL, status = 'processed' WHERE id = ?`
    ).run(id);
  },

  async findMostRecentProcessedForContinuation(excludeId: number, withinMinutes: number = 2): Promise<Invoice | undefined> {
    return getDb().prepare(
      `SELECT * FROM invoices
       WHERE id != ?
       AND status = 'processed'
       AND created_at > (NOW() - INTERVAL ${withinMinutes} MINUTE)
       ORDER BY created_at DESC
       LIMIT 1`
    ).get<Invoice>(excludeId);
  },

  async markStaleAsFailed(staleMinutes: number = 5): Promise<number> {
    // Don't sweep dispatcher rows here — their lifetime is governed by
    // dispatcher_started_at via markStaleDispatchersAsFailed below.
    const result = await getDb().prepare(
      `UPDATE invoices
       SET status = 'error',
           error_message = COALESCE(error_message, 'Processing interrupted (stuck in non-terminal status)')
       WHERE status NOT IN ('processed', 'sent_to_1c', 'duplicate', 'error')
       AND dispatcher_token IS NULL
       AND created_at < (NOW() - INTERVAL ${staleMinutes} MINUTE)`
    ).run();
    return result.changes;
  },

  /**
   * Sweep dispatcher-mode invoices stuck in ocr_processing longer than
   * `staleMinutes` minutes. The dispatcher is supposed to call back within
   * ~30s of claiming the task; 15 min is a generous timeout that covers
   * Claude API slowness + queue delay.
   */
  async markStaleDispatchersAsFailed(staleMinutes: number = 15): Promise<number> {
    const result = await getDb().prepare(
      `UPDATE invoices
       SET status = 'error',
           error_message = COALESCE(error_message, ?),
           dispatcher_token = NULL,
           dispatcher_started_at = NULL
       WHERE dispatcher_started_at IS NOT NULL
       AND dispatcher_started_at < (NOW() - INTERVAL ${staleMinutes} MINUTE)`
    ).run(`Dispatcher timeout (>${staleMinutes} min, callback never arrived)`);
    return result.changes;
  },

  async listStaleForRecovery(): Promise<Array<{ id: number; file_name: string; itemsCount: number }>> {
    return getDb().prepare(
      `SELECT i.id, i.file_name,
        (SELECT COUNT(*) FROM invoice_items WHERE invoice_id = i.id) AS itemsCount
       FROM invoices i
       WHERE i.status IN ('ocr_processing', 'parsing')`
    ).all<{ id: number; file_name: string; itemsCount: number }>();
  },

  async findRecentBySupplier(supplier: string, excludeId: number, withinMinutes: number = 2): Promise<Invoice | undefined> {
    const candidates = await getDb().prepare(
      `SELECT * FROM invoices
       WHERE supplier IS NOT NULL AND supplier != ''
       AND id != ?
       AND created_at > (NOW() - INTERVAL ${withinMinutes} MINUTE)
       AND status IN ('processed', 'parsing', 'ocr_processing')
       ORDER BY created_at DESC`
    ).all<Invoice>(excludeId);

    for (const candidate of candidates) {
      if (candidate.supplier && suppliersMatch(supplier, candidate.supplier)) return candidate;
    }
    return undefined;
  },

  /**
   * Reverse multi-page lookup: find recently-processed standalone pages from
   * the same supplier that carry NO invoice_number — i.e. continuation pages
   * that landed before this header page (race-ordered dispatcher callbacks).
   * Returns all matches (a header may have several continuation pages).
   */
  async findNumberlessOrphansBySupplier(supplier: string, excludeId: number, withinMinutes: number = 5): Promise<Invoice[]> {
    const candidates = await getDb().prepare(
      `SELECT * FROM invoices
       WHERE supplier IS NOT NULL AND supplier != ''
       AND (invoice_number IS NULL OR invoice_number = '')
       AND id != ?
       AND duplicate_of IS NULL
       AND status = 'processed'
       AND created_at > (NOW() - INTERVAL ${withinMinutes} MINUTE)
       ORDER BY created_at ASC`
    ).all<Invoice>(excludeId);
    return candidates.filter(c => c.supplier && suppliersMatch(supplier, c.supplier));
  },

  /** Reassign every item from one invoice to another (multi-page merge). */
  async moveItemsToInvoice(fromInvoiceId: number, toInvoiceId: number): Promise<void> {
    await getDb()
      .prepare('UPDATE invoice_items SET invoice_id = ? WHERE invoice_id = ?')
      .run(toInvoiceId, fromInvoiceId);
  },

  /**
   * Recent same-supplier processed invoices with their item-sum + item-count,
   * for cumulative-total multi-page reconciliation (different invoice_number
   * on each page, so number/numberless strategies can't link them).
   */
  async findRecentSupplierPagesForReconcile(
    supplier: string, excludeId: number, withinMinutes: number = 5,
  ): Promise<Array<{ id: number; invoice_number: string | null; invoice_date: string | null; supplier: string | null; total_sum: number | null; items_sum: number; items_count: number }>> {
    const rows = await getDb().prepare(
      `SELECT i.id, i.invoice_number, i.invoice_date, i.supplier, i.total_sum,
              (SELECT COALESCE(SUM(total), 0) FROM invoice_items WHERE invoice_id = i.id) AS items_sum,
              (SELECT COUNT(*) FROM invoice_items WHERE invoice_id = i.id) AS items_count
         FROM invoices i
        WHERE i.supplier IS NOT NULL AND i.supplier != ''
          AND i.id != ?
          AND i.duplicate_of IS NULL
          AND i.status = 'processed'
          AND i.created_at > (NOW() - INTERVAL ${withinMinutes} MINUTE)
        ORDER BY i.created_at ASC`
    ).all<{ id: number; invoice_number: string | null; invoice_date: string | null; supplier: string | null; total_sum: number | null; items_sum: number; items_count: number }>(excludeId);
    return rows
      .filter(r => r.supplier && suppliersMatch(supplier, r.supplier))
      .map(r => ({ ...r, items_sum: Number(r.items_sum), items_count: Number(r.items_count) }));
  },

  async appendFileName(id: number, newFileName: string): Promise<void> {
    const invoice = await this.getById(id);
    if (invoice) {
      const updatedName = invoice.file_name.includes(newFileName)
        ? invoice.file_name
        : `${invoice.file_name}, ${newFileName}`;
      await getDb().prepare('UPDATE invoices SET file_name = ? WHERE id = ?').run(updatedName, id);
    }
  },

  async appendRawText(id: number, additionalText: string): Promise<void> {
    const invoice = await this.getById(id);
    if (invoice && invoice.raw_text) {
      const separator = '\n\n--- СТРАНИЦА ---\n\n';
      const updatedText = invoice.raw_text + separator + additionalText;
      await getDb().prepare('UPDATE invoices SET raw_text = ? WHERE id = ?').run(updatedText, id);
    }
  },

  async recalculateTotal(id: number): Promise<void> {
    const db = getDb();
    const itemsRow = await db.prepare(
      'SELECT COALESCE(SUM(total), 0) as total FROM invoice_items WHERE invoice_id = ?'
    ).get<{ total: number }>(id);
    const itemsTotal = Number(itemsRow?.total ?? 0);
    const invoice = await db.prepare('SELECT total_sum FROM invoices WHERE id = ?').get<{ total_sum: number | null }>(id);
    const documentTotal = invoice?.total_sum ?? null;

    let mismatch = 0;
    let nextTotal: number;

    if (documentTotal != null && documentTotal > 0 && itemsTotal > 0) {
      const diff = Math.abs(documentTotal - itemsTotal);
      const relative = diff / Math.max(documentTotal, itemsTotal);
      mismatch = (diff > 1 && relative > 0.01) ? 1 : 0;
      nextTotal = documentTotal;
    } else {
      nextTotal = itemsTotal;
    }

    await db.prepare(
      'UPDATE invoices SET total_sum = ?, items_total_mismatch = ? WHERE id = ?'
    ).run(nextTotal, mismatch, id);
  },

  async deleteItems(invoiceId: number): Promise<void> {
    const db = getDb();
    const guids = await db.prepare(
      'SELECT DISTINCT onec_guid FROM invoice_items WHERE invoice_id = ? AND onec_guid IS NOT NULL'
    ).all<{ onec_guid: string }>(invoiceId);
    await db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(invoiceId);
    triggerStatsRecompute(guids.map(g => g.onec_guid));
  },

  async delete(id: number): Promise<{ file_name: string | null }> {
    const invoice = await this.getById(id);
    const fileName = invoice?.file_name ?? null;
    const db = getDb();
    const guids = await db.prepare(
      'SELECT DISTINCT onec_guid FROM invoice_items WHERE invoice_id = ? AND onec_guid IS NOT NULL'
    ).all<{ onec_guid: string }>(id);
    await db.transaction(async (txn) => {
      await txn.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(id);
      await txn.prepare('DELETE FROM invoices WHERE id = ?').run(id);
    });
    triggerStatsRecompute(guids.map(g => g.onec_guid));
    return { file_name: fileName };
  },

  async getStats(): Promise<{ byStatus: { status: string; count: number }[]; total: number }> {
    const db = getDb();
    const byStatus = await db.prepare(
      'SELECT status, COUNT(*) as count FROM invoices GROUP BY status'
    ).all<{ status: string; count: number }>();
    const totalRow = await db.prepare('SELECT COUNT(*) as count FROM invoices').get<{ count: number }>();
    return { byStatus, total: totalRow?.count ?? 0 };
  },

  async getAnalyzerConfig(): Promise<{ mode: string; anthropic_api_key: string | null; claude_model: string; llm_mapper_enabled: boolean; auto_send_1c: boolean; auto_send_sber: boolean; projectsflow_token: string | null; projectsflow_project_id: string | null }> {
    const row = await getDb()
      .prepare('SELECT mode, anthropic_api_key, claude_model, llm_mapper_enabled, auto_send_1c, auto_send_sber, projectsflow_token, projectsflow_project_id FROM analyzer_config WHERE id = 1')
      .get<{ mode: string; anthropic_api_key: string | null; claude_model: string | null; llm_mapper_enabled: number | null; auto_send_1c: number | null; auto_send_sber: number | null; projectsflow_token: string | null; projectsflow_project_id: string | null }>();
    return {
      mode: row?.mode ?? 'hybrid',
      anthropic_api_key: row?.anthropic_api_key ?? null,
      claude_model: row?.claude_model ?? 'claude-sonnet-4-6',
      llm_mapper_enabled: (row?.llm_mapper_enabled ?? 1) === 1,
      auto_send_1c: (row?.auto_send_1c ?? 0) === 1,
      auto_send_sber: (row?.auto_send_sber ?? 0) === 1,
      projectsflow_token: row?.projectsflow_token ?? null,
      projectsflow_project_id: row?.projectsflow_project_id ?? null,
    };
  },

  async updateAnalyzerConfig(
    mode: string,
    anthropicApiKey?: string | null,
    claudeModel?: string | null,
    llmMapperEnabled?: boolean,
    autoSend1c?: boolean,
    autoSendSber?: boolean,
    projectsflowToken?: string | null,
    projectsflowProjectId?: string | null,
  ): Promise<void> {
    const sets: string[] = ['mode = ?'];
    const vals: unknown[] = [mode];
    if (anthropicApiKey !== undefined) { sets.push('anthropic_api_key = ?'); vals.push(anthropicApiKey); }
    if (claudeModel !== undefined && claudeModel !== null) { sets.push('claude_model = ?'); vals.push(claudeModel); }
    if (llmMapperEnabled !== undefined) { sets.push('llm_mapper_enabled = ?'); vals.push(llmMapperEnabled ? 1 : 0); }
    if (autoSend1c !== undefined) { sets.push('auto_send_1c = ?'); vals.push(autoSend1c ? 1 : 0); }
    if (autoSendSber !== undefined) { sets.push('auto_send_sber = ?'); vals.push(autoSendSber ? 1 : 0); }
    if (projectsflowToken !== undefined) { sets.push('projectsflow_token = ?'); vals.push(projectsflowToken); }
    if (projectsflowProjectId !== undefined) { sets.push('projectsflow_project_id = ?'); vals.push(projectsflowProjectId); }
    await getDb().prepare(`UPDATE analyzer_config SET ${sets.join(', ')} WHERE id = 1`).run(...vals);
  },

  async getTelegramMessageId(id: number): Promise<number | null> {
    const row = await getDb()
      .prepare('SELECT telegram_message_id FROM invoices WHERE id = ?')
      .get<{ telegram_message_id: number | null }>(id);
    return row?.telegram_message_id ?? null;
  },

  async setTelegramMessageId(id: number, messageId: number): Promise<void> {
    await getDb()
      .prepare('UPDATE invoices SET telegram_message_id = ? WHERE id = ?')
      .run(messageId, id);
  },
};
