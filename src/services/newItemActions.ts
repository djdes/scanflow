import { invoiceRepo } from '../database/repositories/invoiceRepo';
import { mappingRepo } from '../database/repositories/mappingRepo';
import { rejectionRepo } from '../database/repositories/rejectionRepo';
import { onecNomenclatureRepo } from '../database/repositories/onecNomenclatureRepo';
import { newItemRequestRepo, type UnsentUnmappedLine } from '../database/repositories/newItemRequestRepo';
import { logEdit } from '../database/repositories/editLogRepo';
import { reconvertStoredItem } from './itemReconvert';
import { matchRequestsToCatalog, newItemGroupKey } from './newItems';
import { logger } from '../utils/logger';

/**
 * «Новые товары» (пакет v2, п.12) — действия с БД. Чистая логика — в ./newItems.
 */

type MapperCache = { invalidateCache(ownerUserId?: number): void } | null | undefined;

/** Строки группы (ключ товара) без позиции 1С в неотправленных накладных компании. */
export async function unsentGroupLines(ownerUserId: number, nameKey: string): Promise<UnsentUnmappedLine[]> {
  const lines = await newItemRequestRepo.unsentUnmappedLines(ownerUserId);
  return lines.filter(l => newItemGroupKey(l.original_name) === nameKey);
}

export interface GroupMapResult {
  /** Сколько строк получили позицию 1С. */
  lines: number;
  invoices: number;
  /** Сколько написаний стали подтверждёнными правилами сопоставления. */
  rules: number;
  /** Сколько строк пересчитано в единицу позиции 1С. */
  reconverted: number;
}

/**
 * Сопоставить все строки группы в неотправленных накладных с позицией 1С —
 * так же, как ручной выбор позиции на накладной: строка получает позицию с
 * уверенностью 1.0, каждое написание — подтверждённое правило (важнее выбора
 * ИИ), отклонение «не это» для этой позиции снимается, количество
 * пересчитывается в единицу позиции (только через convertInvoiceLine), итоги
 * накладных пересчитываются. Сумма строк при этом не меняется.
 */
export async function mapNewItemGroup(a: {
  ownerUserId: number;
  nameKey: string;
  onecGuid: string;
  catalogName: string;
  userId: number | null;
  source: 'new_items_page' | 'catalog_sync';
  requestId?: number | null;
}): Promise<GroupMapResult> {
  const lines = await unsentGroupLines(a.ownerUserId, a.nameKey);
  if (lines.length === 0) return { lines: 0, invoices: 0, rules: 0, reconverted: 0 };

  for (const l of lines) {
    await invoiceRepo.updateItemMapping(l.id, a.onecGuid, a.catalogName, 1);
  }
  const names = Array.from(new Set(lines.map(l => l.original_name)));
  for (const name of names) {
    await mappingRepo.confirm(name, a.onecGuid, a.catalogName, a.ownerUserId, a.userId);
  }
  await rejectionRepo.clear(a.ownerUserId, a.nameKey, a.onecGuid);

  // Пересчёт — вторичен: сопоставление уже записано, а строку всегда можно
  // пересчитать с накладной. Поэтому сбой одной строки не валит всю группу.
  let reconverted = 0;
  const invoiceIds = new Set<number>();
  for (const l of lines) {
    invoiceIds.add(l.invoice_id);
    try {
      const fresh = await invoiceRepo.getItemById(l.id);
      if (!fresh) continue;
      const changed = await reconvertStoredItem(
        fresh,
        { owner_user_id: a.ownerUserId, supplier_inn: l.supplier_inn, supplier: l.supplier },
        { onecGuid: a.onecGuid, mappedName: a.catalogName },
      );
      if (changed) reconverted++;
    } catch (err) {
      logger.warn('new items: reconvert failed', { itemId: l.id, error: (err as Error).message });
    }
  }
  for (const invoiceId of invoiceIds) {
    try {
      await invoiceRepo.recalculateTotal(invoiceId);
    } catch (err) {
      logger.warn('new items: recalculateTotal failed', { invoiceId, error: (err as Error).message });
    }
  }

  // В журнал — по строке: правка видна во вкладке «История» каждой накладной.
  for (const l of lines) {
    await logEdit({
      ownerUserId: a.ownerUserId, userId: a.userId, invoiceId: l.invoice_id, itemId: l.id,
      entity: 'mapping', field: 'new_item_map', oldValue: null, newValue: a.onecGuid,
      context: {
        original_name: l.original_name, old_name: l.mapped_name, new_name: a.catalogName,
        name_key: a.nameKey, source: a.source, request_id: a.requestId ?? null,
      },
    });
  }
  return { lines: lines.length, invoices: invoiceIds.size, rules: names.length, reconverted };
}

/**
 * После выгрузки каталога из 1С (catalogSyncWatcher): ждущие заявки, чья
 * позиция появилась в справочнике (то же название без учёта регистра и
 * пробелов), помечаются «создано», а строки их групп в неотправленных
 * накладных сопоставляются с новой позицией — как «Сопоставить» на странице.
 * Никогда не бросает.
 */
export async function linkCreatedNewItems(ownerUserId: number, mapper?: MapperCache): Promise<{ linked: number; lines: number }> {
  let linked = 0;
  let lines = 0;
  try {
    const pending = await newItemRequestRepo.listPending(ownerUserId);
    if (pending.length === 0) return { linked, lines };
    const catalog = await onecNomenclatureRepo.listItems({ ownerUserId, excludeFolders: true });
    const byId = new Map(pending.map(r => [r.id, r]));
    const matches = matchRequestsToCatalog(pending, catalog);
    for (const { requestId, item } of matches) {
      const req = byId.get(requestId);
      if (!req) continue;
      try {
        if (!(await newItemRequestRepo.markCreated(ownerUserId, requestId, item.guid))) continue;
        const r = await mapNewItemGroup({
          ownerUserId, nameKey: req.name_key, onecGuid: item.guid, catalogName: item.name,
          userId: null, source: 'catalog_sync', requestId,
        });
        linked++;
        lines += r.lines;
      } catch (err) {
        logger.warn('new items: linking created item failed', { ownerUserId, requestId, error: (err as Error).message });
      }
    }
    // Правила сопоставления могли измениться даже при частичном сбое.
    if (matches.length) mapper?.invalidateCache(ownerUserId);
    if (linked) logger.info('Catalog updated: requested new items linked', { ownerUserId, linked, lines });
  } catch (err) {
    logger.warn('linkCreatedNewItems failed', { ownerUserId, error: (err as Error).message });
  }
  return { linked, lines };
}
