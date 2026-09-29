import { getDb, type DbAdapter } from '../database/db';
import type { Supplier } from '../database/repositories/supplierRepo';
import { makeSupplierKey } from '../database/repositories/supplierMappingRepo';
import { supplierCorrectionKey } from '../database/repositories/ocrCorrectionRepo';
import { isValidInn } from '../utils/inn';
import { logger } from '../utils/logger';
import { logEdit } from '../database/repositories/editLogRepo';

/**
 * «Объединить карточки» справочника поставщиков (п.18 пакета v2).
 *
 * Типичный случай — двойник с опечаткой OCR в ИНН: «Вкусный мир ТК» 7724357832
 * рядом с настоящей карточкой 7724357632. Накладные, привязанные к двойнику,
 * получают ИНН и название карточки-цели (что было на фото — сохраняется в
 * supplier_inn_ocr/supplier_name_ocr), выученные правила поставщика переезжают
 * на ИНН цели, а карточка-источник удаляется. Её полная строка возвращается
 * и пишется в лог, чтобы карточку можно было восстановить руками.
 *
 * Всё в одной транзакции: либо переехало всё, либо ничего.
 */

export class SupplierMergeError extends Error {
  constructor(public readonly status: 400 | 404, message: string) {
    super(message);
    this.name = 'SupplierMergeError';
  }
}

export interface SupplierMergeResult {
  moved_invoices: number;
  /** Правила поставщика (сопоставления позиций + исправления OCR), переехавшие на ИНН цели. */
  moved_rules: number;
  /** Правила, оставленные на старом ключе: у цели уже есть правило на то же значение. */
  skipped_rules: number;
  /** Удалённая карточка-источник целиком — для восстановления. */
  deleted_card: Supplier;
}

/**
 * Таблицы правил, привязанных к поставщику по ключу из ИНН. Имена таблиц и
 * колонок — фиксированный список, в SQL подставляются только они (правило 18).
 * uniq — колонки уникального ключа помимо (owner_user_id, supplier_key): по ним
 * определяется, что у цели уже есть такое же правило.
 */
interface RuleTable {
  table: 'supplier_nomenclature_mapping_cards' | 'ocr_correction_cards';
  uniq: readonly string[];
  key: (inn: string) => string | null;
}

const RULE_TABLES: readonly RuleTable[] = [
  // Сопоставления позиций по поставщику: supplier_key = 'inn:<цифры>'.
  { table: 'supplier_nomenclature_mapping_cards', uniq: ['scanned_hash'], key: inn => makeSupplierKey(inn, null) },
  // Выученные исправления OCR: supplier_key = '<цифры>'.
  { table: 'ocr_correction_cards', uniq: ['field_name', 'original_hash'], key: inn => supplierCorrectionKey({ supplier_inn: inn }) },
];

const ID_CHUNK = 500;

async function lockCard(txn: DbAdapter, ownerUserId: number, inn: string): Promise<Supplier | undefined> {
  return txn
    .prepare('SELECT * FROM supplier_cards WHERE owner_user_id = ? AND inn = ? FOR UPDATE')
    .get<Supplier>(ownerUserId, inn);
}

/**
 * Перенести правила с ключа fromKey на toKey. Строку, для которой у цели уже
 * есть правило с тем же уникальным ключом, не трогаем: UPDATE упал бы на
 * дубликате, а правило цели — более свежее знание о настоящем поставщике.
 * Кандидаты считаются в приложении, а не подзапросом: MySQL не разрешает
 * читать изменяемую таблицу в подзапросе UPDATE (ошибка 1093), MariaDB —
 * разрешает; так SQL одинаково работает на обеих.
 */
