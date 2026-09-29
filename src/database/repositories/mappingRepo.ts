import { getDb } from '../db';
import { itemNameKey } from '../../mapping/nameKey';

export interface NomenclatureMapping {
  id: number;
  /** Компания-владелец сопоставления: у каждой компании свой каталог 1С, значит и свои связи. */
  owner_user_id?: number;
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
  // Пакет v2 (миграция 65): откуда правило и подтверждено ли человеком.
  source?: string | null;
  confirmed_at?: string | null;
  confirmed_by?: number | null;
  name_key?: string | null;
  orphaned_at?: string | null;
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
  /** user | supplier | import | llm | fuzzy | restored | history | learned */
  source?: string | null;
}

// Владелец — обязательный параметр каждого метода, без значения по умолчанию.
// Это единственное, что превращает забытый вызывающий из тихой межтенантной
// утечки в ошибку компиляции.
export const mappingRepo = {
  async create(data: CreateMappingData, ownerUserId: number): Promise<NomenclatureMapping> {
    const db = getDb();
    const result = await db.prepare(`
      INSERT INTO nomenclature_mapping_cards (owner_user_id, scanned_name, mapped_name_1c, category, default_unit, approved, onec_guid, pack_size, pack_unit, source, name_key)
      VALUES (:owner_user_id, :scanned_name, :mapped_name_1c, :category, :default_unit, :approved, :onec_guid, :pack_size, :pack_unit, :source, :name_key)
    `).run({
      owner_user_id: ownerUserId,
      scanned_name: data.scanned_name,
      mapped_name_1c: data.mapped_name_1c,
      category: data.category ?? null,
      default_unit: data.default_unit ?? null,
      approved: data.approved ? 1 : 0,
      onec_guid: data.onec_guid ?? null,
      pack_size: data.pack_size ?? null,
      pack_unit: data.pack_unit ?? null,
      source: data.source ?? 'learned',
      name_key: itemNameKey(data.scanned_name).slice(0, 255),
    });
    return (await db
      .prepare('SELECT * FROM nomenclature_mapping_cards WHERE id = ?')
      .get<NomenclatureMapping>(Number(result.lastInsertRowid)))!;
  },

  async getById(id: number, ownerUserId: number): Promise<NomenclatureMapping | undefined> {
    return getDb()
      .prepare('SELECT * FROM nomenclature_mapping_cards WHERE id = ? AND owner_user_id = ?')
      .get<NomenclatureMapping>(id, ownerUserId);
  },

  async getByScannedName(scannedName: string, ownerUserId: number): Promise<NomenclatureMapping | undefined> {
    return getDb()
      .prepare('SELECT * FROM nomenclature_mapping_cards WHERE scanned_name = ? AND owner_user_id = ?')
      .get<NomenclatureMapping>(scannedName, ownerUserId);
  },

  /**
   * Правило по ключу товара (все написания одного товара). Подтверждённые —
   * первыми; сопоставления позиций, которых нет в каталоге (orphaned), — мимо.
   */
  async getByNameKey(nameKey: string, ownerUserId: number): Promise<NomenclatureMapping | undefined> {
    if (!nameKey) return undefined;
    return getDb().prepare(`
      SELECT * FROM nomenclature_mapping_cards
       WHERE owner_user_id = ? AND name_key = ? AND orphaned_at IS NULL
         AND onec_guid IS NOT NULL AND onec_guid != ''
       ORDER BY (confirmed_at IS NOT NULL) DESC, times_seen DESC, id DESC
       LIMIT 1
    `).get<NomenclatureMapping>(ownerUserId, nameKey.slice(0, 255));
  },

  /** Подтверждённое человеком правило для названия (точное имя, затем ключ товара). */
  async getConfirmed(scannedName: string, ownerUserId: number): Promise<NomenclatureMapping | undefined> {
    const exact = await this.getByScannedName(scannedName, ownerUserId);
    if (exact?.confirmed_at && exact.onec_guid && !exact.orphaned_at) return exact;
    const byKey = await this.getByNameKey(itemNameKey(scannedName), ownerUserId);
    return byKey?.confirmed_at ? byKey : undefined;
  },

  /**
   * Запомнить выученное автоматически (ИИ, fuzzy) — НО не трогать правило,
   * подтверждённое человеком. До v2 выбор ИИ перезаписывал любое правило.
   */
  async upsertLearned(data: CreateMappingData & { source: string }, ownerUserId: number): Promise<void> {
    const existing = await this.getByScannedName(data.scanned_name, ownerUserId);
    if (existing?.confirmed_at) return;
    if (existing) {
      await this.update(existing.id, ownerUserId, {
        mapped_name_1c: data.mapped_name_1c, onec_guid: data.onec_guid ?? null, source: data.source,
      });
      return;
    }
    await this.create({ ...data, approved: false }, ownerUserId);
  },

  /** Человек выбрал/подтвердил позицию: правило становится подтверждённым. */
  async confirm(scannedName: string, onecGuid: string, mappedName: string, ownerUserId: number, userId: number | null): Promise<void> {
    const existing = await this.getByScannedName(scannedName, ownerUserId);
    const id = existing
      ? existing.id
      : (await this.create({ scanned_name: scannedName, mapped_name_1c: mappedName, onec_guid: onecGuid, approved: true, source: 'user' }, ownerUserId)).id;
    await getDb().prepare(`
      UPDATE nomenclature_mapping_cards
         SET onec_guid = ?, mapped_name_1c = ?, approved = 1, source = 'user',
             confirmed_at = NOW(), confirmed_by = ?, orphaned_at = NULL
       WHERE id = ? AND owner_user_id = ?
    `).run(onecGuid, mappedName, userId, id, ownerUserId);
  },

  /** Живые счётчики использования (до v2 times_seen никто не увеличивал). */
  async touchUsage(id: number, supplier: string | null): Promise<void> {
    await getDb().prepare(
      'UPDATE nomenclature_mapping_cards SET times_seen = times_seen + 1, last_seen_at = NOW(), last_seen_supplier = COALESCE(?, last_seen_supplier) WHERE id = ?',
    ).run(supplier ? supplier.slice(0, 512) : null, id);
  },

  async getAll(ownerUserId: number): Promise<NomenclatureMapping[]> {
    return getDb()
      .prepare('SELECT * FROM nomenclature_mapping_cards WHERE owner_user_id = ? ORDER BY mapped_name_1c')
      .all<NomenclatureMapping>(ownerUserId);
  },

  async update(id: number, ownerUserId: number, data: Partial<CreateMappingData>): Promise<void> {
    const fields: string[] = [];
    const values: Record<string, unknown> = { id, ownerUserId };

    if (data.scanned_name !== undefined) {
      fields.push('scanned_name = :scanned_name', 'name_key = :name_key');
      values.scanned_name = data.scanned_name;
      values.name_key = itemNameKey(data.scanned_name).slice(0, 255);
    }
    if (data.source !== undefined) { fields.push('source = :source'); values.source = data.source; }
    if (data.mapped_name_1c !== undefined) { fields.push('mapped_name_1c = :mapped_name_1c'); values.mapped_name_1c = data.mapped_name_1c; }
    if (data.category !== undefined) { fields.push('category = :category'); values.category = data.category; }
    if (data.default_unit !== undefined) { fields.push('default_unit = :default_unit'); values.default_unit = data.default_unit; }
    if (data.approved !== undefined) { fields.push('approved = :approved'); values.approved = data.approved ? 1 : 0; }
    if (data.onec_guid !== undefined) { fields.push('onec_guid = :onec_guid'); values.onec_guid = data.onec_guid; }
    if (data.pack_size !== undefined) { fields.push('pack_size = :pack_size'); values.pack_size = data.pack_size; }
    if (data.pack_unit !== undefined) { fields.push('pack_unit = :pack_unit'); values.pack_unit = data.pack_unit; }

    if (fields.length > 0) {
      await getDb()
        .prepare(`UPDATE nomenclature_mapping_cards SET ${fields.join(', ')} WHERE id = :id AND owner_user_id = :ownerUserId`)
        .run(values);
    }
  },

  async delete(id: number, ownerUserId: number): Promise<void> {
    await getDb()
      .prepare('DELETE FROM nomenclature_mapping_cards WHERE id = ? AND owner_user_id = ?')
      .run(id, ownerUserId);
  },

  async upsert(data: CreateMappingData, ownerUserId: number): Promise<NomenclatureMapping> {
    const existing = await this.getByScannedName(data.scanned_name, ownerUserId);
    if (existing) {
      await this.update(existing.id, ownerUserId, data);
      return (await this.getById(existing.id, ownerUserId))!;
    }
    return this.create(data, ownerUserId);
  },

  async getAllGrouped(ownerUserId: number): Promise<Array<{ onec_guid: string; mapped_name: string; variants: NomenclatureMapping[] }>> {
    const all = await getDb().prepare(
      `SELECT * FROM nomenclature_mapping_cards
       WHERE owner_user_id = ? AND onec_guid IS NOT NULL AND onec_guid != ''
       ORDER BY mapped_name_1c, scanned_name`
    ).all<NomenclatureMapping>(ownerUserId);

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

  async getUnmapped(ownerUserId: number): Promise<NomenclatureMapping[]> {
    return getDb().prepare(
      `SELECT * FROM nomenclature_mapping_cards
       WHERE owner_user_id = ? AND (onec_guid IS NULL OR onec_guid = '')
       ORDER BY scanned_name`
    ).all<NomenclatureMapping>(ownerUserId);
  },

  async importBulk(items: CreateMappingData[], ownerUserId: number): Promise<number> {
    if (items.length === 0) return 0;
    return getDb().transaction(async (txn) => {
      const stmt = txn.prepare(`
        REPLACE INTO nomenclature_mapping_cards (owner_user_id, scanned_name, mapped_name_1c, category, default_unit, approved, onec_guid, pack_size, pack_unit)
        VALUES (:owner_user_id, :scanned_name, :mapped_name_1c, :category, :default_unit, :approved, :onec_guid, :pack_size, :pack_unit)
      `);
      let count = 0;
      for (const item of items) {
        await stmt.run({
          owner_user_id: ownerUserId,
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
   * Удалить сопоставления, чей onec_guid больше не существует в каталоге.
   * Вызывается после пересинхронизации справочника.
   *
   * Сверка идёт с каталогом ТОЙ ЖЕ компании: по чужому каталогу вычистились бы
   * все сопоставления подряд — там этих guid просто нет.
   */
  /**
   * Пометить (не удалять!) сопоставления, чьей позиции больше нет в каталоге
   * компании, и снять пометку с вернувшихся. Вызывается после того, как
   * выгрузка каталога из 1С закончилась (src/services/catalogSyncWatcher.ts).
   */
  async markOrphaned(ownerUserId: number): Promise<{ marked: number; restored: number }> {
    const db = getDb();
    const marked = await db.prepare(
      `UPDATE nomenclature_mapping_cards SET orphaned_at = NOW()
       WHERE owner_user_id = ? AND orphaned_at IS NULL
         AND onec_guid IS NOT NULL AND onec_guid != ''
         AND onec_guid NOT IN (SELECT guid FROM onec_nomenclature_cards WHERE owner_user_id = ?)`
    ).run(ownerUserId, ownerUserId);
    const restored = await db.prepare(
      `UPDATE nomenclature_mapping_cards SET orphaned_at = NULL
       WHERE owner_user_id = ? AND orphaned_at IS NOT NULL
         AND onec_guid IN (SELECT guid FROM onec_nomenclature_cards WHERE owner_user_id = ?)`
    ).run(ownerUserId, ownerUserId);
    return { marked: marked.changes, restored: restored.changes };
  },

  /**
   * Физическое удаление «осиротевших» сопоставлений — ТОЛЬКО по явному
   * действию человека. С v2 синк каталога его не вызывает (см. markOrphaned).
   */
  async removeOrphaned(ownerUserId: number): Promise<number> {
    const result = await getDb().prepare(
      `DELETE FROM nomenclature_mapping_cards
       WHERE owner_user_id = ?
       AND onec_guid IS NOT NULL AND onec_guid != ''
       AND onec_guid NOT IN (
         SELECT guid FROM onec_nomenclature_cards WHERE owner_user_id = ?
       )`
    ).run(ownerUserId, ownerUserId);
    return result.changes;
  },
};
