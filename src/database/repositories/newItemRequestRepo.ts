import { getDb } from '../db';
import type { NewItemRequestStatus, NewItemUnit, UnmappedLine } from '../../services/newItems';

/**
 * Заявки «Создать в 1С» (миграция 72, пакет v2 п.12) и выборка строк для
 * страницы «Новые товары».
 *
 * Владелец — обязательный параметр каждого метода, без значения по умолчанию:
 * забытый вызывающий — ошибка компиляции, а не межтенантная утечка (правило 19).
 */
export interface NewItemRequest {
  id: number;
  owner_user_id: number;
  name_key: string;
  name: string;
  unit: string;
  parent_guid: string | null;
  status: NewItemRequestStatus;
  onec_guid: string | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

/** Строка без позиции 1С + поля её накладной, нужные для пересчёта единиц. */
export interface UnsentUnmappedLine extends UnmappedLine {
  supplier_inn: string | null;
}

/**
 * «Неотправленная» накладная: распознана, в очередь 1С не поставлена, в 1С не
 * ушла и не помечена дублем. Строки таких накладных ещё можно менять.
 */
const UNSENT_INVOICE = `i.status = 'processed' AND i.approved_for_1c = 0 AND i.sent_at IS NULL AND i.duplicate_of IS NULL`;

/** Предохранитель: сколько строк максимум разбираем за раз (самые свежие). */
const LINES_CAP = 5000;

export const newItemRequestRepo = {
  /** Строки без позиции 1С из неотправленных накладных компании, от новых к старым. */
  async unsentUnmappedLines(ownerUserId: number): Promise<UnsentUnmappedLine[]> {
    return getDb().prepare(`
      SELECT ii.id, ii.invoice_id, ii.original_name, ii.mapped_name, ii.name_overridden,
             ii.unit, ii.raw_unit, ii.price, ii.raw_price,
             i.supplier, i.supplier_inn
        FROM invoice_items ii
        JOIN invoices i ON i.id = ii.invoice_id
       WHERE i.owner_user_id = ? AND ${UNSENT_INVOICE}
         AND (ii.onec_guid IS NULL OR ii.onec_guid = '')
       ORDER BY ii.id DESC
       LIMIT ${LINES_CAP}
    `).all<UnsentUnmappedLine>(ownerUserId);
  },

  async list(ownerUserId: number): Promise<NewItemRequest[]> {
    return getDb()
      .prepare('SELECT * FROM new_item_requests WHERE owner_user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 2000')
      .all<NewItemRequest>(ownerUserId);
  },

  async listPending(ownerUserId: number): Promise<NewItemRequest[]> {
    return getDb()
      .prepare(`SELECT * FROM new_item_requests WHERE owner_user_id = ? AND status = 'pending' ORDER BY id`)
      .all<NewItemRequest>(ownerUserId);
  },

  /** Ждущие заявки нескольких компаний разом — для выгрузки /pending (один запрос на вызов). */
  async listPendingForOwners(ownerUserIds: number[]): Promise<NewItemRequest[]> {
    const owners = Array.from(new Set(ownerUserIds.filter(o => Number.isInteger(o))));
    if (owners.length === 0) return [];
    return getDb()
      .prepare(`SELECT * FROM new_item_requests WHERE status = 'pending' AND owner_user_id IN (${owners.map(() => '?').join(',')})`)
      .all<NewItemRequest>(...owners);
  },

  async getById(ownerUserId: number, id: number): Promise<NewItemRequest | undefined> {
    return getDb()
      .prepare('SELECT * FROM new_item_requests WHERE id = ? AND owner_user_id = ?')
      .get<NewItemRequest>(id, ownerUserId);
  },

  async getByKey(ownerUserId: number, nameKey: string): Promise<NewItemRequest | undefined> {
    return getDb()
      .prepare('SELECT * FROM new_item_requests WHERE owner_user_id = ? AND name_key = ?')
      .get<NewItemRequest>(ownerUserId, nameKey.slice(0, 191));
  },

  /** Попросить 1С создать позицию (или обновить просьбу): заявка снова «ждёт». */
  async upsertPending(
    ownerUserId: number,
    r: { nameKey: string; name: string; unit: NewItemUnit; parentGuid: string | null; createdBy: number | null },
  ): Promise<NewItemRequest> {
    await getDb().prepare(`
      INSERT INTO new_item_requests (owner_user_id, name_key, name, unit, parent_guid, status, onec_guid, created_by)
      VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?)
      ON DUPLICATE KEY UPDATE name = VALUES(name), unit = VALUES(unit), parent_guid = VALUES(parent_guid),
        status = 'pending', onec_guid = NULL, created_by = VALUES(created_by)
    `).run(ownerUserId, r.nameKey.slice(0, 191), r.name.slice(0, 512), r.unit, r.parentGuid ? r.parentGuid.slice(0, 64) : null, r.createdBy);
    return (await this.getByKey(ownerUserId, r.nameKey))!;
  },

  /** Позиция появилась в каталоге 1С — заявка выполнена. Только из «ждёт». */
  async markCreated(ownerUserId: number, id: number, onecGuid: string): Promise<boolean> {
    const r = await getDb().prepare(
      `UPDATE new_item_requests SET status = 'created', onec_guid = ? WHERE id = ? AND owner_user_id = ? AND status = 'pending'`,
    ).run(onecGuid.slice(0, 64), id, ownerUserId);
    return r.changes > 0;
  },

  /** Отменить ждущую заявку. false — её нет или она уже не «ждёт». */
  async cancel(ownerUserId: number, id: number): Promise<boolean> {
    const r = await getDb().prepare(
      `UPDATE new_item_requests SET status = 'cancelled' WHERE id = ? AND owner_user_id = ? AND status = 'pending'`,
    ).run(id, ownerUserId);
    return r.changes > 0;
  },

  /** Группу сопоставили с существующей позицией — просьба создать новую больше не нужна. */
  async cancelPendingByKey(ownerUserId: number, nameKey: string): Promise<boolean> {
    const r = await getDb().prepare(
      `UPDATE new_item_requests SET status = 'cancelled' WHERE owner_user_id = ? AND name_key = ? AND status = 'pending'`,
    ).run(ownerUserId, nameKey.slice(0, 191));
    return r.changes > 0;
  },
};
