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
  create(data: CreateMappingData): NomenclatureMapping {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO nomenclature_mappings (scanned_name, mapped_name_1c, category, default_unit, approved, onec_guid, pack_size, pack_unit)
      VALUES (@scanned_name, @mapped_name_1c, @category, @default_unit, @approved, @onec_guid, @pack_size, @pack_unit)
    `);
    const result = stmt.run({
      scanned_name: data.scanned_name,
      mapped_name_1c: data.mapped_name_1c,
      category: data.category ?? null,
      default_unit: data.default_unit ?? null,
      approved: data.approved ? 1 : 0,
      onec_guid: data.onec_guid ?? null,
      pack_size: data.pack_size ?? null,
      pack_unit: data.pack_unit ?? null,
    });
    return db.prepare('SELECT * FROM nomenclature_mappings WHERE id = ?')
      .get(Number(result.lastInsertRowid)) as NomenclatureMapping;
  },

  getById(id: number): NomenclatureMapping | undefined {
    const db = getDb();
    return db.prepare('SELECT * FROM nomenclature_mappings WHERE id = ?').get(id) as NomenclatureMapping | undefined;
  },

  getByScannedName(scannedName: string): NomenclatureMapping | undefined {
    const db = getDb();
    return db.prepare('SELECT * FROM nomenclature_mappings WHERE scanned_name = ?')
      .get(scannedName) as NomenclatureMapping | undefined;
  },

  getAll(): NomenclatureMapping[] {
    const db = getDb();
    return db.prepare('SELECT * FROM nomenclature_mappings ORDER BY mapped_name_1c').all() as NomenclatureMapping[];
  },

  update(id: number, data: Partial<CreateMappingData>): void {
    const db = getDb();
    const fields: string[] = [];
    const values: Record<string, unknown> = { id };

    if (data.scanned_name !== undefined) { fields.push('scanned_name = @scanned_name'); values.scanned_name = data.scanned_name; }
    if (data.mapped_name_1c !== undefined) { fields.push('mapped_name_1c = @mapped_name_1c'); values.mapped_name_1c = data.mapped_name_1c; }
    if (data.category !== undefined) { fields.push('category = @category'); values.category = data.category; }
    if (data.default_unit !== undefined) { fields.push('default_unit = @default_unit'); values.default_unit = data.default_unit; }
    if (data.approved !== undefined) { fields.push('approved = @approved'); values.approved = data.approved ? 1 : 0; }
    if (data.onec_guid !== undefined) { fields.push('onec_guid = @onec_guid'); values.onec_guid = data.onec_guid; }
    if (data.pack_size !== undefined) { fields.push('pack_size = @pack_size'); values.pack_size = data.pack_size; }
    if (data.pack_unit !== undefined) { fields.push('pack_unit = @pack_unit'); values.pack_unit = data.pack_unit; }

    if (fields.length > 0) {
      db.prepare(`UPDATE nomenclature_mappings SET ${fields.join(', ')} WHERE id = @id`).run(values);
    }
  },

  delete(id: number): void {
    const db = getDb();
    db.prepare('DELETE FROM nomenclature_mappings WHERE id = ?').run(id);
  },

  upsert(data: CreateMappingData): NomenclatureMapping {
    const existing = this.getByScannedName(data.scanned_name);
    if (existing) {
      this.update(existing.id, data);
      return this.getById(existing.id)!;
    }
    return this.create(data);
  },

  getAllGrouped(): Array<{ onec_guid: string; mapped_name: string; variants: NomenclatureMapping[] }> {
    const db = getDb();
    const all = db.prepare(
      `SELECT * FROM nomenclature_mappings
       WHERE onec_guid IS NOT NULL AND onec_guid != ''
       ORDER BY mapped_name_1c, scanned_name`
    ).all() as NomenclatureMapping[];

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

  getUnmapped(): NomenclatureMapping[] {
    const db = getDb();
    return db.prepare(
      `SELECT * FROM nomenclature_mappings
       WHERE onec_guid IS NULL OR onec_guid = ''
       ORDER BY scanned_name`
    ).all() as NomenclatureMapping[];
  },

  importBulk(items: CreateMappingData[]): number {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO nomenclature_mappings (scanned_name, mapped_name_1c, category, default_unit, approved, onec_guid, pack_size, pack_unit)
      VALUES (@scanned_name, @mapped_name_1c, @category, @default_unit, @approved, @onec_guid, @pack_size, @pack_unit)
    `);

    const transaction = db.transaction((items: CreateMappingData[]) => {
      let count = 0;
      for (const item of items) {
        stmt.run({
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

    return transaction(items);
  },

  /**
   * Удалить маппинги, чей onec_guid больше не существует в onec_nomenclature.
   * Вызывается после пересинхронизации справочника.
   */
  removeOrphaned(): number {
    const db = getDb();
    const result = db.prepare(
      `DELETE FROM nomenclature_mappings
       WHERE onec_guid IS NOT NULL AND onec_guid != ''
       AND onec_guid NOT IN (SELECT guid FROM onec_nomenclature)`
    ).run();
    return result.changes;
  },
};
