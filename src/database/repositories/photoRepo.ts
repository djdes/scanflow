import path from 'path';
import { getDb } from '../db';

/** Имена файлов из invoices.file_name (страницы через запятую) и file_path. */
function collectNames(rows: Array<{ file_name: string | null; file_path: string | null }>): string[] {
  const names = new Set<string>();
  for (const r of rows) {
    for (const n of (r.file_name ?? '').split(',')) {
      const t = n.trim();
      if (t) names.add(path.basename(t));
    }
    if (r.file_path) names.add(path.basename(r.file_path));
  }
  return [...names];
}

export const photoRepo = {
  /**
   * Фото, которые нельзя удалять по сроку: накладная ещё не ушла в 1С (без
   * фото её не перепроверить и не перераспознать) или ушла меньше
   * `keepAfterSentDays` дней назад. Дубли не защищаются — их фото есть у оригинала.
   */
  async listNotYetExpiredFileNames(keepAfterSentDays: number): Promise<string[]> {
    const days = Math.max(0, Math.trunc(keepAfterSentDays));
    const rows = await getDb().prepare(`
      SELECT file_name, file_path FROM invoices
       WHERE duplicate_of IS NULL
         AND (sent_at IS NULL OR sent_at >= (NOW() - INTERVAL ${days} DAY))
    `).all<{ file_name: string | null; file_path: string | null }>();
    return collectNames(rows);
  },
};
