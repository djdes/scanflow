import { getDb } from '../database/db';
import { onecNomenclatureRepo } from '../database/repositories/onecNomenclatureRepo';
import { mappingRepo } from '../database/repositories/mappingRepo';
import { itemNameKey } from '../mapping/nameKey';

export class AliasError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Aliases are confirmed mapping rules, so OCR, manual search and history share one source. */
export async function saveCatalogAliases(owner: number, actor: number, guid: string, input: unknown) {
  if (!Array.isArray(input) || !input.length || input.length > 50 || input.some(name => typeof name !== 'string' || !/[\p{L}\p{N}]/u.test(name) || name.trim().length > 500)) {
    throw new AliasError(400, 'Введите от 1 до 50 названий, каждое не длиннее 500 символов.');
  }
  const names = [...new Set((input as string[]).map(name => name.trim().replace(/\s+/g, ' ')))];
  const catalog = await onecNomenclatureRepo.getByGuid(guid, owner);
  if (!catalog || catalog.is_folder) throw new AliasError(404, 'Товар не найден в каталоге вашей компании.');
  await getDb().transaction(async db => {
    await db.prepare('SELECT id FROM users WHERE id = ? FOR UPDATE').get(owner);
    for (const name of names) {
      const conflicts = await db.prepare(`SELECT id FROM nomenclature_mapping_cards WHERE owner_user_id = ?
        AND (scanned_name = ? OR name_key = ?) AND confirmed_at IS NOT NULL AND orphaned_at IS NULL AND onec_guid <> ? LIMIT 1 FOR UPDATE`)
        .get(owner, name, itemNameKey(name).slice(0, 255), guid);
      if (conflicts) throw new AliasError(409, `«${name}» уже подтверждено для другого товара. Измените существующее соответствие в разделе «Номенклатура».`);
    }
    for (const name of names) {
      const nameKey = itemNameKey(name).slice(0, 255);
      await db.prepare(`INSERT INTO nomenclature_mapping_cards
        (owner_user_id, scanned_name, mapped_name_1c, onec_guid, approved, source, name_key, confirmed_at, confirmed_by)
        VALUES (?, ?, ?, ?, 1, 'user', ?, NOW(), ?)
        ON DUPLICATE KEY UPDATE
          pack_size = IF(onec_guid = VALUES(onec_guid), pack_size, NULL),
          pack_unit = IF(onec_guid = VALUES(onec_guid), pack_unit, NULL),
          mapped_name_1c = VALUES(mapped_name_1c), onec_guid = VALUES(onec_guid), approved = 1,
          source = 'user', name_key = VALUES(name_key), confirmed_at = NOW(), confirmed_by = VALUES(confirmed_by), orphaned_at = NULL`)
        .run(owner, name, catalog.name, guid, nameKey, actor);
      await db.prepare('DELETE FROM mapping_rejections WHERE owner_user_id = ? AND name_key = ? AND onec_guid = ?').run(owner, nameKey.slice(0, 191), guid);
    }
  });
  return mappingRepo.listAliases(owner, guid);
}

export async function removeCatalogAlias(owner: number, guid: string, id: number) {
  return getDb().transaction(async db => {
    const row = await db.prepare(`SELECT scanned_name FROM nomenclature_mapping_cards WHERE owner_user_id = ?
      AND onec_guid = ? AND id = ? AND confirmed_at IS NOT NULL FOR UPDATE`).get<{ scanned_name: string }>(owner, guid, id);
    if (!row) throw new AliasError(404, 'Синоним не найден.');
    await db.prepare('DELETE FROM nomenclature_mapping_cards WHERE owner_user_id = ? AND onec_guid = ? AND id = ?').run(owner, guid, id);
    // An explicit "forget" must also stop the same exact name being selected through a supplier rule.
    await db.prepare('DELETE FROM supplier_nomenclature_mapping_cards WHERE owner_user_id = ? AND scanned_name = ? AND onec_guid = ?').run(owner, row.scanned_name, guid);
  });
}
