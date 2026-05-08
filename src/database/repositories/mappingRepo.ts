import { getDb } from '../db';

export interface NomenclatureMapping {
  id: number;
  scanned_name: string;
  mapped_name_1c: string;
  category: string | null;
  default_unit: string | null;
  approved: number;
  created_at: string;
  onec_guid: string | null;
  times_seen: number;
  last_seen_supplier: string | null;
  last_seen_at: string | null;
  // Pack conversion: when set, the watcher rewrites matching invoice items
  // as quantity *= pack_size, unit = pack_unit, price = total / new quantity.
  // Used for "Мука (50кг) — 1 шт" → "Мука — 50 кг" type transforms.
  pack_size: number | null;
  pack_unit: string | null;
}

export interface CreateMappingData {
  scanned_name: string;
  mapped_name_1c: string;
  category?: string;
  default_unit?: string;
  approved?: boolean;
  onec_guid?: string | null;
  pack_size?: number | null;
  pack_unit?: string | null;
}

export const mappingRepo = {
  async create(data: CreateMappingData): Promise<NomenclatureMapping> {
    const db = getDb();
    const result = await db.prepare(`
      INSERT INTO nomenclature_mappings (scanned_name, mapped_name_1c, category, default_unit, approved, onec_guid, pack_size, pack_unit)
      VALUES (:scanned_name, :mapped_name_1c, :category, :default_unit, :approved, :onec_guid, :pack_size, :pack_unit)
    `).run({
      scanned_name: data.scanned_name,
      mapped_name_1c: data.mapped_name_1c,
      category: data.category ?? null,
      default_unit: data.default_unit ?? null,
      approved: data.approved ? 1 : 0,
      onec_guid: data.onec_guid ?? null,
      pack_size: data.pack_size ?? null,
      pack_unit: data.pack_unit ?? null,
    });
    return (await db
      .prepare('SELECT * FROM nomenclature_mappings WHERE id = ?')
      .get<NomenclatureMapping>(Number(result.lastInsertRowid)))!;
  },

  async getById(id: number): Promise<NomenclatureMapping | undefined> {
    return getDb()
      .prepare('SELECT * FROM nomenclature_mappings WHERE id = ?')
      .get<NomenclatureMapping>(id);
  },

  async getByScannedName(scannedName: string): Promise<NomenclatureMapping | undefined> {
    return getDb()
      .prepare('SELECT * FROM nomenclature_mappings WHERE scanned_name = ?')
      .get<NomenclatureMapping>(scannedName);
  },

  async getAll(): Promise<NomenclatureMapping[]> {
    return getDb()
      .prepare('SELECT * FROM nomenclature_mappings ORDER BY mapped_name_1c')
      .all<NomenclatureMapping>();
  },

  async update(id: number, data: Partial<CreateMappingData>): Promise<void> {
    const fields: string[] = [];
    const values: Record<string, unknown> = { id };

    if (data.scanned_name !== undefined) { fields.push('scanned_name = :scanned_name'); values.scanned_name = data.scanned_name; }
    if (data.mapped_name_1c !== undefined) { fields.push('mapped_name_1c = :mapped_name_1c'); values.mapped_name_1c = data.mapped_name_1c; }
    if (data.category !== undefined) { fields.push('category = :category'); values.category = data.category; }
    if (data.default_unit !== undefined) { fields.push('default_unit = :default_unit'); values.default_unit = data.default_unit; }
    if (data.approved !== undefined) { fields.push('approved = :approved'); values.approved = data.approved ? 1 : 0; }
    if (data.onec_guid !== undefined) { fields.push('onec_guid = :onec_guid'); values.onec_guid = data.onec_guid; }
    if (data.pack_size !== undefined) { fields.push('pack_size = :pack_size'); values.pack_size = data.pack_size; }
    if (data.pack_unit !== undefined) { fields.push('pack_unit = :pack_unit'); values.pack_unit = data.pack_unit; }

    if (fields.length > 0) {
      await getDb()
        .prepare(`UPDATE nomenclature_mappings SET ${fields.join(', ')} WHERE id = :id`)
        .run(values);
    }
  },

  async delete(id: number): Promise<void> {
    await getDb().prepare('DELETE FROM nomenclature_mappings WHERE id = ?').run(id);
  },

  async upsert(data: CreateMappingData): Promise<NomenclatureMapping> {
    const existing = await this.getByScannedName(data.scanned_name);
    if (existing) {
      await this.update(existing.id, data);
      return (await this.getById(existing.id))!;
    }
    return this.create(data);
  },

  async getAllGrouped(): Promise<Array<{ onec_guid: string; mapped_name: string; variants: NomenclatureMapping[] }>> {
    const all = await getDb().prepare(
      `SELECT * FROM nomenclature_mappings
       WHERE onec_guid IS NOT NULL AND onec_guid != ''
       ORDER BY mapped_name_1c, scanned_name`
    ).all<NomenclatureMapping>();

    const groups = new Map<string, { onec_guid: string; mapped_name: string; variants: NomenclatureMapping[] }>();
    for (const m of all) {
      const key = m.onec_guid || m.mapped_name_1c;
      if (!groups.has(key)) {
        groups.set(key, { onec_guid: m.onec_guid || '', mapped_name: m.mapped_name_1c, variants: [] });
      }
      groups.get(key)!.variants.push(m);
    }
    return Array.from(groups.values());
  },

  async getUnmapped(): Promise<NomenclatureMapping[]> {
    return getDb().prepare(
      `SELECT * FROM nomenclature_mappings
       WHERE onec_guid IS NULL OR onec_guid = ''
       ORDER BY scanned_name`
    ).all<NomenclatureMapping>();
  },

  async importBulk(items: CreateMappingData[]): Promise<number> {
    if (items.length === 0) return 0;
    return getDb().transaction(async (txn) => {
      const stmt = txn.prepare(`
        REPLACE INTO nomenclature_mappings (scanned_name, mapped_name_1c, category, default_unit, approved, onec_guid, pack_size, pack_unit)
        VALUES (:scanned_name, :mapped_name_1c, :category, :default_unit, :approved, :onec_guid, :pack_size, :pack_unit)
      `);
      let count = 0;
      for (const item of items) {
        await stmt.run({
          scanned_name: item.scanned_name,
          mapped_name_1c: item.mapped_name_1c,
          category: item.category ?? null,
          default_unit: item.default_unit ?? null,
          approved: item.approved ? 1 : 0,
          onec_guid: item.onec_guid ?? null,
          pack_size: item.pack_size ?? null,
          pack_unit: item.pack_unit ?? null,
        });
        count++;
      }
      return count;
    });
  },

  /**
   * Удалить маппинги, чей onec_guid больше не существует в onec_nomenclature.
   * Вызывается после пересинхронизации справочника.
   */
  async removeOrphaned(): Promise<number> {
    const result = await getDb().prepare(
      `DELETE FROM nomenclature_mappings
       WHERE onec_guid IS NOT NULL AND onec_guid != ''
       AND onec_guid NOT IN (SELECT guid FROM onec_nomenclature)`
    ).run();
    return result.changes;
  },
};
