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
  /** Компания-владелец каталога. У каждой компании свой каталог из своей 1С. */
  owner_user_id?: number;
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

async function upsertWith(
  db: DbAdapter,
  items: OnecNomenclatureInput[],
  ownerUserId: number,
): Promise<number> {
  const stmt = db.prepare(`
    INSERT INTO onec_nomenclature_cards
      (owner_user_id, guid, code, name, full_name, unit, parent_guid, is_folder, is_weighted, synced_at)
    VALUES
      (:owner_user_id, :guid, :code, :name, :full_name, :unit, :parent_guid, :is_folder, :is_weighted, NOW())
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
      owner_user_id: ownerUserId,
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

// Владелец — обязательный параметр каждого метода, без значения по умолчанию.
// Это единственное, что превращает забытый вызывающий из тихой межтенантной
// утечки в ошибку компиляции.
export const onecNomenclatureRepo = {
  /**
   * Upsert a batch of items. Existing rows are updated by (owner, guid); new rows inserted.
   * Wrapped in a transaction for atomicity. Returns the count of rows processed.
   */
  async bulkUpsert(items: OnecNomenclatureInput[], ownerUserId: number): Promise<number> {
    if (items.length === 0) return 0;
    const db = getDb();
    return db.transaction(txn => upsertWith(txn, items, ownerUserId));
  },

  /** Replace the complete catalog atomically after an uploaded file was parsed. */
  async replaceAll(
    items: OnecNomenclatureInput[],
    ownerUserId: number,
  ): Promise<{ deleted: number; upserted: number }> {
    if (items.length === 0) return { deleted: 0, upserted: 0 };
    return getDb().transaction(async txn => {
      // DELETE строго по владельцу. Без этого выгрузка каталога одной компании
      // стирала бы каталоги всех остальных.
      const deleted = (await txn
        .prepare('DELETE FROM onec_nomenclature_cards WHERE owner_user_id = ?')
        .run(ownerUserId)).changes;
      const upserted = await upsertWith(txn, items, ownerUserId);
      return { deleted, upserted };
    });
  },

  /**
   * Delete all catalog rows OF ONE COMPANY. Used before a full re-sync from 1C
   * when the query that sources the sync changes shape (e.g. "all nomenclature"
   * → "only items that appear in recent purchase documents"), and we need to
   * evict stale rows that would otherwise remain and pollute mapping suggestions.
   *
   * Dangling onec_guid references in the mapping cards are tolerated: the
   * mapper's dead-GUID fallthrough sends those lookups back to fuzzy search
   * against the newly-rebuilt catalog.
   */
  async clearAll(ownerUserId: number): Promise<number> {
    const result = await getDb()
      .prepare('DELETE FROM onec_nomenclature_cards WHERE owner_user_id = ?')
      .run(ownerUserId);
    return result.changes;
  },

  async getByGuid(guid: string, ownerUserId: number): Promise<OnecNomenclatureRow | undefined> {
    return getDb()
      .prepare('SELECT * FROM onec_nomenclature_cards WHERE guid = ? AND owner_user_id = ?')
      .get<OnecNomenclatureRow>(guid, ownerUserId);
  },

  async listItems(
    opts: { ownerUserId: number; excludeFolders?: boolean; search?: string; limit?: number },
  ): Promise<OnecNomenclatureRow[]> {
    const clauses: string[] = ['owner_user_id = :ownerUserId'];
    const params: Record<string, unknown> = { ownerUserId: opts.ownerUserId };
    if (opts.excludeFolders) {
      clauses.push('is_folder = 0');
    }
    if (opts.search) {
      // utf8mb4_unicode_ci collation makes LIKE case-insensitive for Cyrillic
      // and any other Unicode script — no custom ulower() needed.
      clauses.push('(name LIKE :search OR full_name LIKE :search)');
      params.search = `%${opts.search}%`;
    }
    const where = `WHERE ${clauses.join(' AND ')}`;
    // LIMIT is inlined (mysql2 rejects placeholder ints in LIMIT), so coerce to a
    // clamped integer — keeps the inlining injection-safe even if a caller passes
    // a non-numeric value. Current callers pass parseInt() results, so no-op for them.
    const lim = opts.limit != null ? Math.max(0, Math.trunc(Number(opts.limit))) : 0;
    const limit = lim > 0 ? `LIMIT ${lim}` : '';
    return getDb()
      .prepare(`SELECT * FROM onec_nomenclature_cards ${where} ORDER BY name ${limit}`)
      .all<OnecNomenclatureRow>(params);
  },

  async stats(ownerUserId: number): Promise<{ total: number; folders: number; items: number; last_synced_at: string | null }> {
    const db = getDb();
    const totalRow = await db
      .prepare('SELECT COUNT(*) as c FROM onec_nomenclature_cards WHERE owner_user_id = ?')
      .get<{ c: number }>(ownerUserId);
    const foldersRow = await db
      .prepare('SELECT COUNT(*) as c FROM onec_nomenclature_cards WHERE owner_user_id = ? AND is_folder = 1')
      .get<{ c: number }>(ownerUserId);
    const lastRow = await db
      .prepare('SELECT MAX(synced_at) as ts FROM onec_nomenclature_cards WHERE owner_user_id = ?')
      .get<{ ts: string | null }>(ownerUserId);
    const total = totalRow?.c ?? 0;
    const folders = foldersRow?.c ?? 0;
    return { total, folders, items: total - folders, last_synced_at: lastRow?.ts ?? null };
  },
};
