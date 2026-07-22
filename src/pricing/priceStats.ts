import { getDb } from '../database/db';
import { logger } from '../utils/logger';
import { medianOf } from './medianOf';

const HISTORY_LIMIT = 10;
const MIN_SAMPLES = 3;

export interface PriceStats {
  onec_guid: string;
  median_price: number;
  price_unit: string;
  samples: number;
}

interface ItemRow {
  price: number;
  unit: string;
}

/**
 * Recompute median price over the most recent {@link HISTORY_LIMIT}
 * invoice_items for a single 1С GUID and UPSERT into
 * `nomenclature_price_stat_cards` for that company. If fewer than {@link MIN_SAMPLES} valid
 * samples exist (or none) the row is DELETEd so callers never see stale
 * data. Returns the computed stats or null on insufficient samples.
 *
 * Safe to call repeatedly — UPSERT via PRIMARY KEY conflict.
 */
export async function recomputeMedianForGuid(guid: string, ownerUserId: number): Promise<PriceStats | null> {
  if (!guid) return null;
  const db = getDb();

  // Выборка ограничена накладными ЭТОЙ компании: медиана цены — коммерческий
  // показатель, и считать её по чужим закупкам нельзя ни с точки зрения
  // корректности, ни с точки зрения конфиденциальности.
  const rows = await db.prepare(
    `SELECT ii.price, ii.unit
     FROM invoice_items ii
     JOIN invoices i ON i.id = ii.invoice_id
     WHERE ii.onec_guid = ?
       AND i.owner_user_id = ?
       AND ii.price > 0
       AND ii.unit IS NOT NULL AND ii.unit != ''
     ORDER BY i.invoice_date DESC, ii.id DESC
     LIMIT ${HISTORY_LIMIT}`,
  ).all<ItemRow>(guid, ownerUserId);

  const dropStat = async (): Promise<void> => {
    await db
      .prepare('DELETE FROM nomenclature_price_stat_cards WHERE onec_guid = ? AND owner_user_id = ?')
      .run(guid, ownerUserId);
  };

  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.unit, (counts.get(r.unit) ?? 0) + 1);
  if (counts.size === 0) {
    await dropStat();
    return null;
  }
  let chosenUnit = rows[0].unit;
  let chosenCount = counts.get(chosenUnit)!;
  for (const [u, c] of counts) {
    if (c > chosenCount) { chosenUnit = u; chosenCount = c; }
  }

  const prices = rows.filter(r => r.unit === chosenUnit).map(r => r.price);
  if (prices.length < MIN_SAMPLES) {
    await dropStat();
    return null;
  }

  const median = medianOf(prices);
  if (median === null) {
    await dropStat();
    return null;
  }

  await db.prepare(
    `INSERT INTO nomenclature_price_stat_cards (owner_user_id, onec_guid, median_price, price_unit, samples, updated_at)
     VALUES (?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       median_price = VALUES(median_price),
       price_unit   = VALUES(price_unit),
       samples      = VALUES(samples),
       updated_at   = NOW()`,
  ).run(ownerUserId, guid, median, chosenUnit, prices.length);

  return { onec_guid: guid, median_price: median, price_unit: chosenUnit, samples: prices.length };
}

/**
 * Batch helper: dedupe + filter + run sequentially. Swallows individual
 * errors so one bad GUID can't break the rest of the batch (used in
 * fire-and-forget hooks where the parent operation already succeeded).
 */
export async function recomputeMedianForGuids(
  guids: Array<string | null | undefined>,
  ownerUserId: number,
): Promise<void> {
  const unique = Array.from(new Set(guids.filter((g): g is string => typeof g === 'string' && g.length > 0)));
  for (const guid of unique) {
    try {
      await recomputeMedianForGuid(guid, ownerUserId);
    } catch (err) {
      logger.warn('priceStats: recompute failed', { guid, error: (err as Error).message });
    }
  }
}

/**
 * One-time backfill called from migration 24. Walks every distinct
 * onec_guid in invoice_items and rebuilds price_stats. Idempotent.
 */
export async function backfillAllStats(): Promise<{ scanned: number; written: number }> {
  // Проходим по парам (компания, guid): статистика пер-тенантная, поэтому одна
  // и та же позиция каталога считается отдельно для каждой компании.
  const rows = await getDb().prepare(
    `SELECT DISTINCT i.owner_user_id, ii.onec_guid
       FROM invoice_items ii
       JOIN invoices i ON i.id = ii.invoice_id
      WHERE ii.onec_guid IS NOT NULL AND ii.onec_guid != ''
        AND i.owner_user_id IS NOT NULL`,
  ).all<{ owner_user_id: number; onec_guid: string }>();
  let scanned = 0;
  let written = 0;
  for (const { owner_user_id, onec_guid } of rows) {
    try {
      const result = await recomputeMedianForGuid(onec_guid, owner_user_id);
      scanned++;
      if (result) written++;
    } catch (err) {
      logger.warn('priceStats: backfill recompute failed', { guid: onec_guid, error: (err as Error).message });
    }
  }
  logger.info('priceStats: backfill complete', { scanned, written });
  return { scanned, written };
}
