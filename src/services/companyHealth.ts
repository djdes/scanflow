import { getDb } from '../database/db';
import { QUEUE_SQL } from './queue';
import { sendOwnerAlert } from './ownerAlerts';
import { logger } from '../utils/logger';

/**
 * Состояние компаний (владельцев накладных) — для обзора администратора и
 * сигнала «в 1С ничего не уходит» (дизайн 2026-09-29, пп.2 и 13).
 * Очередь = обработанные, не отправленные в 1С и не одобренные к отправке
 * накладные (не дубли).
 */
export interface CompanyHealth {
  owner_user_id: number;
  username: string | null;
  invoices_total: number;
  invoices_7d: number;
  invoices_30d: number;
  last_upload_at: string | null;
  last_sent_at: string | null;
  sent_7d: number;
  queue_count: number;
  queue_sum: number;
  queue_with_sber_payment: number;
  unmapped_lines_in_queue: number;
  mappings: number;
  catalog_items: number;
  sber_connected: boolean;
}

// Очередь — как на странице «Очередь в 1С»: всё, что не ушло в 1С, включая
// одобренные — если 1С не забирает, они стоят так же.
const QUEUE = QUEUE_SQL;

export async function listCompanyHealth(): Promise<CompanyHealth[]> {
  const db = getDb();
  const rows = await db.prepare(`
    SELECT i.owner_user_id,
           COUNT(*) AS invoices_total,
           SUM(i.created_at >= (NOW() - INTERVAL 7 DAY)) AS invoices_7d,
           SUM(i.created_at >= (NOW() - INTERVAL 30 DAY)) AS invoices_30d,
           MAX(i.created_at) AS last_upload_at,
           MAX(i.sent_at) AS last_sent_at,
           SUM(i.sent_at >= (NOW() - INTERVAL 7 DAY)) AS sent_7d,
           SUM(${QUEUE}) AS queue_count,
           COALESCE(SUM(CASE WHEN ${QUEUE} THEN i.total_sum END), 0) AS queue_sum,
           SUM(CASE WHEN ${QUEUE} AND EXISTS (SELECT 1 FROM sber_payments sp WHERE sp.invoice_id = i.id AND sp.status = 'created') THEN 1 ELSE 0 END) AS queue_with_sber_payment
      FROM invoices i
     WHERE i.owner_user_id IS NOT NULL
     GROUP BY i.owner_user_id
  `).all<Record<string, unknown>>();
  const out: CompanyHealth[] = [];
  for (const r of rows) {
    const owner = Number(r.owner_user_id);
    const user = await db.prepare('SELECT username FROM users WHERE id = ?').get<{ username: string }>(owner);
    const unmapped = await db.prepare(`
      SELECT COUNT(*) AS n FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
       WHERE i.owner_user_id = ? AND ${QUEUE} AND (ii.onec_guid IS NULL OR ii.onec_guid = '')
    `).get<{ n: number }>(owner);
    const maps = await db.prepare('SELECT COUNT(*) AS n FROM nomenclature_mapping_cards WHERE owner_user_id = ?').get<{ n: number }>(owner);
    const cat = await db.prepare('SELECT COUNT(*) AS n FROM onec_nomenclature_cards WHERE owner_user_id = ? AND is_folder = 0').get<{ n: number }>(owner);
    const sber = await db.prepare('SELECT 1 AS x FROM sber_connections WHERE owner_user_id = ?').get(owner);
    out.push({
      owner_user_id: owner,
      username: user?.username ?? null,
      invoices_total: Number(r.invoices_total) || 0,
      invoices_7d: Number(r.invoices_7d) || 0,
      invoices_30d: Number(r.invoices_30d) || 0,
      last_upload_at: (r.last_upload_at as string | null) ?? null,
      last_sent_at: (r.last_sent_at as string | null) ?? null,
      sent_7d: Number(r.sent_7d) || 0,
      queue_count: Number(r.queue_count) || 0,
      queue_sum: Math.round(Number(r.queue_sum) || 0),
      queue_with_sber_payment: Number(r.queue_with_sber_payment) || 0,
      unmapped_lines_in_queue: Number(unmapped?.n) || 0,
      mappings: Number(maps?.n) || 0,
      catalog_items: Number(cat?.n) || 0,
      sber_connected: !!sber,
    });
  }
  return out.sort((a, b) => b.invoices_30d - a.invoices_30d);
}

const rub = (n: number) => `${Math.round(n).toLocaleString('ru-RU')} ₽`;

/** Текст сигнала «в 1С ничего не уходит» или null, если сигналить не о чем. Чистая функция. */
export function onecStallMessage(c: CompanyHealth): string | null {
  // Компания, которая ни разу не отправляла в 1С, 1С не использует — молчим.
  if (!c.last_sent_at) return null;
  if (c.sent_7d > 0 || c.invoices_7d === 0 || c.queue_count === 0) return null;
  const last = String(c.last_sent_at).slice(0, 10).split('-').reverse().join('.');
  return [
    '⚠️ В 1С уже неделю ничего не уходит.',
    `Последняя отправка: ${last}. За 7 дней загружено накладных: ${c.invoices_7d}.`,
    `В очереди ${c.queue_count} на ${rub(c.queue_sum)}`
      + (c.queue_with_sber_payment ? `, по ${c.queue_with_sber_payment} уже созданы платёжки в Сбере.` : '.'),
    'Склад и себестоимость в 1С без них отстают. Очередь: https://scanflow.ru/#/queue',
  ].join('\n');
}

/** Ежедневно: сигнал владельцу, не чаще раза в неделю. Никогда не бросает. */
export async function checkOnecStall(): Promise<number> {
  let sent = 0;
  try {
    for (const c of await listCompanyHealth()) {
      const text = onecStallMessage(c);
      if (!text) continue;
      if (await sendOwnerAlert(c.owner_user_id, 'onec_stalled', text, 24 * 7 - 1)) sent++;
    }
  } catch (err) {
    logger.warn('onec stall check failed', { error: (err as Error).message });
  }
  return sent;
}
