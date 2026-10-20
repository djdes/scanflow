import { getDb, type DbAdapter } from '../db';
import type { CostFormula, CostLine } from '../../pricing/unitCost';

export interface CostRule extends CostFormula {
  id: number; owner_user_id: number; supplier_key: string; name_key: string; raw_unit: string; scanned_name: string; active: number;
}
export interface CostInvoice {
  id: number; owner_user_id: number; supplier: string | null; supplier_inn: string | null;
  invoice_number: string | null; status: string; duplicate_of: number | null;
}
export interface CostCandidate extends CostLine {
  supplier: string | null; supplier_inn: string | null; invoice_number: string | null;
}
export const itemCostRepo = {
  async rules(owner: number, db = getDb()): Promise<CostRule[]> {
    return db.prepare('SELECT * FROM item_cost_rules WHERE owner_user_id = ? AND active = 1').all<CostRule>(owner);
  },
  async rule(owner: number, supplierKey: string, nameKey: string, rawUnit: string, db: DbAdapter, lock = false) {
    return (await db.prepare(`SELECT * FROM item_cost_rules WHERE owner_user_id = ? AND supplier_key = ? AND name_key = ? AND raw_unit = ?${lock ? ' FOR UPDATE' : ''}`)
      .get<CostRule>(owner, supplierKey, nameKey, rawUnit)) ?? null;
  },
  async candidates(owner: number, cursor: number): Promise<CostCandidate[]> {
    // Batches/cursor avoid an arbitrary historical cutoff and never scan another owner's lines.
    return getDb().prepare(`SELECT it.*, inv.supplier, inv.supplier_inn, inv.invoice_number
      FROM invoice_items it JOIN invoices inv ON inv.id = it.invoice_id
      WHERE inv.owner_user_id = ? AND inv.status IN ('processed', 'sent_to_1c') AND inv.duplicate_of IS NULL AND it.id < ?
        AND (LOWER(it.original_name) REGEXP '[0-9][[:space:]]*(шт|штук|этикет|лист|пар)'
          OR EXISTS (SELECT 1 FROM item_cost_rules r WHERE r.owner_user_id = inv.owner_user_id AND r.active = 1 AND r.scanned_name = it.original_name))
      ORDER BY it.id DESC LIMIT 200`).all<CostCandidate>(owner, cursor);
  },
  async decisions(owner: number, ids: number[], db = getDb()) {
    if (!ids.length) return new Map<number, string>();
    const rows = await db.prepare(`SELECT item_id, fingerprint FROM item_cost_decisions WHERE owner_user_id = ? AND item_id IN (${ids.map(() => '?').join(',')})`)
      .all<{ item_id: number; fingerprint: string }>(owner, ...ids);
    return new Map(rows.map(row => [row.item_id, row.fingerprint]));
  },
};
