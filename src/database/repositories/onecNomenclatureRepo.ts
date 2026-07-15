import { DbAdapter, getDb } from '../db';

export interface OnecNomenclatureRow {
  guid: string;
  code: string | null;
  name: string;
  full_name: string | null;
  unit: string | null;
  parent_guid: string | null;
  is_folder: number;
  is_weighted: number;
  synced_at: string;
}

export interface OnecNomenclatureInput {
  guid: string;
  code?: string | null;
  name: string;
  full_name?: string | null;
  unit?: string | null;
  parent_guid?: string | null;
  is_folder?: boolean;
  is_weighted?: boolean;
}

async function upsertWith(db: DbAdapter, items: OnecNomenclatureInput[]): Promise<number> {
  const stmt = db.prepare(`
    INSERT INTO onec_nomenclature
      (guid, code, name, full_name, unit, parent_guid, is_folder, is_weighted, synced_at)
    VALUES
      (:guid, :code, :name, :full_name, :unit, :parent_guid, :is_folder, :is_weighted, NOW())
    ON DUPLICATE KEY UPDATE
      code        = VALUES(code),
      name        = VALUES(name),
      full_name   = VALUES(full_name),
      unit        = VALUES(unit),
      parent_guid = VALUES(parent_guid),
      is_folder   = VALUES(is_folder),
      is_weighted = VALUES(is_weighted),
      synced_at   = VALUES(synced_at)
  `);
  let count = 0;
  for (const item of items) {
    await stmt.run({
      guid: item.guid,
      code: item.code ?? null,
      name: item.name,
      full_name: item.full_name ?? null,
      unit: item.unit ?? null,
      parent_guid: item.parent_guid ?? null,
      is_folder: item.is_folder ? 1 : 0,
      is_weighted: item.is_weighted ? 1 : 0,
    });
    count++;
  }
  return count;
}

export const onecNomenclatureRepo = {
  /**
   * Upsert a batch of items. Existing rows are updated by guid; new rows inserted.
   * Wrapped in a transaction for atomicity. Returns the count of rows processed.
   */
  async bulkUpsert(items: OnecNomenclatureInput[]): Promise<number> {
    if (items.length === 0) return 0;
    const db = getDb();
    return db.transaction(txn => upsertWith(txn, items));
  },

  /** Replace the complete catalog atomically after an uploaded file was parsed. */
  async replaceAll(items: OnecNomenclatureInput[]): Promise<{ deleted: number; upserted: number }> {
    if (items.length === 0) return { deleted: 0, upserted: 0 };
    return getDb().transaction(async txn => {
      const deleted = (await txn.prepare('DELETE FROM onec_nomenclature').run()).changes;
      const upserted = await upsertWith(txn, items);
      return { deleted, upserted };
    });
  },

  /**
   * Delete all catalog rows. Used before a full re-sync from 1C when the query
   * that sources the sync changes shape (e.g. "all nomenclature" → "only items
   * that appear in recent purchase documents"), and we need to evict stale rows
   * that would otherwise remain and pollute mapping suggestions.
   *
   * Dangling onec_guid references in nomenclature_mappings are tolerated: the
   * mapper's dead-GUID fallthrough sends those lookups back to fuzzy search
   * against the newly-rebuilt catalog.
   */
  async clearAll(): Promise<number> {
    const result = await getDb().prepare('DELETE FROM onec_nomenclature').run();
    return result.changes;
  },

  async getByGuid(guid: string): Promise<OnecNomenclatureRow | undefined> {
    return getDb()
      .prepare('SELECT * FROM onec_nomenclature WHERE guid = ?')
      .get<OnecNomenclatureRow>(guid);
  },

  async listItems(opts: { excludeFolders?: boolean; search?: string; limit?: number } = {}): Promise<OnecNomenclatureRow[]> {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (opts.excludeFolders) {
      clauses.push('is_folder = 0');
    }
    if (opts.search) {
      // utf8mb4_unicode_ci collation makes LIKE case-insensitive for Cyrillic
      // and any other Unicode script — no custom ulower() needed.
      clauses.push('(name LIKE :search OR full_name LIKE :search)');
      params.search = `%${opts.search}%`;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    // LIMIT is inlined (mysql2 rejects placeholder ints in LIMIT), so coerce to a
    // clamped integer — keeps the inlining injection-safe even if a caller passes
    // a non-numeric value. Current callers pass parseInt() results, so no-op for them.
    const lim = opts.limit != null ? Math.max(0, Math.trunc(Number(opts.limit))) : 0;
    const limit = lim > 0 ? `LIMIT ${lim}` : '';
    return getDb()
      .prepare(`SELECT * FROM onec_nomenclature ${where} ORDER BY name ${limit}`)
      .all<OnecNomenclatureRow>(params);
  },

  async stats(): Promise<{ total: number; folders: number; items: number; last_synced_at: string | null }> {
    const db = getDb();
    const totalRow = await db.prepare('SELECT COUNT(*) as c FROM onec_nomenclature').get<{ c: number }>();
    const foldersRow = await db.prepare('SELECT COUNT(*) as c FROM onec_nomenclature WHERE is_folder = 1').get<{ c: number }>();
    const lastRow = await db.prepare('SELECT MAX(synced_at) as ts FROM onec_nomenclature').get<{ ts: string | null }>();
    const total = totalRow?.c ?? 0;
    const folders = foldersRow?.c ?? 0;
    return { total, folders, items: total - folders, last_synced_at: lastRow?.ts ?? null };
  },
};
