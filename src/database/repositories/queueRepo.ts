import { getDb } from '../db';
import type { InvoiceItem, ItemConversionColumns } from './invoiceRepo';
import { QUEUE_SQL, WORKABLE_SQL } from '../../services/queue';

/**
 * «Очередь в 1С»: выборки очереди и результаты перераспознавания
 * (queue_reocr_results, миграция 76). Всё — строго в области владельца
 * (правило 19): каждый метод требует ownerUserId.
 */

export interface QueueInvoiceRow {
  id: number;
  owner_user_id: number | null;
  invoice_number: string | null;
  invoice_date: string | null;
  supplier: string | null;
  supplier_inn: string | null;
  total_sum: number | null;
  vat_sum: number | null;
  created_at: string;
  file_name: string | null;
  file_path: string | null;
  items_total_mismatch: number;
  supplier_match: string | null;
  status: string;
  approved_for_1c: number;
  approved_at: string | null;
  sent_at: string | null;
  duplicate_of: number | null;
  onec_status: string | null;
  onec_error: string | null;
  onec_pulled_at: string | null;
  paid_externally: number;
  /** sber_payments (1:1 по invoice_id): статус отправки, номер, статус в банке. */
  sber_status: string | null;
  sber_payment_number: string | null;
  sber_bank_status: string | null;
  sber_bank_status_at: string | null;
}

/** Строка накладной + единица позиции 1С и обычная цена (JOIN каталога и статистики компании). */
export interface QueueLineRow extends InvoiceItem {
  onec_unit: string | null;
  /** 1, если позиция с onec_guid есть в каталоге компании. */
  onec_found: number | null;
  median_price: number | null;
  median_price_unit: string | null;
  median_samples: number | null;
}

/**
 * running — идёт; done — предложение готово (применено, если applied_at);
 * reverted — применили, потом вернули прежние строки; no_photo / skipped /
 * error — распознать не удалось или не нужно.
 */
export type ReocrStatus = 'running' | 'done' | 'reverted' | 'no_photo' | 'error' | 'skipped';

export interface ReocrRow {
  id: number;
  owner_user_id: number;
  invoice_id: number;
  status: ReocrStatus;
  model: string | null;
  pages: number | null;
  lines_fingerprint: string | null;
  /** JSON (ReocrSummary). */
  summary: string | null;
  /** JSON (HeaderDiffEntry[]). */
  header_diff: string | null;
  /** JSON (ProposedLine[]). */
  proposed: string | null;
  /** JSON — строки, которые заменили при применении (рычаг отката). */
  replaced: string | null;
  error: string | null;
  started_by: number | null;
  started_at: string;
  finished_at: string | null;
  applied_at: string | null;
  applied_by: number | null;
}

export type ReocrListRow = Omit<ReocrRow, 'proposed' | 'replaced'>;

/** Строка для вставки при замене строк накладной (все колонки invoice_items, кроме id). */
export interface ReplacementLine {
  original_name: string;
  mapped_name: string | null;
  quantity: number | null;
  unit: string | null;
  price: number | null;
  total: number | null;
  vat_rate: number | null;
  mapping_confidence: number;
  onec_guid: string | null;
  /** Порядковый номер из документа (при применении перераспознавания — нет). */
  row_no?: number | null;
  /** 1 — человек задал своё название для 1С (возвращается при откате). */
  name_overridden?: number | null;
  conversion: ItemConversionColumns;
}

export class QueueReplaceConflict extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'QueueReplaceConflict';
  }
}

export type InvoiceLockState = { status: string; approved_for_1c: number; sent_at: string | null; duplicate_of: number | null };

const cut = (s: string | null | undefined, n: number): string | null => (s == null ? null : String(s).slice(0, n));
const idList = (ids: number[]): number[] => [...new Set(ids.filter(n => Number.isInteger(n) && n > 0))];

const LINE_SELECT = `
  SELECT ii.*,
         oc.unit AS onec_unit,
         CASE WHEN oc.guid IS NULL THEN 0 ELSE 1 END AS onec_found,
         ps.median_price AS median_price,
         ps.price_unit   AS median_price_unit,
         ps.samples      AS median_samples
    FROM invoice_items ii
    JOIN invoices i ON i.id = ii.invoice_id
    LEFT JOIN onec_nomenclature_cards oc
           ON oc.owner_user_id = i.owner_user_id AND oc.guid = ii.onec_guid
    LEFT JOIN nomenclature_price_stat_cards ps
           ON ps.owner_user_id = i.owner_user_id AND ps.onec_guid = ii.onec_guid`;

/**
 * Последний результат перераспознавания накладной уже «решён»: предложение
 * готово (в том числе применено или отменено) или фото нет. Такие накладные
 * при повторном запуске всей очереди пропускаются — после перезапуска сервера
 * прогон продолжается с того места, где оборвался.
 */
