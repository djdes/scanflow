import { getDb, type DbAdapter } from '../db';
import { invoiceRepo } from './invoiceRepo';
import { recomputeMedianForGuids } from '../../pricing/priceStats';
import { deleteStoredInvoiceFiles } from '../../utils/invoiceFiles';
import { logger } from '../../utils/logger';

// Корзина (миграция 95, 2026-11-17). Удалённая человеком накладная не исчезает сразу:
// строка накладной, её товары и снимки шапки сохраняются в JSON на TRASH_DAYS дней,
// фото остаются на диске. «Вернуть» вставляет строки обратно с теми же id;
// ночная очистка удаляет старые снимки вместе с фото.
export const TRASH_DAYS = 30;

type Row = Record<string, unknown>;

export interface TrashEntry {
  id: number;
  invoice_id: number;
  invoice_number: string | null;
  supplier: string | null;
  total_sum: number | null;
  reason: string | null;
  deleted_at: string;
  days_left: number;
}

export class TrashRestoreError extends Error {
  constructor(public code: 'not_found' | 'exists' | 'duplicate_file', message: string) { super(message); }
}

async function columnsOf(db: DbAdapter, table: string): Promise<Set<string>> {
  const rows = await db.prepare(
    `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`
  ).all<{ name: string }>(table);
  return new Set(rows.map(r => r.name));
}

async function tableExists(db: DbAdapter, table: string): Promise<boolean> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`
  ).get<{ n: number }>(table);
  return Number(row?.n) > 0;
}

// Имена колонок — только из текущей схемы таблицы (правило 18: никакого ввода в
// идентификаторах SQL); ключи снимка, которых в схеме уже нет, отбрасываются.
async function insertRow(db: DbAdapter, table: string, row: Row, allowed: Set<string>): Promise<void> {
  const keys = Object.keys(row).filter(k => allowed.has(k));
  if (!keys.length) return;
  await db.prepare(
    `INSERT INTO ${table} (${keys.map(k => `\`${k}\``).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
  ).run(...keys.map(k => row[k] as never));
}

