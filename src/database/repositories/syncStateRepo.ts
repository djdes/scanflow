import { getDb } from '../db';

export interface NomenclatureSyncState {
  requested: boolean;
  /** Raw DB DATETIME string (dateStrings: true), round-tripped verbatim. */
  since: string | null;
}

interface StateRow {
  nomenclature_sync_requested_at: string | null;
}

/**
 * Флаг «в каталоге появились новые позиции — 1С должна забрать его заново».
 * Пер-тенантный: хранится в integration_sync_state_cards, по строке на компанию.
 *
 * Владелец — обязательный параметр каждого метода, без значения по умолчанию.
 * Это единственное, что превращает забытого вызывающего из «одна компания
 * подняла выгрузку в базе 1С другой» в ошибку компиляции.
 */
export const syncStateRepo = {
  /**
   * Set/refresh the flag to NOW() for this company. Upsert so it works even if
   * the company has no row yet (первый вызов) или строку вычистил TRUNCATE.
   */
  async markNomenclatureSyncRequested(ownerUserId: number): Promise<void> {
    await getDb().prepare(`
      INSERT INTO integration_sync_state_cards (owner_user_id, nomenclature_sync_requested_at)
      VALUES (?, NOW())
      ON DUPLICATE KEY UPDATE nomenclature_sync_requested_at = NOW()
    `).run(ownerUserId);
  },

  async getNomenclatureSyncState(ownerUserId: number): Promise<NomenclatureSyncState> {
    const row = await getDb()
      .prepare(
        'SELECT nomenclature_sync_requested_at FROM integration_sync_state_cards WHERE owner_user_id = ?'
      )
      .get<StateRow>(ownerUserId);
    const since = row?.nomenclature_sync_requested_at ?? null;
    return { requested: since != null, since };
  },

  /** Clear only if no newer request arrived since `since` (race guard). */
  async clearNomenclatureSync(since: string, ownerUserId: number): Promise<{ cleared: boolean }> {
    const res = await getDb().prepare(`
      UPDATE integration_sync_state_cards
         SET nomenclature_sync_requested_at = NULL
       WHERE owner_user_id = ? AND nomenclature_sync_requested_at <= ?
    `).run(ownerUserId, since);
    return { cleared: res.changes > 0 };
  },
};
