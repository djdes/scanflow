import { getDb } from '../database/db';
import { invoiceRepo } from '../database/repositories/invoiceRepo';
import type { NomenclatureMapper } from '../mapping/nomenclatureMapper';
import { reconvertStoredItem } from './itemReconvert';
import { logger } from '../utils/logger';

/**
 * «Быстрый старт» (пакет v2, п.13): после обновления каталога 1С
 * пересопоставить неотправленные накладные компании — строки без позиции 1С
 * или с низкой уверенностью. Вторая компания на проде загрузила первые
 * накладные ДО выгрузки каталога, и они так и остались несопоставленными.
 *
 * Трогаем только то, что стало лучше: новая позиция и уверенность выше
 * прежней. Ручные названия (name_overridden) и отправленные накладные — мимо.
 * Последовательно, без ИИ (CLAUDE.md, правило 21 — никаких параллельных
 * тяжёлых вызовов). Никогда не бросает.
 */
export async function remapUnsentInvoices(ownerUserId: number, mapper: NomenclatureMapper): Promise<{ invoices: number; lines: number }> {
  let invoicesTouched = 0;
  let lines = 0;
  try {
    const invoices = await getDb().prepare(`
      SELECT id FROM invoices
       WHERE owner_user_id = ? AND status = 'processed' AND approved_for_1c = 0 AND sent_at IS NULL
         AND duplicate_of IS NULL AND created_at >= (NOW() - INTERVAL 45 DAY)
       ORDER BY id DESC LIMIT 60
    `).all<{ id: number }>(ownerUserId);
    mapper.invalidateCache(ownerUserId);
    for (const { id } of invoices) {
      const inv = await invoiceRepo.getById(id);
      if (!inv) continue;
      const items = await invoiceRepo.getItems(id);
      let changed = 0;
      for (const it of items) {
        if (it.name_overridden) continue;
        const conf = it.mapping_confidence ?? 0;
        if (it.onec_guid && conf >= 0.8) continue;
        const r = await mapper.map(it.original_name, ownerUserId, { supplierInn: inv.supplier_inn, supplierName: inv.supplier });
        if (!r.onec_guid || r.onec_guid === it.onec_guid || r.confidence <= conf) continue;
        await invoiceRepo.updateItemMapping(it.id, r.onec_guid, r.mapped_name, r.confidence);
        const fresh = await invoiceRepo.getItemById(it.id);
        if (fresh) await reconvertStoredItem(fresh, inv, { onecGuid: r.onec_guid, mappedName: r.mapped_name });
        changed++;
      }
      if (changed) {
        await invoiceRepo.recalculateTotal(id);
        invoicesTouched++;
        lines += changed;
      }
    }
    if (lines) logger.info('Catalog updated: unsent invoices re-mapped', { ownerUserId, invoices: invoicesTouched, lines });
  } catch (err) {
    logger.warn('remapUnsentInvoices failed', { ownerUserId, error: (err as Error).message });
  }
  return { invoices: invoicesTouched, lines };
}
