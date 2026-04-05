import { getDb } from '../db';

export interface OnecNomenclatureRow {
  guid: string;
  code: string | null;
  name: string;
  full_name: string | null;
  unit: string | null;
  parent_guid: string | null;
  is_folder: number; // sqlite stores bools as 0/1
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

export const onecNomenclatureRepo = {
  /**
   * Upsert a batch of items. Existing rows are updated by guid; new rows inserted.
   * Wrapped in a transaction for atomicity. Returns the count of rows processed.
   */
  bulkUpsert(items: OnecNomenclatureInput[]): number {
    if (items.length === 0) return 0;
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO onec_nomenclature
        (guid, code, name, full_name, unit, parent_guid, is_folder, is_weighted, synced_at)
      VALUES
        (@guid, @code, @name, @full_name, @unit, @parent_guid, @is_folder, @is_weighted, datetime('now'))
      ON CONFLICT(guid) DO UPDATE SET
        code        = excluded.code,
        name        = excluded.name,
        full_name   = excluded.full_name,
        unit        = excluded.unit,
        parent_guid = excluded.parent_guid,
        is_folder   = excluded.is_folder,
        is_weighted = excluded.is_weighted,
        synced_at   = excluded.synced_at
    `);
    const tx = db.transaction((rows: OnecNomenclatureInput[]) => {
      let count = 0;
      for (const item of rows) {
        stmt.run({
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
    });
    return tx(items);
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
  clearAll(): number {
    const db = getDb();
    const result = db.prepare('DELETE FROM onec_nomenclature').run();
    return result.changes;
  },

  getByGuid(guid: string): OnecNomenclatureRow | undefined {
    const db = getDb();
    return db.prepare('SELECT * FROM onec_nomenclature WHERE guid = ?')
      .get(guid) as OnecNomenclatureRow | undefined;
  },

  listItems(opts: { excludeFolders?: boolean; search?: string; limit?: number } = {}): OnecNomenclatureRow[] {
    const db = getDb();
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (opts.excludeFolders) {
      clauses.push('is_folder = 0');
    }
    if (opts.search) {
      // ulower() is a custom JS-backed Unicode-aware LOWER registered in db.ts.
      // Required because SQLite's built-in LOWER() and LIKE's case-insensitive
      // mode are ASCII-only — Cyrillic "Картоф" wouldn't match a lowercase
      // search term otherwise.
      clauses.push('(ulower(name) LIKE ulower(@search) OR ulower(full_name) LIKE ulower(@search))');
      params.search = `%${opts.search}%`;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = opts.limit ? `LIMIT ${opts.limit}` : '';
    return db.prepare(
      `SELECT * FROM onec_nomenclature ${where} ORDER BY name COLLATE NOCASE ${limit}`
    ).all(params) as OnecNomenclatureRow[];
  },

  stats(): { total: number; folders: number; items: number; last_synced_at: string | null } {
    const db = getDb();
    const total = (db.prepare('SELECT COUNT(*) as c FROM onec_nomenclature').get() as { c: number }).c;
    const folders = (db.prepare('SELECT COUNT(*) as c FROM onec_nomenclature WHERE is_folder = 1').get() as { c: number }).c;
    const items = total - folders;
    const lastRow = db.prepare('SELECT MAX(synced_at) as ts FROM onec_nomenclature').get() as { ts: string | null };
    return { total, folders, items, last_synced_at: lastRow.ts };
  },
};
