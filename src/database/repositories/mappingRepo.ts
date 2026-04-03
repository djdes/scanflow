import { getDb } from '../db';

export interface NomenclatureMapping {
  id: number;
  scanned_name: string;
  mapped_name_1c: string;
  category: string | null;
  default_unit: string | null;
  approved: number;
  created_at: string;
}

export interface CreateMappingData {
  scanned_name: string;
  mapped_name_1c: string;
  category?: string;
  default_unit?: string;
  approved?: boolean;
}

export const mappingRepo = {
  create(data: CreateMappingData): NomenclatureMapping {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO nomenclature_mappings (scanned_name, mapped_name_1c, category, default_unit, approved)
      VALUES (@scanned_name, @mapped_name_1c, @category, @default_unit, @approved)
    `);
    const result = stmt.run({
      scanned_name: data.scanned_name,
      mapped_name_1c: data.mapped_name_1c,
      category: data.category ?? null,
      default_unit: data.default_unit ?? null,
      approved: data.approved ? 1 : 0,
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

  importBulk(items: CreateMappingData[]): number {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO nomenclature_mappings (scanned_name, mapped_name_1c, category, default_unit, approved)
      VALUES (@scanned_name, @mapped_name_1c, @category, @default_unit, @approved)
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
        });
        count++;
      }
      return count;
    });

    return transaction(items);
  },
};
