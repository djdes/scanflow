import { getDb } from '../db';

export interface NomenclatureSyncState {
  requested: boolean;
  /** Raw DB DATETIME string (dateStrings: true), round-tripped verbatim. */
  since: string | null;
}

interface StateRow {
  nomenclature_sync_requested_at: string | null;
}

export const syncStateRepo = {
  /**
   * Set/refresh the flag to NOW(). Upsert so it works even if the singleton
   * row was wiped (e.g. test TRUNCATE).
   */
  async markNomenclatureSyncRequested(): Promise<void> {
    await getDb().prepare(`
      INSERT INTO integration_sync_state (id, nomenclature_sync_requested_at)
      VALUES (1, NOW())
      ON DUPLICATE KEY UPDATE nomenclature_sync_requested_at = NOW()
    `).run();
  },

  async getNomenclatureSyncState(): Promise<NomenclatureSyncState> {
    const row = await getDb()
      .prepare('SELECT nomenclature_sync_requested_at FROM integration_sync_state WHERE id = 1')
      .get<StateRow>();
    const since = row?.nomenclature_sync_requested_at ?? null;
    return { requested: since != null, since };
  },

  /** Clear only if no newer request arrived since `since` (race guard). */
  async clearNomenclatureSync(since: string): Promise<{ cleared: boolean }> {
    const res = await getDb().prepare(`
      UPDATE integration_sync_state
         SET nomenclature_sync_requested_at = NULL
       WHERE id = 1 AND nomenclature_sync_requested_at <= ?
    `).run(since);
    return { cleared: res.changes > 0 };
  },
};
