import { getDb } from '../db';
import { logger } from '../../utils/logger';

/**
 * Журнал правок «было → стало» (миграция 64).
 *
 * До v2 ручные правки количества, цены и сопоставлений нигде не сохранялись —
 * учиться было не на чем, а перераспознавание их стирало. Журнал — основа
 * самообучения (src/learning) и вкладки «История». Запись никогда не бросает:
 * журнал не должен ломать саму правку.
 */
export type EditEntity = 'invoice' | 'item' | 'mapping' | 'supplier' | 'rule' | 'system';

export interface EditEntry {
  ownerUserId: number | null;
  userId: number | null;
  invoiceId?: number | null;
  itemId?: number | null;
  entity: EditEntity;
  field: string;
  oldValue: unknown;
  newValue: unknown;
  context?: Record<string, unknown>;
}

export interface EditLogRow {
  id: number;
  owner_user_id: number | null;
  user_id: number | null;
  invoice_id: number | null;
  item_id: number | null;
  entity: EditEntity;
  field: string;
  old_value: string | null;
  new_value: string | null;
  context: string | null;
  created_at: string;
}

const MAX_VALUE = 2000;

export function serializeEditValue(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > MAX_VALUE ? s.slice(0, MAX_VALUE) + '…' : s;
}

export async function logEdit(e: EditEntry): Promise<void> {
  try {
    const oldV = serializeEditValue(e.oldValue);
    const newV = serializeEditValue(e.newValue);
    if (oldV === newV) return;
    await getDb().prepare(`
      INSERT INTO edit_log (owner_user_id, user_id, invoice_id, item_id, entity, field, old_value, new_value, context)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      e.ownerUserId ?? null, e.userId ?? null, e.invoiceId ?? null, e.itemId ?? null,
      e.entity, e.field.slice(0, 48), oldV, newV,
      e.context ? JSON.stringify(e.context).slice(0, 60000) : null,
    );
  } catch (err) {
    logger.warn('editLog: write failed', { field: e.field, invoiceId: e.invoiceId, error: (err as Error).message });
  }
}

export const editLogRepo = {
  async listForInvoice(invoiceId: number, limit = 200): Promise<EditLogRow[]> {
    const lim = Math.max(1, Math.min(1000, Math.trunc(limit)));
    return getDb()
      .prepare(`SELECT * FROM edit_log WHERE invoice_id = ? ORDER BY id DESC LIMIT ${lim}`)
      .all<EditLogRow>(invoiceId);
  },

  /** Для майнера правил: правки компании за последние N дней. */
  async listForOwnerSince(ownerUserId: number, days: number, entity?: EditEntity): Promise<EditLogRow[]> {
    const d = Math.max(1, Math.min(365, Math.trunc(days)));
    const params: unknown[] = [ownerUserId];
    let where = `owner_user_id = ? AND created_at >= (NOW() - INTERVAL ${d} DAY)`;
    if (entity) { where += ' AND entity = ?'; params.push(entity); }
    return getDb().prepare(`SELECT * FROM edit_log WHERE ${where} ORDER BY id`).all<EditLogRow>(...params);
  },
};
