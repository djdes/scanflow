import { getDb } from '../db';
import {
  normalizeInvoiceNumber,
  extractDigitSequence,
  suppliersMatch,
} from '../../utils/invoiceNumber';
import { recomputeMedianForGuids } from '../../pricing/priceStats';
import { deriveVatSum } from '../../parser/itemSanitizer';

// Multi-page hold: a freshly-recognized invoice is withheld from /pending for
// this many minutes so a SECOND photographed page still has time to auto-merge
// into it (the merger only sees rows still in status 'processed' — once 1C
// pulls + confirms page 1, its status flips to 'sent_to_1c' and the second page
// can no longer fold in; see findRecentByNumber). 0 disables the hold.
// Tunable via env without redeploy. Context: invoices #424 (ids 143/145) split
// because page 1 reached 1C 33s after upload, before page 2 was even shot.
const MULTIPAGE_HOLD_MINUTES = (() => {
  const n = Number(process.env.ONEC_MULTIPAGE_HOLD_MINUTES);
  return Number.isFinite(n) && n >= 0 ? n : 5;
})();

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
  recognized_at: string | null;   // set by updateStatus('processed') on first recognition, never at create()
  upload_source: string | null;
  upload_user_agent: string | null;
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
  row_no: number | null;
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
  upload_source?: string | null;
  upload_user_agent?: string | null;
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
  row_no?: number | null;
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
        INSERT INTO invoices (file_name, file_path, invoice_number, invoice_date, supplier, invoice_type, supplier_inn, supplier_kpp, supplier_bik, supplier_account, supplier_corr_account, supplier_address, total_sum, vat_sum, raw_text, ocr_engine, file_hash, upload_source, upload_user_agent)
        VALUES (:file_name, :file_path, :invoice_number, :invoice_date, :supplier, :invoice_type, :supplier_inn, :supplier_kpp, :supplier_bik, :supplier_account, :supplier_corr_account, :supplier_address, :total_sum, :vat_sum, :raw_text, :ocr_engine, :file_hash, :upload_source, :upload_user_agent)
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
        upload_source: data.upload_source ?? null,
        upload_user_agent: data.upload_user_agent != null ? data.upload_user_agent.slice(0, 512) : null,
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

    // Reservation window: once an invoice is handed to a 1C load run, hide it
    // from /pending for RESERVE_MINUTES. Without this, a SECOND run (manual click
    // while the scheduled job runs, or overlapping регламентные задания) pulls the
    // SAME invoice before the first run's confirm marks it sent — and creates a
    // DUPLICATE ПриходнаяНакладная. If confirm never arrives (failure), the
    // invoice reappears after the window for an automatic retry.
    const RESERVE_MINUTES = 3;
    // Freshness hold (multi-page window): withhold just-recognized invoices for
    // MULTIPAGE_HOLD_MINUTES so a second page can still auto-merge before 1C
    // pulls page 1. Uses recognized_at (when OCR finished), falling back to
    // created_at for legacy rows. recognized_at sits far in the past for older
    // invoices, so re-approving an old invoice is NOT delayed — only fresh ones.
    const holdClause = MULTIPAGE_HOLD_MINUTES > 0
      ? `AND COALESCE(recognized_at, created_at) <= (NOW() - INTERVAL ${MULTIPAGE_HOLD_MINUTES} MINUTE)`
      : '';
    const pendingWhere =
      `approved_for_1c = 1
       AND status IN ('processed', 'parsing', 'ocr_processing')
       AND (onec_pulled_at IS NULL OR onec_pulled_at < (NOW() - INTERVAL ${RESERVE_MINUTES} MINUTE))
       ${holdClause}`;

    const totalRow = await db.prepare(
      `SELECT COUNT(*) as c FROM invoices WHERE ${pendingWhere}`
    ).get<{ c: number }>();
    const total = totalRow?.c ?? 0;

    // limit/offset are sanitized integers above; inline them (mysql2 rejects
    // LIMIT/OFFSET as prepared-statement placeholders on some MySQL builds).
    const invoices = await db.prepare(
      `SELECT * FROM invoices
       WHERE ${pendingWhere}
       ORDER BY created_at ASC
       LIMIT ${limit} OFFSET ${offset}`
    ).all<Invoice>();

    if (invoices.length === 0) return { rows: [], total };

    const ids = invoices.map(i => i.id);
    const placeholders = ids.map(() => '?').join(',');

    // Reserve the just-pulled invoices so the next poll (concurrent or immediate)
    // skips them. Stamped here, at hand-off time — not at confirm time.
    await db.prepare(
      `UPDATE invoices SET onec_pulled_at = NOW() WHERE id IN (${placeholders})`
    ).run(...ids);

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
    // Clear any stale reservation so a (re-)approved invoice is immediately
    // pullable by the next /pending poll instead of waiting out an old window.
    await getDb()
      .prepare("UPDATE invoices SET approved_for_1c = 1, approved_at = NOW(), onec_pulled_at = NULL WHERE id = ?")
      .run(id);
  },

  async unapproveForOneC(id: number): Promise<void> {
    await getDb()
      .prepare('UPDATE invoices SET approved_for_1c = 0, approved_at = NULL WHERE id = ?')
      .run(id);
  },

  /** Distinct supplier spellings with a representative ИНН and invoice count
   *  (most-used spelling first). Backs supplier fuzzy-dedup. */
  async distinctSuppliers(): Promise<Array<{ supplier: string; supplier_inn: string | null; count: number }>> {
    return getDb().prepare(
      `SELECT supplier, MAX(supplier_inn) AS supplier_inn, COUNT(*) AS count
       FROM invoices
       WHERE supplier IS NOT NULL AND supplier <> ''
       GROUP BY supplier
       ORDER BY count DESC, supplier ASC`
    ).all<{ supplier: string; supplier_inn: string | null; count: number }>();
  },

  /**
   * Resolve a freshly-parsed supplier name to an already-stored canonical
   * spelling so OCR drift ("…ГКОМПАНИЙ" vs "…ГКОМПАНИ") doesn't fork the
   * supplier. Priority: exact ИНН (dominant spelling for that ИНН), then a
   * fuzzy name match ≥ 70%. Never matches across two DIFFERENT non-null ИНН.
   * Returns null when nothing close exists (genuinely new supplier).
   */
  async findCanonicalSupplier(rawName: string, inn: string | null | undefined): Promise<string | null> {
    const db = getDb();
    const innTrim = inn ? String(inn).trim() : '';
    if (innTrim) {
      const row = await db.prepare(
        `SELECT supplier FROM invoices
         WHERE supplier_inn = ? AND supplier IS NOT NULL AND supplier <> ''
         GROUP BY supplier ORDER BY COUNT(*) DESC LIMIT 1`
      ).get<{ supplier: string }>(innTrim);
      if (row?.supplier) return row.supplier;
    }
    const names = await this.distinctSuppliers();
    let best: { name: string; count: number } | null = null;
    for (const r of names) {
      // Don't merge across distinct legal entities.
      if (innTrim && r.supplier_inn && innTrim !== r.supplier_inn) continue;
      if (suppliersMatch(rawName, r.supplier, 0.70)) {
        if (!best || r.count > best.count) best = { name: r.supplier, count: r.count };
      }
    }
    return best?.name ?? null;
  },

  /** Rewrite every invoice whose supplier is in `fromNames` to `toName`. */
  async renameSupplier(fromNames: string[], toName: string): Promise<number> {
    const targets = fromNames.filter(n => n && n !== toName);
    if (targets.length === 0) return 0;
    const placeholders = targets.map(() => '?').join(',');
    const res = await getDb().prepare(
      `UPDATE invoices SET supplier = ? WHERE supplier IN (${placeholders})`
    ).run(toName, ...targets);
    return res.changes;
  },

  async updateFilePath(id: number, filePath: string): Promise<void> {
    await getDb().prepare('UPDATE invoices SET file_path = ? WHERE id = ?').run(filePath, id);
  },

  async updateStatus(id: number, status: string, errorMessage?: string): Promise<void> {
    const db = getDb();
    if (errorMessage) {
      await db.prepare('UPDATE invoices SET status = ?, error_message = ? WHERE id = ?').run(status, errorMessage, id);
    } else if (status === 'processed') {
      // Stamp recognition-finish time the FIRST time the invoice reaches
      // 'processed'. COALESCE preserves the original on later reprocess/rescan,
      // so «Затрачено» (recognized_at − created_at) stays the real OCR time.
      await db.prepare(
        'UPDATE invoices SET status = ?, recognized_at = COALESCE(recognized_at, NOW()) WHERE id = ?'
      ).run(status, id);
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
      INSERT INTO invoice_items (invoice_id, original_name, mapped_name, quantity, unit, price, total, vat_rate, mapping_confidence, onec_guid, row_no)
      VALUES (:invoice_id, :original_name, :mapped_name, :quantity, :unit, :price, :total, :vat_rate, :mapping_confidence, :onec_guid, :row_no)
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
      row_no: data.row_no ?? null,
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

  /** True when the invoice has at least one item not yet mapped to 1C
   *  (onec_guid IS NULL) — i.e. 1C will create new Номенклатура for it. */
  async hasUnmatchedItems(invoiceId: number): Promise<boolean> {
    const row = await getDb().prepare(
      `SELECT 1 AS x FROM invoice_items WHERE invoice_id = ? AND onec_guid IS NULL LIMIT 1`
    ).get<{ x: number }>(invoiceId);
    return !!row;
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

  // Find "sibling" invoices that are almost certainly pages of the SAME invoice
  // that got split into separate rows (auto-merge window expired or the original
  // was already sent). Unlike findRecentByNumber there is NO time window and NO
  // status filter — the split is often discovered long after both rows are
  // 'sent_to_1c'. Signature is intentionally strict (number + supplier + date)
  // so unrelated invoices that merely share a number never surface.
  async findSiblings(id: number): Promise<Array<{
    id: number;
    invoice_number: string | null;
    invoice_date: string | null;
    supplier: string | null;
    total_sum: number | null;
    status: string;
    approved_for_1c: number;
    items_count: number;
  }>> {
    const self = await this.getById(id);
    if (!self || !self.invoice_number) return [];
    const targetNormalized = normalizeInvoiceNumber(self.invoice_number);
    if (!targetNormalized) return [];

    // SQL pre-filter. When the current invoice HAS a date, narrow to candidates
    // with the same date or no date (the date rule allows a date-less sibling).
    // When it has no date, we can't narrow by date — match on number/supplier.
    const dateClause = self.invoice_date
      ? 'AND (invoice_date = :curDate OR invoice_date IS NULL)'
      : '';
    const candidates = await getDb().prepare(
      `SELECT id, invoice_number, invoice_date, supplier, total_sum, status, approved_for_1c,
              (SELECT COUNT(*) FROM invoice_items ii WHERE ii.invoice_id = i.id) AS items_count
       FROM invoices i
       WHERE invoice_number IS NOT NULL AND invoice_number != ''
         AND duplicate_of IS NULL
         AND id != :id
         ${dateClause}
       ORDER BY id ASC`
    ).all<{
      id: number; invoice_number: string | null; invoice_date: string | null;
      supplier: string | null; total_sum: number | null; status: string;
      approved_for_1c: number; items_count: number;
    }>(self.invoice_date ? { id, curDate: self.invoice_date } : { id });

    return candidates.filter((c) =>
      normalizeInvoiceNumber(c.invoice_number) === targetNormalized &&
      suppliersMatch(self.supplier, c.supplier),
    );
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
   * Sweep dispatcher-mode invoices stuck in ocr_processing. The "stale" clock
   * measures from when the worker actually STARTED the task (first photo fetch →
   * dispatcher_fetched_at), NOT from dispatch time. A single serial worker
   * draining a batch leaves later tasks queued for >15 min before it even
   * starts them; killing those while still queued was the production incident
   * (the token got cleared mid-queue → worker hit 401 on the photo).
   *
   *   - fetched but silent > processingStaleMinutes → hung mid-OCR → error
   *   - never fetched     > queueStaleMinutes       → dead worker / abandoned → error
   *
   * `dispatcher_started_at` is non-null only while a row is ocr_processing (set
   * on dispatch, cleared on callback/sweep), so the status guard is belt-and-braces.
   */
  async markStaleDispatchersAsFailed(
    processingStaleMinutes: number = 15,
    queueStaleMinutes: number = 180,
  ): Promise<number> {
    const result = await getDb().prepare(
      `UPDATE invoices
       SET status = 'error',
           error_message = COALESCE(error_message, ?),
           dispatcher_token = NULL,
           dispatcher_started_at = NULL,
           dispatcher_fetched_at = NULL
       WHERE status = 'ocr_processing'
       AND dispatcher_started_at IS NOT NULL
       AND (
         (dispatcher_fetched_at IS NOT NULL AND dispatcher_fetched_at < (NOW() - INTERVAL ${processingStaleMinutes} MINUTE))
         OR
         (dispatcher_fetched_at IS NULL AND dispatcher_started_at < (NOW() - INTERVAL ${queueStaleMinutes} MINUTE))
       )`
    ).run(`Dispatcher timeout (no callback): processing>${processingStaleMinutes}min or queued>${queueStaleMinutes}min`);
    return result.changes;
  },

  /**
   * Stamp the moment the dispatcher worker first claimed this task's photo.
   * This anchors the processing-timeout clock to real work-start instead of
   * dispatch time. Guarded to ocr_processing so a stray late fetch after the
   * row already completed/failed can't re-stamp it.
   */
  async markDispatcherFetched(invoiceId: number): Promise<void> {
    await getDb().prepare(
      `UPDATE invoices SET dispatcher_fetched_at = NOW()
       WHERE id = ? AND status = 'ocr_processing'`
    ).run(invoiceId);
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

  /** Reassign every item from one invoice to another (multi-page merge). */
  async moveItemsToInvoice(fromInvoiceId: number, toInvoiceId: number): Promise<void> {
    await getDb()
      .prepare('UPDATE invoice_items SET invoice_id = ? WHERE invoice_id = ?')
      .run(toInvoiceId, fromInvoiceId);
  },

  /**
   * Sibling pages for dispatcher multi-page reconciliation.
   *
   * Pages of one invoice are UPLOADED together (near-identical created_at) but
   * the dispatcher OCRs each as a separate task, so callbacks can arrive 10+
   * min apart. A NOW()-anchored window therefore misses the sibling. We anchor
   * on proximity to the CURRENT page's upload time instead — that stays tight
   * (seconds) no matter how long OCR took.
   *
   * Returns processed non-duplicate pages within ±windowMinutes of
   * `referenceCreatedAt`, with the aggregates the reconciler needs: item
   * sum/count and the row_no range (for "starts at row > 1" continuation).
   *
   * NOTE: candidates are NOT pre-filtered by supplier. OCR routinely misreads
   * the supplier text differently across pages of one invoice (e.g. ОПТИКОМ vs
   * ОПТТОРГ), so a supplier gate here would discard the real sibling before the
   * decisive structural signals (contiguous row_no / same number) are even
   * checked. The reconciler applies supplier matching per-signal instead.
   */
  async findSiblingPagesNearUpload(
    excludeId: number, referenceCreatedAt: string, windowMinutes: number = 30,
  ): Promise<Array<{
    id: number; invoice_number: string | null; invoice_date: string | null; supplier: string | null;
    total_sum: number | null; created_at: string;
    items_sum: number; items_count: number; min_row: number | null; max_row: number | null;
  }>> {
    const rows = await getDb().prepare(
      `SELECT i.id, i.invoice_number, i.invoice_date, i.supplier, i.total_sum, i.created_at,
              (SELECT COALESCE(SUM(total), 0) FROM invoice_items WHERE invoice_id = i.id) AS items_sum,
              (SELECT COUNT(*)              FROM invoice_items WHERE invoice_id = i.id) AS items_count,
              (SELECT MIN(row_no)           FROM invoice_items WHERE invoice_id = i.id) AS min_row,
              (SELECT MAX(row_no)           FROM invoice_items WHERE invoice_id = i.id) AS max_row
         FROM invoices i
        WHERE i.supplier IS NOT NULL AND i.supplier != ''
          AND i.id != ?
          AND i.duplicate_of IS NULL
          AND i.status = 'processed'
          AND ABS(TIMESTAMPDIFF(MINUTE, i.created_at, ?)) <= ${windowMinutes}
        ORDER BY ABS(TIMESTAMPDIFF(SECOND, i.created_at, ?)) ASC`
    ).all<{
      id: number; invoice_number: string | null; invoice_date: string | null; supplier: string | null;
      total_sum: number | null; created_at: string; items_sum: number; items_count: number;
      min_row: number | null; max_row: number | null;
    }>(excludeId, referenceCreatedAt, referenceCreatedAt);
    return rows
      .map(r => ({
        ...r,
        items_sum: Number(r.items_sum),
        items_count: Number(r.items_count),
        min_row: r.min_row == null ? null : Number(r.min_row),
        max_row: r.max_row == null ? null : Number(r.max_row),
      }));
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
    const items = await db.prepare(
      'SELECT total, vat_rate FROM invoice_items WHERE invoice_id = ?'
    ).all<{ total: number | null; vat_rate: number | null }>(id);
    const itemsTotal = items.reduce((s, i) => s + Number(i.total ?? 0), 0);
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

    // vat_sum is a *derived* value (prices are VAT-included by convention), so
    // recompute it from per-item rates here. This keeps it correct after
    // дофоткать/merge (where total_sum gets bumped to the grand total but the
    // stored vat_sum would otherwise stay at a page-1 partial) and fills it in
    // when Claude missed the "в т.ч. НДС" cell. When rates are incomplete,
    // deriveVatSum returns null → we leave the existing vat_sum untouched.
    const derivedVat = deriveVatSum(
      items.map(i => ({ total: i.total == null ? null : Number(i.total), vat_rate: i.vat_rate == null ? null : Number(i.vat_rate) })),
    );

    if (derivedVat != null) {
      await db.prepare(
        'UPDATE invoices SET total_sum = ?, items_total_mismatch = ?, vat_sum = ? WHERE id = ?'
      ).run(nextTotal, mismatch, derivedVat, id);
    } else {
      await db.prepare(
        'UPDATE invoices SET total_sum = ?, items_total_mismatch = ? WHERE id = ?'
      ).run(nextTotal, mismatch, id);
    }
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

  async getAnalyzerConfig(): Promise<{ mode: string; anthropic_api_key: string | null; claude_model: string; llm_mapper_enabled: boolean; auto_send_1c: boolean; auto_send_sber: boolean; projectsflow_token: string | null; projectsflow_project_id: string | null; dadata_api_key: string | null }> {
    const row = await getDb()
      .prepare('SELECT mode, anthropic_api_key, claude_model, llm_mapper_enabled, auto_send_1c, auto_send_sber, projectsflow_token, projectsflow_project_id, dadata_api_key FROM analyzer_config WHERE id = 1')
      .get<{ mode: string; anthropic_api_key: string | null; claude_model: string | null; llm_mapper_enabled: number | null; auto_send_1c: number | null; auto_send_sber: number | null; projectsflow_token: string | null; projectsflow_project_id: string | null; dadata_api_key: string | null }>();
    return {
      mode: row?.mode ?? 'hybrid',
      anthropic_api_key: row?.anthropic_api_key ?? null,
      claude_model: row?.claude_model ?? 'claude-sonnet-4-6',
      llm_mapper_enabled: (row?.llm_mapper_enabled ?? 1) === 1,
      auto_send_1c: (row?.auto_send_1c ?? 0) === 1,
      auto_send_sber: (row?.auto_send_sber ?? 0) === 1,
      projectsflow_token: row?.projectsflow_token ?? null,
      projectsflow_project_id: row?.projectsflow_project_id ?? null,
      dadata_api_key: row?.dadata_api_key ?? null,
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
    dadataApiKey?: string | null,
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
    if (dadataApiKey !== undefined) { sets.push('dadata_api_key = ?'); vals.push(dadataApiKey); }
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
