import { invoiceRepo, type Invoice } from '../database/repositories/invoiceRepo';
import { mappingRepo } from '../database/repositories/mappingRepo';
import { onecNomenclatureRepo } from '../database/repositories/onecNomenclatureRepo';
import { logEdit } from '../database/repositories/editLogRepo';
import { mapItemsWithClaudeApi, type CatalogEntry, type LlmMapHit } from '../ocr/claudeApiAnalyzer';
import { resolveAndApplyPackTransform, coerceToOnec1cUnit } from '../mapping/packTransform';
import { reconvertStoredItem } from './itemReconvert';
import { getEngineFlags } from './engineFlags';
import { checkLlmPick } from './llmPickGuard';
import { config } from '../config';
import { logger } from '../utils/logger';

/**
 * «LLM-маппинг» одной накладной: Claude сопоставляет строки со справочником
 * 1С компании. Вынесено из POST /api/invoices/:id/llm-remap — тем же кодом
 * пользуется массовый подбор для «Очереди в 1С» (POST /api/queue/llm-map).
 * Ответы маршрута прежние; добавлены проверки v2 (ниже) и запись в журнал
 * правок (правило 25), если строки поменялись.
 *
 * По умолчанию трогает только строки без позиции 1С; includeAll — все строки.
 * Если для уже сопоставленной строки Claude ничего не нашёл, позиция остаётся
 * (null от модели — «лучше не нашлось», а не «отвязать»). Упаковки/единицы из
 * ответа ИИ применяются только к новым строкам и к строкам, чья позиция
 * сменилась, — повторный запуск не умножает количество ещё раз.
 *
 * Пакет v2 (mapping_v2): выбор ИИ проходит те же проверки, что при
 * распознавании (src/services/llmPickGuard.ts) — подтверждённое человеком
 * правило важнее ИИ, отклонённая «не это» позиция и позиция, противоречащая
 * названию по объёму/размеру/жирности/артикулу, не ставятся. Выключенный флаг —
 * прежнее поведение.
 */

export interface LlmRemapData {
  id: number;
  requested: number;
  matched: number;
  changed: number;
  repacked: number;
  /** Нет в ответе «нечего сопоставлять» — как и раньше у маршрута. */
  coerced?: number;
  total: number;
  message?: string;
}

export type LlmRemapOutcome =
  | {
      ok: true;
      /** Ровно то, что маршрут отдаёт в { data }. */
      data: LlmRemapData;
      /** Сколько выборов ИИ не принято проверками v2 (заменено подтверждённым правилом или отброшено). */
      guarded: number;
    }
  | { ok: false; status: 400 | 500 | 502; error: string };

export interface LlmRemapOptions {
  includeAll: boolean;
  /** Каталог 1С владельца в том порядке, в каком он уйдёт в запрос. Не передан — читается из БД. */
  catalog?: CatalogEntry[];
  /**
   * Не трогать строки, для которых человек задал своё название для 1С
   * (name_overridden). Массовый подбор очереди включает: явное решение
   * человека важнее ИИ. Маршрут одной накладной — как раньше.
   */
  skipNameOverridden?: boolean;
  /**
   * Итог пересчитать, но НДС шапки не трогать (recalculateTotal keepVat) —
   * массовый подбор очереди меняет только строки. Маршрут одной накладной —
   * как раньше (recalculateTotal без опций).
   */
  keepHeaderVat?: boolean;
  /** Кто запустил — для журнала правок. */
  userId?: number | null;
}

export const EMPTY_CATALOG_ERROR = 'Справочник 1С пуст — нечего сопоставлять. Сначала выгрузите номенклатуру из 1С.';
export const NO_API_KEY_ERROR = 'Anthropic API key not configured';

/** Каталог компании для запроса к Claude (без групп). */
export async function loadLlmCatalog(ownerUserId: number): Promise<CatalogEntry[]> {
  const rows = await onecNomenclatureRepo.listItems({ ownerUserId, excludeFolders: true });
  return rows.map(r => ({ guid: r.guid, name: r.name, unit: r.unit }));
}

