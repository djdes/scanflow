import { getDb } from '../db';
import { logger } from '../../utils/logger';

/**
 * Снимки шапки накладной (номер, дата, сумма, НДС, поставщик) и строк.
 *
 * Страховка пакета v2 (требование заказчика: «вернуться хотя бы к правильным
 * суммам, НДС и номерам счетов»):
 *   - baseline   — состояние на момент выкладки v2 (миграция 63);
 *   - recognized — пишется при каждом распознавании/перераспознавании,
 *                  до пересчёта единиц и ручных правок.
 * Откат трогает только шапку; строки в снимке — для аудита.
 */
export type SnapshotKind = 'baseline' | 'recognized';

export const RESTORABLE_HEADER_FIELDS = ['invoice_number', 'invoice_date', 'total_sum', 'vat_sum'] as const;
export type RestorableField = typeof RESTORABLE_HEADER_FIELDS[number];

export interface InvoiceSnapshot {
  id: number;
  invoice_id: number;
  kind: SnapshotKind;
  invoice_number: string | null;
  invoice_date: string | null;
  total_sum: number | null;
  vat_sum: number | null;
  supplier: string | null;
  supplier_inn: string | null;
  items_json: string | null;
  created_at: string;
}

type HeaderLike = Partial<Record<RestorableField, string | number | null>>;

/**
 * Что нужно записать в накладную, чтобы шапка совпала со снимком. Пустые
 * значения снимка не затирают текущие; деньги сравниваются с точностью до
 * копейки (DOUBLE даёт хвосты вида 100988.71000000001).
 */
export function headerRestorePatch(
  current: HeaderLike,
  snapshot: HeaderLike,
  fields: readonly RestorableField[] = RESTORABLE_HEADER_FIELDS,
): Partial<Record<RestorableField, string | number>> {
  const patch: Partial<Record<RestorableField, string | number>> = {};
  for (const f of fields) {
    const want = snapshot[f];
    if (want == null || want === '') continue;
    const have = current[f];
    if (f === 'total_sum' || f === 'vat_sum') {
      const w = Number(want);
      if (!isFinite(w)) continue;
      if (have != null && Math.abs(Number(have) - w) < 0.005) continue;
      patch[f] = Math.round(w * 100) / 100;
    } else if (String(have ?? '') !== String(want)) {
      patch[f] = String(want);
    }
  }
  return patch;
}

export const snapshotRepo = {
  /** Снять текущую шапку и строки накладной. Никогда не бросает — снимок не должен ломать конвейер. */
  async record(invoiceId: number, kind: SnapshotKind): Promise<void> {
    try {
      const db = getDb();
      const inv = await db.prepare(
        'SELECT id, invoice_number, invoice_date, total_sum, vat_sum, supplier, supplier_inn FROM invoices WHERE id = ?',
      ).get<{ id: number; invoice_number: string | null; invoice_date: string | null; total_sum: number | null; vat_sum: number | null; supplier: string | null; supplier_inn: string | null }>(invoiceId);
      if (!inv) return;
      const items = await db.prepare(
        'SELECT id, original_name, mapped_name, quantity, unit, price, total, vat_rate, onec_guid, row_no FROM invoice_items WHERE invoice_id = ? ORDER BY id',
      ).all(invoiceId);
      await db.prepare(`
        INSERT INTO invoice_snapshots (invoice_id, kind, invoice_number, invoice_date, total_sum, vat_sum, supplier, supplier_inn, items_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(invoiceId, kind, inv.invoice_number, inv.invoice_date, inv.total_sum, inv.vat_sum,
        inv.supplier, inv.supplier_inn ? String(inv.supplier_inn).slice(0, 12) : null, JSON.stringify(items));
    } catch (err) {
      logger.warn('snapshotRepo.record failed', { invoiceId, kind, error: (err as Error).message });
    }
  },

  async latest(invoiceId: number, kind: SnapshotKind): Promise<InvoiceSnapshot | null> {
    const row = await getDb().prepare(
      'SELECT * FROM invoice_snapshots WHERE invoice_id = ? AND kind = ? ORDER BY id DESC LIMIT 1',
    ).get<InvoiceSnapshot>(invoiceId, kind);
    return row ?? null;
  },

  /** Для вкладки «История»: без строк (они бывают большими). */
  async list(invoiceId: number): Promise<Array<Omit<InvoiceSnapshot, 'items_json'>>> {
    return getDb().prepare(`
      SELECT id, invoice_id, kind, invoice_number, invoice_date, total_sum, vat_sum, supplier, supplier_inn, created_at
        FROM invoice_snapshots WHERE invoice_id = ? ORDER BY id DESC LIMIT 50
    `).all(invoiceId);
  },

  /** Записать поля шапки. Только номер/дата/сумма/НДС — белый список, не из тела запроса. */
  async applyHeaderPatch(invoiceId: number, patch: Partial<Record<RestorableField, string | number>>): Promise<void> {
    const keys = RESTORABLE_HEADER_FIELDS.filter(k => patch[k] !== undefined);
    if (!keys.length) return;
    await getDb()
      .prepare(`UPDATE invoices SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map(k => patch[k]), invoiceId);
  },
};
