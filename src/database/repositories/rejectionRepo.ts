import { getDb } from '../db';

/**
 * «Не это» (миграция 69, пакет v2 п.11): позиции 1С, которые человек
 * отклонил для товара (замена или очистка сопоставления). Подбор больше не
 * предлагает их для этого товара — ни fuzzy, ни ИИ.
 */
export interface MappingRejection {
  id: number;
  owner_user_id: number;
  name_key: string;
  onec_guid: string;
  scanned_name: string | null;
  created_by: number | null;
  created_at: string;
}

export const rejectionRepo = {
  async add(ownerUserId: number, nameKey: string, onecGuid: string, scannedName: string | null, userId: number | null): Promise<void> {
    if (!nameKey || !onecGuid) return;
    await getDb().prepare(`
      INSERT IGNORE INTO mapping_rejections (owner_user_id, name_key, onec_guid, scanned_name, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(ownerUserId, nameKey.slice(0, 191), onecGuid.slice(0, 64), scannedName ? scannedName.slice(0, 512) : null, userId);
  },

  /** Если человек сам выбрал ранее отклонённую позицию — отклонение снимается. */
  async clear(ownerUserId: number, nameKey: string, onecGuid: string): Promise<void> {
    await getDb().prepare('DELETE FROM mapping_rejections WHERE owner_user_id = ? AND name_key = ? AND onec_guid = ?')
      .run(ownerUserId, nameKey.slice(0, 191), onecGuid);
  },

  async guidsFor(ownerUserId: number, nameKey: string): Promise<Set<string>> {
    if (!nameKey || ownerUserId <= 0) return new Set();
    try {
      const rows = await getDb().prepare('SELECT onec_guid FROM mapping_rejections WHERE owner_user_id = ? AND name_key = ?')
        .all<{ onec_guid: string }>(ownerUserId, nameKey.slice(0, 191));
      return new Set(rows.map(r => r.onec_guid));
    } catch {
      return new Set(); // до миграции 69 — отклонений нет
    }
  },

  async list(ownerUserId: number): Promise<MappingRejection[]> {
    return getDb().prepare('SELECT * FROM mapping_rejections WHERE owner_user_id = ? ORDER BY id DESC LIMIT 500')
      .all<MappingRejection>(ownerUserId);
  },

  async remove(ownerUserId: number, id: number): Promise<void> {
    await getDb().prepare('DELETE FROM mapping_rejections WHERE id = ? AND owner_user_id = ?').run(id, ownerUserId);
  },
};