const REOCR_DECIDED_SQL = `EXISTS (
  SELECT 1 FROM queue_reocr_results r
   WHERE r.owner_user_id = i.owner_user_id AND r.invoice_id = i.id
     AND r.status IN ('done', 'reverted', 'no_photo')
     AND r.id = (SELECT MAX(r2.id) FROM queue_reocr_results r2
                  WHERE r2.owner_user_id = i.owner_user_id AND r2.invoice_id = i.id))`;

export const queueRepo = {
  /** Накладные очереди: самые старые документы — первыми (в 1С их проводят по порядку). */
  async listQueueInvoices(ownerUserId: number): Promise<QueueInvoiceRow[]> {
    return getDb().prepare(`
      SELECT i.id, i.owner_user_id, i.invoice_number, i.invoice_date, i.supplier, i.supplier_inn,
             i.total_sum, i.vat_sum, i.created_at, i.file_name, i.file_path,
             i.items_total_mismatch, i.supplier_match, i.status, i.approved_for_1c, i.approved_at,
             i.sent_at, i.duplicate_of, i.onec_status, i.onec_error, i.onec_pulled_at, i.paid_externally,
             sp.status AS sber_status, sp.sber_payment_number, sp.bank_status AS sber_bank_status,
             sp.bank_status_at AS sber_bank_status_at
        FROM invoices i
        LEFT JOIN sber_payments sp ON sp.invoice_id = i.id
       WHERE i.owner_user_id = ? AND ${QUEUE_SQL}
       ORDER BY (i.invoice_date IS NULL), i.invoice_date, i.id
    `).all<QueueInvoiceRow>(ownerUserId);
  },

  /**
   * id накладных очереди, строки которых можно менять (не одобренные), в
   * порядке очереди. ids — ограничить выбранными (чужие, одобренные и не из
   * очереди молча отбрасываются); onlyWithUnmapped — только те, где есть строки
   * без позиции 1С и без своего названия; skipDecided — без тех, у кого
   * последнее перераспознавание уже дало результат (REOCR_DECIDED_SQL).
   */
  async queueIds(
    ownerUserId: number,
    opts: { ids?: number[] | null; onlyWithUnmapped?: boolean; skipDecided?: boolean } = {},
  ): Promise<number[]> {
    const where = ['i.owner_user_id = ?', WORKABLE_SQL];
    const params: unknown[] = [ownerUserId];
    if (opts.ids != null) {
      const ids = idList(opts.ids);
      if (!ids.length) return [];
      where.push(`i.id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }
    if (opts.onlyWithUnmapped) {
      where.push(`EXISTS (SELECT 1 FROM invoice_items ii
                           WHERE ii.invoice_id = i.id AND (ii.onec_guid IS NULL OR ii.onec_guid = '')
                             AND COALESCE(ii.name_overridden, 0) = 0)`);
    }
    if (opts.skipDecided) where.push(`NOT ${REOCR_DECIDED_SQL}`);
    const rows = await getDb().prepare(`
      SELECT i.id FROM invoices i
       WHERE ${where.join(' AND ')}
       ORDER BY (i.invoice_date IS NULL), i.invoice_date, i.id
    `).all<{ id: number }>(...params);
    return rows.map(r => Number(r.id));
  },

  /** Строки всех накладных очереди (для замечаний и отпечатков в списке). */
  async queueLines(ownerUserId: number): Promise<QueueLineRow[]> {
    return getDb().prepare(`${LINE_SELECT}
       WHERE i.owner_user_id = ? AND ${QUEUE_SQL}
       ORDER BY ii.invoice_id, ii.id`).all<QueueLineRow>(ownerUserId);
  },

  /** Строки одной накладной владельца (накладная может уже уйти из очереди). */
  async invoiceLines(ownerUserId: number, invoiceId: number): Promise<QueueLineRow[]> {
    return getDb().prepare(`${LINE_SELECT}
       WHERE i.owner_user_id = ? AND i.id = ?
       ORDER BY ii.id`).all<QueueLineRow>(ownerUserId, invoiceId);
  },

  /** Ключи товаров с ждущей заявкой «Создать в 1С» (new_item_requests, миграция 72). */
  async pendingNewItemKeys(ownerUserId: number): Promise<Set<string>> {
    try {
      const rows = await getDb()
        .prepare(`SELECT name_key FROM new_item_requests WHERE owner_user_id = ? AND status = 'pending'`)
        .all<{ name_key: string }>(ownerUserId);
      return new Set(rows.map(r => r.name_key));
    } catch {
      return new Set(); // до миграции 72 заявок нет
    }
  },

  /** Какие из guid есть в каталоге компании. */
  async existingGuids(ownerUserId: number, guids: string[]): Promise<Set<string>> {
    const list = [...new Set(guids.filter(g => typeof g === 'string' && g))];
    if (!list.length) return new Set();
    const rows = await getDb()
      .prepare(`SELECT guid FROM onec_nomenclature_cards WHERE owner_user_id = ? AND guid IN (${list.map(() => '?').join(',')})`)
      .all<{ guid: string }>(ownerUserId, ...list);
    return new Set(rows.map(r => r.guid));
  },

  // ── Результаты перераспознавания ──────────────────────────────────────────

  /** Последний результат по каждой накладной компании (без тяжёлых JSON строк). */
  async latestReocrByInvoice(ownerUserId: number): Promise<Map<number, ReocrListRow>> {
    const rows = await getDb().prepare(`
      SELECT r.id, r.owner_user_id, r.invoice_id, r.status, r.model, r.pages, r.lines_fingerprint,
             r.summary, r.header_diff, r.error, r.started_by, r.started_at, r.finished_at, r.applied_at, r.applied_by
        FROM queue_reocr_results r
        JOIN (SELECT invoice_id, MAX(id) AS id FROM queue_reocr_results
               WHERE owner_user_id = ? GROUP BY invoice_id) last ON last.id = r.id
       WHERE r.owner_user_id = ?
    `).all<ReocrListRow>(ownerUserId, ownerUserId);
    return new Map(rows.map(r => [Number(r.invoice_id), r]));
  },

  async latestReocr(ownerUserId: number, invoiceId: number): Promise<ReocrRow | undefined> {
    return getDb().prepare(`
      SELECT * FROM queue_reocr_results
       WHERE owner_user_id = ? AND invoice_id = ?
       ORDER BY id DESC LIMIT 1
    `).get<ReocrRow>(ownerUserId, invoiceId);
  },

  /** Начать прогон накладной: строка 'running'. */
  async startReocr(r: { ownerUserId: number; invoiceId: number; startedBy: number | null; model: string | null; pages: number }): Promise<number> {
    const res = await getDb().prepare(`
      INSERT INTO queue_reocr_results (owner_user_id, invoice_id, status, model, pages, started_by)
      VALUES (?, ?, 'running', ?, ?, ?)
    `).run(r.ownerUserId, r.invoiceId, cut(r.model, 64), r.pages, r.startedBy);
    return Number(res.lastInsertRowid);
  },

  async finishReocr(id: number, r: {
    status: 'done' | 'error';
    linesFingerprint?: string | null;
    summary?: unknown;
    headerDiff?: unknown;
    proposed?: unknown;
    error?: string | null;
  }): Promise<void> {
    await getDb().prepare(`
      UPDATE queue_reocr_results
         SET status = ?, lines_fingerprint = ?, summary = ?, header_diff = ?, proposed = ?, error = ?, finished_at = NOW()
       WHERE id = ?
    `).run(
      r.status,
      r.linesFingerprint ?? null,
      r.summary === undefined ? null : JSON.stringify(r.summary),
      r.headerDiff === undefined ? null : JSON.stringify(r.headerDiff),
      r.proposed === undefined ? null : JSON.stringify(r.proposed),
      cut(r.error ?? null, 500),
      id,
    );
  },

  /** Результат без распознавания (нет фото, накладная ушла из очереди): сразу законченная строка. */
  async recordReocrOutcome(r: { ownerUserId: number; invoiceId: number; startedBy: number | null; status: 'no_photo' | 'skipped'; pages: number; error: string }): Promise<void> {
    await getDb().prepare(`
      INSERT INTO queue_reocr_results (owner_user_id, invoice_id, status, pages, error, started_by, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, NOW())
    `).run(r.ownerUserId, r.invoiceId, r.status, r.pages, cut(r.error, 500), r.startedBy);
  },

  /**
   * Строки 'running', которые никто не выполняет (процесс перезапустили посреди
   * прогона), — в ошибку, чтобы интерфейс не ждал их вечно. Вызывать, только
   * когда у компании не идёт своё перераспознавание (reconcileInterruptedReocr).
   */
  async markInterruptedReocr(ownerUserId: number): Promise<number> {
    const res = await getDb().prepare(`
      UPDATE queue_reocr_results
         SET status = 'error', error = 'Прервано перезапуском сервера — перераспознайте ещё раз', finished_at = NOW()
       WHERE owner_user_id = ? AND status = 'running'
    `).run(ownerUserId);
    return res.changes;
  },

  /**
   * Заменить строки накладной одной транзакцией:
   *   1) заблокировать накладную и её строки (FOR UPDATE) и дать вызывающему
   *      проверить их (накладная всё ещё в очереди, строки не менялись с показа);
   *   2) отметить результат перераспознавания (mark: 'apply' — применён, в
   *      replaced ложатся прежние строки; 'revert' — прежние строки вернули).
   *      Результат уже в другом состоянии (второй клик) → конфликт;
   *   3) удалить прежние строки и вставить новые.
   * Шапку накладной не трогает. Возвращает прежние строки.
   */
  async replaceItems(opts: {
    ownerUserId: number;
    invoiceId: number;
    resultId: number;
    userId: number | null;
    mark: 'apply' | 'revert';
    lines: ReplacementLine[];
    check: (invoice: InvoiceLockState, items: InvoiceItem[]) => void;
  }): Promise<{ before: InvoiceItem[] }> {
    return getDb().transaction(async (txn) => {
      const inv = await txn.prepare(`
        SELECT status, approved_for_1c, sent_at, duplicate_of FROM invoices
         WHERE id = ? AND owner_user_id = ? FOR UPDATE
      `).get<InvoiceLockState>(opts.invoiceId, opts.ownerUserId);
      if (!inv) throw new QueueReplaceConflict('not_found', 'Накладная не найдена');
      const before = await txn.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id FOR UPDATE')
        .all<InvoiceItem>(opts.invoiceId);
      opts.check(inv, before);

      const marked = opts.mark === 'apply'
        ? await txn.prepare(`
            UPDATE queue_reocr_results SET applied_at = NOW(), applied_by = ?, replaced = ?
             WHERE id = ? AND owner_user_id = ? AND invoice_id = ? AND status = 'done' AND applied_at IS NULL
          `).run(opts.userId, JSON.stringify(before), opts.resultId, opts.ownerUserId, opts.invoiceId)
        : await txn.prepare(`
            UPDATE queue_reocr_results SET status = 'reverted'
             WHERE id = ? AND owner_user_id = ? AND invoice_id = ? AND status = 'done' AND applied_at IS NOT NULL
          `).run(opts.resultId, opts.ownerUserId, opts.invoiceId);
      if (marked.changes !== 1) {
        throw opts.mark === 'apply'
          ? new QueueReplaceConflict('already_applied', 'Это перераспознавание уже применено')
          : new QueueReplaceConflict('already_reverted', 'Прежние строки уже возвращены');
      }

      await txn.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(opts.invoiceId);
      const insert = txn.prepare(`
        INSERT INTO invoice_items (invoice_id, original_name, mapped_name, quantity, unit, price, total, vat_rate, mapping_confidence,
          onec_guid, row_no, name_overridden,
          raw_quantity, raw_unit, raw_price, raw_total, conv_factor, conv_note, conv_source, qty_flag, qty_flag_note)
        VALUES (:invoice_id, :original_name, :mapped_name, :quantity, :unit, :price, :total, :vat_rate, :mapping_confidence,
          :onec_guid, :row_no, :name_overridden,
          :raw_quantity, :raw_unit, :raw_price, :raw_total, :conv_factor, :conv_note, :conv_source, :qty_flag, :qty_flag_note)
      `);
      for (const l of opts.lines) {
        await insert.run(replacementParams(opts.invoiceId, l));
      }
      return { before };
    });
  },
};

const finiteOrNull = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Параметры INSERT для строки (ширина колонок — как в схеме invoice_items). */
export function replacementParams(invoiceId: number, l: ReplacementLine): Record<string, unknown> {
  const c = l.conversion;
  const rowNo = finiteOrNull(l.row_no);
  return {
    invoice_id: invoiceId,
    original_name: cut(l.original_name, 1024) ?? '',
    mapped_name: cut(l.mapped_name, 1024),
    quantity: finiteOrNull(l.quantity),
    unit: cut(l.unit, 64),
    price: finiteOrNull(l.price),
    total: finiteOrNull(l.total),
    vat_rate: finiteOrNull(l.vat_rate),
    mapping_confidence: finiteOrNull(l.mapping_confidence) ?? 0,
    onec_guid: l.onec_guid || null,
    row_no: rowNo != null ? Math.trunc(rowNo) : null,
    name_overridden: Number(l.name_overridden ?? 0) ? 1 : 0,
    raw_quantity: finiteOrNull(c.raw_quantity),
    raw_unit: cut(c.raw_unit, 32),
    raw_price: finiteOrNull(c.raw_price),
    raw_total: finiteOrNull(c.raw_total),
    conv_factor: finiteOrNull(c.conv_factor),
    conv_note: cut(c.conv_note, 255),
    conv_source: cut(c.conv_source, 16),
    qty_flag: cut(c.qty_flag, 24),
    qty_flag_note: cut(c.qty_flag_note, 255),
  };
}
