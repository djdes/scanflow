import { mappingRepo } from '../database/repositories/mappingRepo';
import { onecNomenclatureRepo } from '../database/repositories/onecNomenclatureRepo';
import { rejectionRepo } from '../database/repositories/rejectionRepo';
import { itemNameKey, extractAttrs, attrsConflict } from '../mapping/nameKey';

/**
 * Проверки пакета v2 (mapping_v2) для позиции 1С, которую выбрал ИИ, — те
 * же, что FileWatcher.pickWithLlm применяет при распознавании:
 *   1) подтверждённое человеком правило для этого товара важнее выбора ИИ;
 *   2) позицию, которую человек отклонил для этого товара («не это»), не берём;
 *   3) позицию, которая противоречит названию по объёму, массе, размеру,
 *      жирности, калибру или артикулу, не берём.
 *
 * Ничего не пишет (ни правил, ни счётчиков). Включён ли mapping_v2 — решает
 * вызывающий: выключенный флаг = прежнее поведение, проверки не вызываются.
 */
export type LlmPickVerdict =
  | { kind: 'accept' }
  | {
      kind: 'confirmed';
      /** Подтверждённое правило указывает на ту же позицию, что выбрал ИИ. */
      same: boolean;
      guid: string;
      name: string;
      unit: string | null;
      mappingId: number;
      packSize: number | null;
      packUnit: string | null;
    }
  | { kind: 'rejected' }
  | { kind: 'conflict'; reason: string };

export async function checkLlmPick(
  scannedName: string,
  pick: { guid: string; name: string },
  ownerUserId: number,
): Promise<LlmPickVerdict> {
  const confirmed = await mappingRepo.getConfirmed(scannedName, ownerUserId).catch(() => undefined);
  if (confirmed?.onec_guid) {
    const onec = await onecNomenclatureRepo.getByGuid(confirmed.onec_guid, ownerUserId);
    if (onec) {
      return {
        kind: 'confirmed',
        same: onec.guid === pick.guid,
        guid: onec.guid,
        name: onec.name,
        unit: onec.unit ?? null,
        mappingId: confirmed.id,
        packSize: confirmed.pack_size ?? null,
        packUnit: confirmed.pack_unit ?? null,
      };
    }
  }
  const rejected = await rejectionRepo.guidsFor(ownerUserId, itemNameKey(scannedName));
  if (rejected.has(pick.guid)) return { kind: 'rejected' };
  const conflict = attrsConflict(extractAttrs(scannedName), extractAttrs(pick.name));
  if (conflict) return { kind: 'conflict', reason: conflict };
  return { kind: 'accept' };
}