async function rekeyRules(
  txn: DbAdapter,
  t: RuleTable,
  ownerUserId: number,
  fromKey: string,
  toKey: string,
): Promise<{ moved: number; skipped: number }> {
  const cols = t.uniq.join(', ');
  const signature = (row: Record<string, unknown>): string => t.uniq.map(c => String(row[c])).join('\u0001');

  const targetRows = await txn
    .prepare(`SELECT ${cols} FROM ${t.table} WHERE owner_user_id = ? AND supplier_key = ? FOR UPDATE`)
    .all<Record<string, unknown>>(ownerUserId, toKey);
  const taken = new Set(targetRows.map(signature));

  const sourceRows = await txn
    .prepare(`SELECT id, ${cols} FROM ${t.table} WHERE owner_user_id = ? AND supplier_key = ? FOR UPDATE`)
    .all<Record<string, unknown>>(ownerUserId, fromKey);
  const ids = sourceRows.filter(r => !taken.has(signature(r))).map(r => Number(r.id));

  let moved = 0;
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const res = await txn
      .prepare(
        `UPDATE ${t.table} SET supplier_key = ?
          WHERE owner_user_id = ? AND supplier_key = ? AND id IN (${chunk.map(() => '?').join(', ')})`,
      )
      .run(toKey, ownerUserId, fromKey, ...chunk);
    moved += res.changes;
  }
  return { moved, skipped: sourceRows.length - ids.length };
}

export async function mergeSupplierCards(
  ownerUserId: number,
  sourceInn: string,
  targetInn: string,
  actorUserId: number | null = null,
): Promise<SupplierMergeResult> {
  if (sourceInn === targetInn) {
    throw new SupplierMergeError(400, 'Нельзя объединить карточку саму с собой');
  }

  const result = await getDb().transaction(async (txn): Promise<SupplierMergeResult> => {
    const source = await lockCard(txn, ownerUserId, sourceInn);
    const target = await lockCard(txn, ownerUserId, targetInn);
    if (!source || !target) throw new SupplierMergeError(404, 'Поставщик не найден');
    if (!isValidInn(target.inn)) {
      throw new SupplierMergeError(
        400,
        `Объединять можно только в карточку с верным ИНН: ${target.inn} не проходит проверку контрольной суммы`,
      );
    }

    // (а) Накладные. Поля *_ocr присваиваются ПЕРВЫМИ: MySQL и MariaDB (без
    // SIMULTANEOUS_ASSIGNMENT) вычисляют SET слева направо и видят уже
    // присвоенные значения — стоя после supplier_inn = ?, COALESCE сохранил бы
    // ИНН цели вместо того, что было на фото.
    const invoices = await txn
      .prepare(
        `UPDATE invoices
            SET supplier_inn_ocr = COALESCE(supplier_inn_ocr, supplier_inn),
                supplier_name_ocr = COALESCE(supplier_name_ocr, supplier),
                supplier_inn = ?,
                supplier = ?,
                supplier_match = 'manual'
          WHERE owner_user_id = ? AND supplier_inn = ?`,
      )
      .run(target.inn, target.name, ownerUserId, source.inn);

    // (б) Правила поставщика. Ключ строится из цифр ИНН; у карточки без цифр в
    // ИНН (не бывает после валидации, но старые данные) переносить нечего —
    // и главное, нельзя задеть общую корзину 'name:unknown'.
    let movedRules = 0;
    let skippedRules = 0;
    if (/\d/.test(source.inn)) {
      for (const t of RULE_TABLES) {
        const fromKey = t.key(source.inn);
        const toKey = t.key(target.inn);
        if (!fromKey || !toKey || fromKey === toKey) continue;
        const r = await rekeyRules(txn, t, ownerUserId, fromKey, toKey);
        movedRules += r.moved;
        skippedRules += r.skipped;
      }
    }

    // (в) Карточка-источник.
    await txn
      .prepare('DELETE FROM supplier_cards WHERE id = ? AND owner_user_id = ?')
      .run(source.id, ownerUserId);

    return {
      moved_invoices: invoices.changes,
      moved_rules: movedRules,
      skipped_rules: skippedRules,
      deleted_card: source,
    };
  });

  // Удалённая карточка целиком — в журнал правок: по нему её можно восстановить.
  await logEdit({
    ownerUserId, userId: actorUserId, entity: 'supplier', field: 'merge',
    oldValue: result.deleted_card, newValue: { inn: targetInn },
    context: { from_inn: sourceInn, to_inn: targetInn, moved_invoices: result.moved_invoices, moved_rules: result.moved_rules, skipped_rules: result.skipped_rules },
  });
  logger.warn('Supplier cards merged', {
    ownerUserId,
    from_inn: sourceInn,
    to_inn: targetInn,
    ...result,
  });
  return result;
}
