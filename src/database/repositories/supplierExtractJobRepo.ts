import { getDb } from '../db';

export interface SupplierExtractJob {
  id: number;
  token: string;
  task_id: string | null;
  status: 'processing' | 'done' | 'error';
  file_name: string;
  file_path: string;
  content_type: string;
  result_json: string | null;
  error: string | null;
  created_at: string;
}

export interface CreateSupplierExtractJob {
  token: string;
  file_name: string;
  file_path: string;
  content_type: string;
}

export const supplierExtractJobRepo = {
  async create(data: CreateSupplierExtractJob): Promise<number> {
    const result = await getDb().prepare(
      `INSERT INTO supplier_extract_jobs (token, file_name, file_path, content_type, status)
       VALUES (:token, :file_name, :file_path, :content_type, 'processing')`
    ).run({
      token: data.token,
      file_name: data.file_name,
      file_path: data.file_path,
      content_type: data.content_type,
    });
    return Number(result.lastInsertRowid);
  },

  async getById(id: number): Promise<SupplierExtractJob | undefined> {
    return getDb()
      .prepare('SELECT * FROM supplier_extract_jobs WHERE id = ?')
      .get<SupplierExtractJob>(id);
  },

  async setTaskId(id: number, taskId: string): Promise<void> {
    await getDb().prepare('UPDATE supplier_extract_jobs SET task_id = ? WHERE id = ?').run(taskId, id);
  },

  async setResult(id: number, resultJson: string): Promise<void> {
    await getDb()
      .prepare(`UPDATE supplier_extract_jobs SET status = 'done', result_json = ?, error = NULL WHERE id = ?`)
      .run(resultJson, id);
  },

  async setError(id: number, message: string): Promise<void> {
    await getDb()
      .prepare(`UPDATE supplier_extract_jobs SET status = 'error', error = ? WHERE id = ?`)
      .run(message.slice(0, 1000), id);
  },

  /** Mark jobs stuck in 'processing' longer than N minutes as error. Returns count. */
  async markStaleAsFailed(staleMinutes: number = 15): Promise<number> {
    const result = await getDb().prepare(
      `UPDATE supplier_extract_jobs
         SET status = 'error',
             error = COALESCE(error, ?)
       WHERE status = 'processing'
         AND created_at < (NOW() - INTERVAL ${Math.floor(staleMinutes)} MINUTE)`
    ).run(`Dispatcher timeout (>${Math.floor(staleMinutes)} min, callback never arrived)`);
    return result.changes;
  },
};
