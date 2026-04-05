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
}

export interface CreateMappingData {
  scanned_name: string;
  mapped_name_1c: string;
  category?: string;
  default_unit?: string;
  approved?: boolean;
  onec_guid?: string | null;
}

export const mappingRepo = {
  create(data: CreateMappingData): NomenclatureMapping {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO nomenclature_mappings (scanned_name, mapped_name_1c, category, default_unit, approved, onec_guid)
      VALUES (@scanned_name, @mapped_name_1c, @category, @default_unit, @approved, @onec_guid)
    `);
    const result = stmt.run({
      scanned_name: data.scanned_name,
      mapped_name_1c: data.mapped_name_1c,
      category: data.category ?? null,
      default_unit: data.default_unit ?? null,
      approved: data.approved ? 1 : 0,
      onec_guid: data.onec_guid ?? null,
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

  /**
   * Record that this mapping was used for an invoice from `supplier`.
   * Increments the mapping's times_seen, updates last_seen_supplier/at,
   * and upserts a row in mapping_supplier_usage.
   *
   * Called on every successful NomenclatureMapper.map() during invoice
   * processing, and on every explicit user mapping via the dashboard.
   *
   * Both writes are wrapped in a transaction so that a failure in the
   * supplier_usage upsert cannot leave the per-mapping counter advanced
   * without a corresponding per-supplier row.
   */
  recordUsage(mappingId: number, supplier: string | null | undefined): void {
    const db = getDb();
    db.transaction(() => {
      db.prepare(`
        UPDATE nomenclature_mappings
        SET times_seen = times_seen + 1,
            last_seen_supplier = COALESCE(?, last_seen_supplier),
            last_seen_at = datetime('now')
        WHERE id = ?
      `).run(supplier ?? null, mappingId);

      if (supplier) {
        db.prepare(`
          INSERT INTO mapping_supplier_usage (mapping_id, supplier, first_seen_at, last_seen_at, times_seen)
          VALUES (?, ?, datetime('now'), datetime('now'), 1)
          ON CONFLICT(mapping_id, supplier) DO UPDATE SET
            last_seen_at = datetime('now'),
            times_seen = times_seen + 1
        `).run(mappingId, supplier);
      }
    })();
  },

  /**
   * List mappings with optional filters:
   *   - supplier: only mappings linked to this supplier in mapping_supplier_usage
   *   - unmapped: only mappings where onec_guid IS NULL
   * Sorted by last_seen_at DESC (most-recently-seen first), falling back to mapped_name_1c.
   */
  getAllFiltered(opts: { supplier?: string; unmapped?: boolean } = {}): NomenclatureMapping[] {
    const db = getDb();
    const clauses: string[] = [];
    const params: unknown[] = [];
    let join = '';

    if (opts.supplier) {
      join = 'JOIN mapping_supplier_usage u ON u.mapping_id = m.id';
      clauses.push('u.supplier = ?');
      params.push(opts.supplier);
    }
    if (opts.unmapped) {
      clauses.push("(m.onec_guid IS NULL OR m.onec_guid = '')");
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    return db.prepare(
      `SELECT m.* FROM nomenclature_mappings m ${join} ${where}
       ORDER BY COALESCE(m.last_seen_at, '') DESC, m.mapped_name_1c COLLATE NOCASE`
    ).all(...params) as NomenclatureMapping[];
  },

  getSupplierList(): Array<{ supplier: string; mappings_count: number }> {
    const db = getDb();
    return db.prepare(`
      SELECT supplier, COUNT(DISTINCT mapping_id) as mappings_count
      FROM mapping_supplier_usage
      GROUP BY supplier
      ORDER BY mappings_count DESC, supplier
    `).all() as Array<{ supplier: string; mappings_count: number }>;
  },

  getUnmappedCount(): number {
    const db = getDb();
    const row = db.prepare(
      `SELECT COUNT(*) as c FROM nomenclature_mappings WHERE onec_guid IS NULL OR onec_guid = ''`
    ).get() as { c: number };
    return row.c;
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
