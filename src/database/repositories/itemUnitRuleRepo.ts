import { getDb } from '../db';

/**
 * Правила пересчёта единиц «поставщик + товар» (миграция 68, пакет v2 п.3).
 *
 * «1 шт «Батон 0,4 кг» у поставщика X = 0,4 кг». supplier_key '' — правило для
 * товара у любого поставщика; raw_unit '' — для любой единицы накладной.
 * Источник: user (ручное «запомнить»), miner/llm (принятое предложение из
 * ночного разбора), legacy (перенесено со старых упаковок).
 */
export interface ItemUnitRule {
  id: number;
  owner_user_id: number;
  supplier_key: string;
  name_key: string;
  raw_unit: string;
  target_unit: string;
  factor: number;
  source: string;
  note: string | null;
  active: number;
  times_used: number;
  last_used_at: string | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertItemUnitRule {
  supplierKey: string | null;
  nameKey: string;
  rawUnit: string | null;
  targetUnit: string;
  factor: number;
  source: 'user' | 'miner' | 'llm' | 'legacy';
  note?: string | null;
  createdBy?: number | null;
}

export const itemUnitRuleRepo = {
  /** Самое точное активное правило: поставщик+единица → поставщик → любая+единица → любое. */
  async find(ownerUserId: number, supplierKey: string | null, nameKey: string, rawUnit: string | null): Promise<ItemUnitRule | null> {
    if (!nameKey) return null;
    const sk = supplierKey ?? '';
    const ru = rawUnit ?? '';
    const row = await getDb().prepare(`
      SELECT * FROM item_unit_rules
       WHERE owner_user_id = ? AND name_key = ? AND active = 1
         AND supplier_key IN (?, '') AND raw_unit IN (?, '')
       ORDER BY (supplier_key = ?) DESC, (raw_unit = ?) DESC, updated_at DESC
       LIMIT 1
    `).get<ItemUnitRule>(ownerUserId, nameKey.slice(0, 191), sk, ru, sk, ru);
    return row ?? null;
  },

  async upsert(ownerUserId: number, r: UpsertItemUnitRule): Promise<void> {
    await getDb().prepare(`
      INSERT INTO item_unit_rules (owner_user_id, supplier_key, name_key, raw_unit, target_unit, factor, source, note, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE target_unit = VALUES(target_unit), factor = VALUES(factor),
        source = VALUES(source), note = VALUES(note), active = 1, updated_at = NOW()
    `).run(ownerUserId, (r.supplierKey ?? '').slice(0, 64), r.nameKey.slice(0, 191), (r.rawUnit ?? '').slice(0, 32),
      r.targetUnit.slice(0, 32), r.factor, r.source, r.note ?? null, r.createdBy ?? null);
  },

  async touch(id: number): Promise<void> {
    await getDb().prepare('UPDATE item_unit_rules SET times_used = times_used + 1, last_used_at = NOW() WHERE id = ?').run(id);
  },

  async list(ownerUserId: number): Promise<ItemUnitRule[]> {
    return getDb().prepare('SELECT * FROM item_unit_rules WHERE owner_user_id = ? ORDER BY updated_at DESC LIMIT 1000').all<ItemUnitRule>(ownerUserId);
  },

  async setActive(ownerUserId: number, id: number, active: boolean): Promise<void> {
    await getDb().prepare('UPDATE item_unit_rules SET active = ? WHERE id = ? AND owner_user_id = ?').run(active ? 1 : 0, id, ownerUserId);
  },
};
