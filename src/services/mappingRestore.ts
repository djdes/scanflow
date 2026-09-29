import { getDb } from '../database/db';
import { mappingRepo } from '../database/repositories/mappingRepo';
import { onecNomenclatureRepo } from '../database/repositories/onecNomenclatureRepo';
import { rejectionRepo } from '../database/repositories/rejectionRepo';
import { logEdit } from '../database/repositories/editLogRepo';
import { itemNameKey, extractAttrs, attrsConflict } from '../mapping/nameKey';

/**
 * Возврат сопоставлений из резервной копии (пакет v2, п.7 и откат).
 *
 * Выгрузка каталога до v2 стирала правила, чья позиция пропадала из каталога
 * (removeOrphaned). Правила из старых дампов возвращаются ТОЛЬКО если:
 * такого названия у компании нет, ключ товара не занят другим правилом,
 * позиция есть в текущем каталоге, это не «обрывок» названия позиции
 * («Продукт» → «Продукт жировой сметанный 20%») и не тождество (его и так
 * найдёт точное совпадение с каталогом), атрибуты не спорят (330 г ≠ 500 г)
 * и позицию не отклоняли («не это»). Возвращённое правило — НЕ
 * подтверждённое (source='restored'): выбор ИИ и подтверждённые правила важнее.
 */
export interface RestoreRow {
  scanned_name: string;
  onec_guid: string;
  pack_size?: number | null;
  pack_unit?: string | null;
  default_unit?: string | null;
  category?: string | null;
}

export type RestoreVerdict =
  | 'restore' | 'exists' | 'name_key_taken' | 'guid_missing' | 'identity' | 'fragment' | 'attrs_conflict' | 'rejected' | 'invalid';

export interface RestoreFacts {
  exists: boolean;
  nameKeyTaken: boolean;
  catalogName: string | null;
  isFolder: boolean;
  rejected: boolean;
}

const cmp = (s: string) => s.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[^\p{L}\p{N}%]+/gu, ' ').trim();

/** Чистое решение по одной строке. */
export function classifyRestoreRow(row: RestoreRow, f: RestoreFacts): { verdict: RestoreVerdict; reason?: string } {
  const name = String(row.scanned_name ?? '').trim();
  if (!name || !row.onec_guid) return { verdict: 'invalid' };
  if (f.exists) return { verdict: 'exists' };
  if (!f.catalogName || f.isFolder) return { verdict: 'guid_missing' };
  const s = cmp(name);
  const c = cmp(f.catalogName);
  if (s === c) return { verdict: 'identity' };
  if (c.startsWith(`${s} `)) return { verdict: 'fragment' };
  const conflict = attrsConflict(extractAttrs(name), extractAttrs(f.catalogName));
  if (conflict) return { verdict: 'attrs_conflict', reason: conflict };
  if (f.rejected) return { verdict: 'rejected' };
  if (f.nameKeyTaken) return { verdict: 'name_key_taken' };
  return { verdict: 'restore' };
}

export interface RestoreResult {
  dry_run: boolean;
  counts: Record<RestoreVerdict, number>;
  items: Array<{ scanned_name: string; onec_guid: string; onec_name: string | null; verdict: RestoreVerdict; reason?: string }>;
}

const MAX_ROWS = 20000;

export async function restoreMappings(
  ownerUserId: number,
  input: RestoreRow[],
  opts: { dryRun: boolean; actorUserId: number | null; label?: string },
): Promise<RestoreResult> {
  const counts = { restore: 0, exists: 0, name_key_taken: 0, guid_missing: 0, identity: 0, fragment: 0, attrs_conflict: 0, rejected: 0, invalid: 0 } as Record<RestoreVerdict, number>;
  const items: RestoreResult['items'] = [];
  const existing: RestoreResult['items'] = [];
  const seen = new Set<string>();
  const keysTakenNow = new Set<string>();
  const db = getDb();

  for (const raw of input.slice(0, MAX_ROWS)) {
    const row: RestoreRow = {
      scanned_name: String(raw?.scanned_name ?? '').trim().slice(0, 512),
      onec_guid: String(raw?.onec_guid ?? '').trim(),
      pack_size: Number(raw?.pack_size) > 0 ? Number(raw.pack_size) : null,
      pack_unit: raw?.pack_unit ? String(raw.pack_unit).slice(0, 32) : null,
      default_unit: raw?.default_unit ? String(raw.default_unit).slice(0, 64) : null,
      category: raw?.category ? String(raw.category).slice(0, 255) : null,
    };
    const dedupe = cmp(row.scanned_name);
    if (!dedupe || seen.has(dedupe)) continue;
    seen.add(dedupe);

    const nameKey = itemNameKey(row.scanned_name).slice(0, 255);
    const exists = !!(await mappingRepo.getByScannedName(row.scanned_name, ownerUserId));
    const taken = keysTakenNow.has(nameKey) || !!(nameKey && await db.prepare(
      'SELECT id FROM nomenclature_mapping_cards WHERE owner_user_id = ? AND name_key = ? LIMIT 1',
    ).get(ownerUserId, nameKey));
    const cat = row.onec_guid ? await onecNomenclatureRepo.getByGuid(row.onec_guid, ownerUserId) : undefined;
    const rejected = nameKey ? (await rejectionRepo.guidsFor(ownerUserId, nameKey)).has(row.onec_guid) : false;
    const { verdict, reason } = classifyRestoreRow(row, {
      exists, nameKeyTaken: taken, catalogName: cat?.name ?? null, isFolder: !!cat?.is_folder, rejected,
    });

    let final = verdict;
    if (verdict === 'restore' && !opts.dryRun) {
      try {
        await mappingRepo.create({
          scanned_name: row.scanned_name, mapped_name_1c: cat!.name, onec_guid: row.onec_guid,
          pack_size: row.pack_size, pack_unit: row.pack_unit, default_unit: row.default_unit ?? undefined,
          category: row.category ?? undefined, approved: false, source: 'restored',
        }, ownerUserId);
      } catch {
        final = 'exists'; // гонка с параллельной записью — правило уже есть
      }
    }
    if (final === 'restore') keysTakenNow.add(nameKey);
    counts[final]++;
    // «Уже есть» — большинство строк старого дампа; в ответ они идут последними.
    (final === 'exists' ? existing : items).push({ scanned_name: row.scanned_name, onec_guid: row.onec_guid, onec_name: cat?.name ?? null, verdict: final, reason });
  }

  if (!opts.dryRun && counts.restore > 0) {
    await logEdit({
      ownerUserId, userId: opts.actorUserId, entity: 'mapping', field: 'restore_from_backup', oldValue: null,
      newValue: { restored: counts.restore }, context: { label: opts.label ?? null, counts },
    });
  }
  return { dry_run: opts.dryRun, counts, items: [...items, ...existing].slice(0, 1000) };
}