export const trashRepo = {
  /** Снимок в корзину, затем обычное удаление. Возвращает id записи корзины. */
  async moveToTrash(invoiceId: number, deletedBy: number | null, reason: string): Promise<number | null> {
    const db = getDb();
    const invoice = await db.prepare('SELECT * FROM invoices WHERE id = ?').get<Row>(invoiceId);
    if (!invoice) return null;
    const items = await db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id').all<Row>(invoiceId);
    const snapshots = await tableExists(db, 'invoice_snapshots')
      ? await db.prepare('SELECT * FROM invoice_snapshots WHERE invoice_id = ? ORDER BY id').all<Row>(invoiceId)
      : [];
    const comments = await tableExists(db, 'invoice_comments')
      ? await db.prepare('SELECT * FROM invoice_comments WHERE invoice_id = ? ORDER BY id').all<Row>(invoiceId)
      : [];
    const res = await db.prepare(
      `INSERT INTO deleted_invoices
         (invoice_id, owner_user_id, invoice_number, supplier, total_sum, file_name,
          invoice_json, items_json, snapshots_json, comments_json, deleted_by, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      invoiceId,
      (invoice.owner_user_id as number | null) ?? null,
      (invoice.invoice_number as string | null) ?? null,
      (invoice.supplier as string | null) ?? null,
      (invoice.total_sum as number | null) ?? null,
      (invoice.file_name as string | null) ?? null,
      JSON.stringify(invoice), JSON.stringify(items), JSON.stringify(snapshots), JSON.stringify(comments),
      deletedBy, reason,
    );
    const trashId = Number(res.lastInsertRowid);
    try {
      await invoiceRepo.delete(invoiceId);
    } catch (err) {
      await db.prepare('DELETE FROM deleted_invoices WHERE id = ?').run(trashId);
      throw err;
    }
    return trashId;
  },

  async list(ownerId: number): Promise<TrashEntry[]> {
    const rows = await getDb().prepare(
      `SELECT id, invoice_id, invoice_number, supplier, total_sum, reason, deleted_at,
              GREATEST(0, ${TRASH_DAYS} - DATEDIFF(NOW(), deleted_at)) AS days_left
         FROM deleted_invoices
        WHERE owner_user_id = ? AND deleted_at >= NOW() - INTERVAL ${TRASH_DAYS} DAY
        ORDER BY deleted_at DESC, id DESC
        LIMIT 500`
    ).all<TrashEntry>(ownerId);
    return rows.map(r => ({ ...r, days_left: Number(r.days_left) }));
  },

  async count(ownerId: number): Promise<number> {
    const row = await getDb().prepare(
      `SELECT COUNT(*) AS n FROM deleted_invoices WHERE owner_user_id = ? AND deleted_at >= NOW() - INTERVAL ${TRASH_DAYS} DAY`
    ).get<{ n: number }>(ownerId);
    return Number(row?.n) || 0;
  },

  /** Вернуть накладную с прежним id. Своя компания проверяется по owner_user_id. */
  async restore(trashId: number, ownerId: number): Promise<number> {
    const db = getDb();
    const entry = await db.prepare(
      'SELECT * FROM deleted_invoices WHERE id = ? AND owner_user_id = ?'
    ).get<Row>(trashId, ownerId);
    if (!entry) throw new TrashRestoreError('not_found', 'Запись в корзине не найдена');
    const invoice = JSON.parse(String(entry.invoice_json)) as Row;
    const items = JSON.parse(String(entry.items_json)) as Row[];
    const snapshots = entry.snapshots_json ? JSON.parse(String(entry.snapshots_json)) as Row[] : [];
    const comments = entry.comments_json ? JSON.parse(String(entry.comments_json)) as Row[] : [];
    const invoiceId = Number(entry.invoice_id);
    if (await db.prepare('SELECT id FROM invoices WHERE id = ?').get(invoiceId)) {
      throw new TrashRestoreError('exists', 'Накладная с этим номером записи уже есть');
    }
    if (invoice.file_hash) {
      const twin = await db.prepare(
        'SELECT id FROM invoices WHERE owner_user_id <=> ? AND file_hash = ?'
      ).get<{ id: number }>(invoice.owner_user_id ?? null, invoice.file_hash);
      if (twin) {
        throw new TrashRestoreError('duplicate_file', `Это же фото уже загружено заново — накладная #${twin.id}`);
      }
    }
    await db.transaction(async txn => {
      await insertRow(txn, 'invoices', invoice, await columnsOf(txn, 'invoices'));
      const itemCols = await columnsOf(txn, 'invoice_items');
      for (const item of items) await insertRow(txn, 'invoice_items', item, itemCols);
      if (snapshots.length && await tableExists(txn, 'invoice_snapshots')) {
        const snapCols = await columnsOf(txn, 'invoice_snapshots');
        for (const snap of snapshots) await insertRow(txn, 'invoice_snapshots', snap, snapCols);
      }
      if (comments.length && await tableExists(txn, 'invoice_comments')) {
        const commentCols = await columnsOf(txn, 'invoice_comments');
        for (const c of comments) await insertRow(txn, 'invoice_comments', c, commentCols);
      }
      await txn.prepare('DELETE FROM deleted_invoices WHERE id = ?').run(trashId);
    });
    const guids = [...new Set(items.map(i => i.onec_guid).filter((g): g is string => typeof g === 'string' && g !== ''))];
    if (guids.length) void recomputeMedianForGuids(guids, ownerId).catch(() => { /* logged inside */ });
    return invoiceId;
  },

  /** Удалить навсегда (вместе с фото). */
  async deleteForever(trashId: number, ownerId: number): Promise<boolean> {
    const db = getDb();
    const entry = await db.prepare(
      'SELECT id, file_name FROM deleted_invoices WHERE id = ? AND owner_user_id = ?'
    ).get<{ id: number; file_name: string | null }>(trashId, ownerId);
    if (!entry) return false;
    await db.prepare('DELETE FROM deleted_invoices WHERE id = ?').run(trashId);
    deleteStoredInvoiceFiles(entry.file_name);
    return true;
  },

  /** Ночная очистка: записи старше TRASH_DAYS удаляются вместе с фото. */
  async purgeExpired(): Promise<number> {
    const db = getDb();
    const rows = await db.prepare(
      `SELECT id, file_name FROM deleted_invoices WHERE deleted_at < NOW() - INTERVAL ${TRASH_DAYS} DAY`
    ).all<{ id: number; file_name: string | null }>();
    for (const row of rows) {
      try {
        await db.prepare('DELETE FROM deleted_invoices WHERE id = ?').run(row.id);
        deleteStoredInvoiceFiles(row.file_name);
      } catch (err) {
        logger.warn('trash purge failed', { id: row.id, error: (err as Error).message });
      }
    }
    return rows.length;
  },

  /** Имена файлов накладных в корзине — их не трогает очистка фото по сроку. */
  async fileNames(): Promise<string[]> {
    const rows = await getDb().prepare('SELECT file_name FROM deleted_invoices').all<{ file_name: string | null }>();
    const names = new Set<string>();
    for (const r of rows) for (const n of (r.file_name ?? '').split(',')) if (n.trim()) names.add(n.trim().split(/[\\/]/).pop()!);
    return [...names];
  },
};
