import path from 'path';
import { getDb } from '../db';

/**
 * Эталоны (п.17 пакета v2): флаг invoices.golden и журнал прогонов golden_runs.
 * Схема — миграция 71.
 *
 * Сами накладные этот репозиторий читает, но пишет в invoices ТОЛЬКО флаг
 * golden/golden_at: прогон эталонов не имеет права менять данные накладной.
 */

export type GoldenRunStatus = 'running' | 'done' | 'error';

export interface GoldenRunRow {
  id: number;
  owner_user_id: number | null;
  started_by: number | null;
  started_at: string;
  finished_at: string | null;
  status: GoldenRunStatus;
  model: string | null;
  /** JSON (GoldenRunSummary). */
  summary: string | null;
  /** JSON (GoldenInvoiceResult[]). */
  results: string | null;
}

export type GoldenRunListRow = Omit<GoldenRunRow, 'results'>;

/** Сколько эталонов гоняется за один прогон максимум (каждый — вызов Claude на минуты). */
export const GOLDEN_RUN_MAX_INVOICES = 50;

const clampLimit = (n: number): number =>
  Math.max(1, Math.min(GOLDEN_RUN_MAX_INVOICES, Math.floor(Number.isFinite(n) ? n : 1)));

export const goldenRepo = {
  /**
   * Отметить/снять «эталон». golden_at — когда отметили впервые: повторная
   * отметка дату не сдвигает, снятие её обнуляет.
   */
  async setGolden(invoiceId: number, golden: boolean): Promise<void> {
    await getDb().prepare(
      golden
        ? 'UPDATE invoices SET golden = 1, golden_at = COALESCE(golden_at, NOW()) WHERE id = ?'
        : 'UPDATE invoices SET golden = 0, golden_at = NULL WHERE id = ?',
    ).run(invoiceId);
  },

  async getGoldenState(invoiceId: number): Promise<{ golden: boolean; golden_at: string | null } | undefined> {
    const row = await getDb()
      .prepare('SELECT golden, golden_at FROM invoices WHERE id = ?')
      .get<{ golden: number | null; golden_at: string | null }>(invoiceId);
    return row ? { golden: Number(row.golden) === 1, golden_at: row.golden_at ?? null } : undefined;
  },

  async countGolden(ownerUserId: number): Promise<number> {
    const row = await getDb()
      .prepare('SELECT COUNT(*) AS c FROM invoices WHERE golden = 1 AND owner_user_id = ?')
      .get<{ c: number }>(ownerUserId);
    return Number(row?.c ?? 0);
  },

  /**
   * Какие эталоны гнать: только свои (owner_user_id) и только golden = 1 —
   * чужой id из тела запроса молча отбрасывается (правило 19). Порядок по id
   * стабилен, чтобы прогоны с одним limit сравнивались на одном наборе.
   * invoiceIds: undefined/null — все эталоны; пустой массив — ничего.
   */
  async listGoldenInvoiceIds(
    ownerUserId: number,
    opts: { limit: number; invoiceIds?: number[] | null },
  ): Promise<number[]> {
    const where = ['golden = 1', 'owner_user_id = ?'];
    const params: unknown[] = [ownerUserId];
    if (opts.invoiceIds != null) {
      const ids = [...new Set(opts.invoiceIds.filter(n => Number.isInteger(n) && n > 0))];
      if (ids.length === 0) return [];
      where.push(`id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }
    const rows = await getDb()
      .prepare(`SELECT id FROM invoices WHERE ${where.join(' AND ')} ORDER BY id LIMIT ${clampLimit(opts.limit)}`)
      .all<{ id: number }>(...params);
    return rows.map(r => Number(r.id));
  },

  /**
   * Имена файлов фото всех эталонов (всех компаний) — их не трогает очистка
   * фото через 90 дней. file_name многостраничной накладной — список через
   * запятую; basename(file_path) добавляется на случай, если файл лежит под
   * именем из file_path.
   */
  async listGoldenFileNames(): Promise<string[]> {
    const rows = await getDb()
      .prepare('SELECT file_name, file_path FROM invoices WHERE golden = 1')
      .all<{ file_name: string | null; file_path: string | null }>();
    const names = new Set<string>();
    for (const r of rows) {
      for (const n of (r.file_name ?? '').split(',')) {
        const t = n.trim();
        if (t) names.add(path.basename(t));
      }
      if (r.file_path) names.add(path.basename(r.file_path));
    }
    return [...names];
  },

  async createRun(data: {
    ownerUserId: number | null;
    startedBy: number | null;
    model: string | null;
    summary: unknown;
  }): Promise<number> {
    const r = await getDb()
      .prepare(`INSERT INTO golden_runs (owner_user_id, started_by, status, model, summary) VALUES (?, ?, 'running', ?, ?)`)
      .run(data.ownerUserId, data.startedBy, data.model, JSON.stringify(data.summary));
    return Number(r.lastInsertRowid);
  },

  /** Промежуточный результат — UI видит прогресс, пока прогон идёт. */
  async saveProgress(runId: number, summary: unknown, results: unknown): Promise<void> {
    await getDb()
      .prepare(`UPDATE golden_runs SET summary = ?, results = ? WHERE id = ? AND status = 'running'`)
      .run(JSON.stringify(summary), JSON.stringify(results), runId);
  },

  async finishRun(
    runId: number,
    status: Exclude<GoldenRunStatus, 'running'>,
    summary: unknown,
    results: unknown,
  ): Promise<void> {
    await getDb()
      .prepare('UPDATE golden_runs SET status = ?, finished_at = NOW(), summary = ?, results = ? WHERE id = ?')
      .run(status, JSON.stringify(summary), JSON.stringify(results), runId);
  },

  /** Все «running» — чтобы найти прогоны, оборванные перезапуском процесса. */
  async listRunning(): Promise<Array<Pick<GoldenRunRow, 'id' | 'summary'>>> {
    return getDb()
      .prepare(`SELECT id, summary FROM golden_runs WHERE status = 'running'`)
      .all<Pick<GoldenRunRow, 'id' | 'summary'>>();
  },

  /** Оборванный прогон: статус error, итог — что успели (results не трогаем). */
  async markInterrupted(runId: number, summary: unknown): Promise<void> {
    await getDb()
      .prepare(`UPDATE golden_runs SET status = 'error', finished_at = NOW(), summary = ? WHERE id = ? AND status = 'running'`)
      .run(JSON.stringify(summary), runId);
  },

  async listRuns(ownerUserId: number, limit = 20): Promise<GoldenRunListRow[]> {
    const lim = Math.max(1, Math.min(100, Math.floor(limit)));
    return getDb()
      .prepare(
        `SELECT id, owner_user_id, started_by, started_at, finished_at, status, model, summary
           FROM golden_runs WHERE owner_user_id = ? ORDER BY id DESC LIMIT ${lim}`,
      )
      .all<GoldenRunListRow>(ownerUserId);
  },

  async getRun(runId: number): Promise<GoldenRunRow | undefined> {
    return getDb().prepare('SELECT * FROM golden_runs WHERE id = ?').get<GoldenRunRow>(runId);
  },
};