export async function llmRemapInvoice(invoice: Invoice, opts: LlmRemapOptions): Promise<LlmRemapOutcome> {
  const id = invoice.id;
  const includeAll = opts.includeAll;

  // Каталог и сопоставления пер-тенантные: работаем в области владельца
  // накладной, а не действующего пользователя — так админ, правящий чужую
  // накладную, всё равно видит каталог её компании.
  const mappingOwnerId = invoice.owner_user_id ?? -1;

  const items = await invoiceRepo.getItems(id);
  let targets = includeAll ? items : items.filter(it => !it.onec_guid);
  if (opts.skipNameOverridden) targets = targets.filter(it => !Number(it.name_overridden ?? 0));
  if (targets.length === 0) {
    return {
      ok: true,
      guarded: 0,
      data: {
        id, requested: 0, matched: 0, changed: 0, repacked: 0, total: items.length,
        message: includeAll ? 'В накладной нет товаров' : 'Нет несопоставленных товаров',
      },
    };
  }

  // Build the catalog snapshot ONCE — the same ordering is used both to
  // build the prompt and to resolve catalog_idx back to a guid in the
  // response.
  const catalog = opts.catalog ?? await loadLlmCatalog(mappingOwnerId);
  if (catalog.length === 0) {
    return { ok: false, status: 400, error: EMPTY_CATALOG_ERROR };
  }

  const analyzerCfg = await invoiceRepo.getAnalyzerConfig();
  const apiKey = analyzerCfg.anthropic_api_key || config.anthropicApiKey;
  if (!apiKey) {
    return { ok: false, status: 500, error: NO_API_KEY_ERROR };
  }

  const result = await mapItemsWithClaudeApi(
    targets.map(it => ({ key: String(it.id), name: it.original_name || '', unit: it.unit })),
    catalog,
    apiKey,
    analyzerCfg.claude_model || 'claude-sonnet-5',
  );

  if (!result.success || !result.matched) {
    return { ok: false, status: 502, error: result.error || 'LLM mapping failed' };
  }

  const flags = await getEngineFlags();
  let matched = 0;   // items for which Claude returned a guid
  let changed = 0;   // items whose guid actually changed vs DB
  let repacked = 0;  // items on which we applied pack_size / unit_override
  let coercedCount = 0;  // items whose unit was coerced to the 1C accounting unit
  let guarded = 0;   // v2: picks replaced by a confirmed rule or dropped
  for (const it of targets) {
    let hit: LlmMapHit | undefined = result.matched.get(String(it.id));
    const wasUnmapped = !it.onec_guid;

    if (hit && flags.mapping_v2) {
      const verdict = await checkLlmPick(it.original_name || '', hit, mappingOwnerId);
      if (verdict.kind === 'confirmed') {
        // Подтверждённое человеком правило важнее выбора ИИ — и позиция, и
        // упаковка правила (как FileWatcher.pickWithLlm). Своей упаковки у
        // правила нет — подсказка ИИ остаётся, только если ИИ выбрал ту же
        // позицию: его упаковка — про его позицию.
        const rulePack = verdict.packSize && verdict.packSize > 0 && verdict.packUnit
          ? { pack_size: verdict.packSize, unit_override: verdict.packUnit } : null;
        hit = {
          ...hit,
          guid: verdict.guid,
          name: verdict.name,
          pack_size: rulePack ? rulePack.pack_size : (verdict.same ? hit.pack_size : null),
          unit_override: rulePack ? rulePack.unit_override : (verdict.same ? hit.unit_override : null),
        };
        if (!verdict.same) guarded++;
      } else if (verdict.kind === 'rejected' || verdict.kind === 'conflict') {
        logger.info('LLM-remap pick rejected by v2 guards', {
          id, itemId: it.id, name: it.original_name, pick: hit.name,
          reason: verdict.kind === 'conflict' ? verdict.reason : 'rejected',
        });
        hit = undefined;
        guarded++;
      }
    }

    // Path A: Claude returned a hit. Apply guid + maybe pack_size / unit_override.
    if (hit) {
      matched++;
      const guidChanged = it.onec_guid !== hit.guid;
      if (guidChanged) {
        await invoiceRepo.updateItemMapping(it.id, hit.guid, hit.name, 1.0);
        changed++;
      }
      const onec1cUnit = (await onecNomenclatureRepo.getByGuid(hit.guid, mappingOwnerId))?.unit ?? null;

      // Pack-transforms multiply qty — so we only run them when this row is
      // either NEW (was unmapped) or the guid switched. Otherwise we'd double-
      // count on every re-run.
      const canRepack = wasUnmapped || guidChanged;

      if (flags.units_v2) {
        const fresh = await invoiceRepo.getItemById(it.id);
        const llmPack = hit.pack_size && hit.pack_size > 0 && hit.unit_override
          ? { size: hit.pack_size, unit: hit.unit_override } : null;
        if (fresh && await reconvertStoredItem(fresh, invoice, { onecGuid: hit.guid, mappedName: hit.name, pack: llmPack, force: canRepack && fresh.conv_source != null && fresh.conv_source !== 'legacy_stored' })) {
          repacked++;
        }
        continue;
      }

      if (canRepack) {
        // Unified pack-transform path that mirrors fileWatcher. Priority for
        // pack hints: LLM (when complete) → learned mapping → regex fallback
        // via detectPackFromName. The regex fallback is what catches
        // "Мука (50кг)" — without it, items that were originally unmapped
        // and only got their guid via this LLM-remap call would never get
        // their qty/unit corrected from "1 шт" to "50 кг".
        const learnedMapping = await mappingRepo.getByScannedName(it.original_name || '', mappingOwnerId);
        const llmGavePackHint = !!(hit.pack_size && hit.pack_size > 0 && hit.unit_override);
        const hintedSize = llmGavePackHint ? hit.pack_size : (learnedMapping?.pack_size ?? null);
        const hintedUnit = llmGavePackHint ? hit.unit_override : (learnedMapping?.pack_unit ?? null);

        const resolved = resolveAndApplyPackTransform(
          { quantity: it.quantity, unit: it.unit, price: it.price, total: it.total },
          it.original_name || '',
          hintedSize,
          hintedUnit,
          hit.name,
          onec1cUnit,
        );

        const r = resolved.item;
        const beforeQty = it.quantity;
        const beforeUnit = it.unit;
        const beforePrice = it.price;
        if (r.quantity !== beforeQty || r.unit !== beforeUnit || r.price !== beforePrice) {
          await invoiceRepo.updateItemFields(it.id, {
            quantity: r.quantity ?? null,
            unit: r.unit ?? null,
            price: r.price ?? null,
          });
          repacked++;
        }

        // Persist regex-detected pack back to the mapping (как watcher) —
        // следующий llm-remap пойдёт по learned-mapping ветке, а не regex.
        if (resolved.usedFallback && learnedMapping && resolved.packSize && resolved.packUnit) {
          await mappingRepo.update(learnedMapping.id, mappingOwnerId, {
            pack_size: resolved.packSize,
            pack_unit: resolved.packUnit,
          });
        }
      } else {
        // Already-mapped, no guid change — coerce-only (idempotent). Even
        // long-standing rows whose unit doesn't match the 1C accounting unit
        // (e.g. stored as "л" while 1C tracks in "кг") get fixed here.
        const coerced = coerceToOnec1cUnit(
          { quantity: it.quantity, unit: it.unit, price: it.price, total: it.total },
          onec1cUnit,
        );
        if (coerced.unit !== it.unit || coerced.quantity !== it.quantity) {
          await invoiceRepo.updateItemFields(it.id, coerced);
          coercedCount++;
        }
      }
      continue;
    }

    // Path B: Claude returned no hit. We can't re-map but we CAN still
    // coerce the unit if the row was already mapped previously and is
    // sitting in a non-1C unit (e.g. "л" while 1C tracks in "кг").
    if (!wasUnmapped) {
      const onec1cUnit = (await onecNomenclatureRepo.getByGuid(it.onec_guid as string, mappingOwnerId))?.unit ?? null;
      const coerced = coerceToOnec1cUnit(
        { quantity: it.quantity, unit: it.unit, price: it.price, total: it.total },
        onec1cUnit,
      );
      if (coerced.unit !== it.unit || coerced.quantity !== it.quantity) {
        await invoiceRepo.updateItemFields(it.id, coerced);
        coercedCount++;
      }
    }
  }

  // Flags the invoice if Σ(items.total) drifts from invoice.total_sum.
  if (opts.keepHeaderVat) await invoiceRepo.recalculateTotal(id, { keepVat: true });
  else await invoiceRepo.recalculateTotal(id);

  logger.info('LLM-remap completed', {
    id, requested: targets.length, matched, changed, repacked, coerced: coercedCount, guarded, all: includeAll,
  });
  if (changed > 0 || repacked > 0 || coercedCount > 0) {
    await logEdit({
      ownerUserId: invoice.owner_user_id, userId: opts.userId ?? null, invoiceId: id,
      entity: 'mapping', field: 'llm_remap', oldValue: null,
      newValue: { requested: targets.length, matched, changed, repacked, coerced: coercedCount, guarded },
      context: { all: includeAll, supplier: invoice.supplier, supplier_inn: invoice.supplier_inn },
    });
  }

  return {
    ok: true,
    guarded,
    data: {
      id,
      requested: targets.length,
      matched,
      changed,
      repacked,
      coerced: coercedCount,
      total: items.length,
    },
  };
}
