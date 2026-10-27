import { randomUUID } from 'node:crypto';
import { getDb } from '../db';

export interface RecognitionJob {
  id: number; owner_user_id: number; file_name: string; file_path: string; file_hash: string;
  original_name: string; source: string; user_agent: string | null; force_engine: string | null;
  invoice_id: number | null; state: 'queued' | 'processing' | 'retry' | 'completed' | 'cancelled';
  attempts: number; next_attempt_at: string; last_error: string | null; lease_token: string | null;
  created_at: string; updated_at: string;
}
export type RecognitionInput = Pick<RecognitionJob, 'owner_user_id' | 'file_name' | 'file_path' | 'file_hash' | 'original_name' | 'source' | 'user_agent' | 'force_engine'> & { invoice_id?: number | null };
export const recognitionJobRepo = {
  async enqueue(input: RecognitionInput): Promise<RecognitionJob> {
    await getDb().prepare(`INSERT INTO recognition_jobs
      (owner_user_id, file_name, file_path, file_hash, original_name, source, user_agent, force_engine, invoice_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`)
      .run(input.owner_user_id, input.file_name, input.file_path, input.file_hash, input.original_name.slice(0, 500),
        input.source, input.user_agent, input.force_engine, input.invoice_id ?? null);
    return (await getDb().prepare('SELECT * FROM recognition_jobs WHERE owner_user_id = ? AND file_hash = ?')
      .get<RecognitionJob>(input.owner_user_id, input.file_hash))!;
  },
  async get(id: number, owner: number) {
    return getDb().prepare('SELECT * FROM recognition_jobs WHERE id = ? AND owner_user_id = ?').get<RecognitionJob>(id, owner);
  },
  async receipts(owner: number, ids: number[]) {
    if (!ids.length) return [];
    return getDb().prepare(`SELECT * FROM recognition_jobs WHERE owner_user_id = ? AND id IN (${ids.map(() => '?').join(',')})`).all<RecognitionJob>(owner, ...ids);
  },
  async revive(job: RecognitionJob, input: RecognitionInput) {
    await getDb().prepare(`UPDATE recognition_jobs SET state = 'queued', invoice_id = NULL, file_name = ?, file_path = ?,
      original_name = ?, source = ?, user_agent = ?, force_engine = ?, attempts = 0, next_attempt_at = NOW(), last_error = NULL, completed_at = NULL,
      lease_token = NULL, lease_expires_at = NULL, updated_at = NOW() WHERE id = ? AND owner_user_id = ? AND state IN ('cancelled','completed')`)
      .run(input.file_name, input.file_path, input.original_name.slice(0, 500), input.source, input.user_agent, input.force_engine, job.id, job.owner_user_id);
    return (await this.get(job.id, job.owner_user_id))!;
  },
  async processingInvoice(invoiceId: number, owner: number, hash: string | null) {
    return !!(await getDb().prepare("SELECT id FROM recognition_jobs WHERE owner_user_id = ? AND state = 'processing' AND (invoice_id = ? OR file_hash = ?) LIMIT 1")
      .get(owner, invoiceId, hash));
  },
  async cancelInvoice(invoiceId: number, owner: number, hash: string | null) {
    await getDb().prepare("UPDATE recognition_jobs SET state = 'cancelled', updated_at = NOW() WHERE owner_user_id = ? AND (invoice_id = ? OR file_hash = ?)")
      .run(owner, invoiceId, hash);
  },
  async list(owner: number) {
    const [data, counts] = await Promise.all([
      getDb().prepare("SELECT * FROM recognition_jobs WHERE owner_user_id = ? AND state IN ('queued','processing','retry') ORDER BY id LIMIT 100").all<RecognitionJob>(owner),
      getDb().prepare("SELECT state, COUNT(*) AS count FROM recognition_jobs WHERE owner_user_id = ? AND state IN ('queued','processing','retry') GROUP BY state").all<{ state: string; count: number }>(owner),
    ]);
    return { data, counts, total: counts.reduce((sum, row) => sum + Number(row.count), 0) };
  },
  async claim(onlyXml = false): Promise<RecognitionJob | null> {
    return getDb().transaction(async db => {
      await db.prepare('SELECT id FROM recognition_worker_lease WHERE id = 1 FOR UPDATE').get();
      const held = await db.prepare('SELECT id FROM recognition_worker_lease WHERE id = 1 AND expires_at > NOW() FOR UPDATE').get();
      if (held) return null;
      // Lock the singleton even when its previous lease expired. Only one OCR runs at a time.
      const job = await db.prepare(`SELECT * FROM recognition_jobs
        WHERE ((state IN ('queued','retry') AND next_attempt_at <= NOW())
          OR (state = 'processing' AND lease_expires_at <= NOW()))
          ${onlyXml ? "AND LOWER(file_name) LIKE '%.xml'" : ''}
        ORDER BY next_attempt_at, id LIMIT 1 FOR UPDATE`).get<RecognitionJob>();
      if (!job) return null;
      const token = randomUUID();
      await db.prepare('UPDATE recognition_worker_lease SET token = ?, expires_at = DATE_ADD(NOW(), INTERVAL 5 MINUTE) WHERE id = 1').run(token);
      await db.prepare(`UPDATE recognition_jobs SET state = 'processing', attempts = attempts + 1,
        lease_token = ?, lease_expires_at = DATE_ADD(NOW(), INTERVAL 5 MINUTE), updated_at = NOW() WHERE id = ?`).run(token, job.id);
      return { ...job, state: 'processing', attempts: Number(job.attempts) + 1, lease_token: token };
    });
  },
  async heartbeat(job: RecognitionJob): Promise<boolean> {
    return getDb().transaction(async db => {
      const lease = await db.prepare('UPDATE recognition_worker_lease SET expires_at = DATE_ADD(NOW(), INTERVAL 5 MINUTE) WHERE id = 1 AND token = ?').run(job.lease_token);
      if (!lease.changes) return false;
      return (await db.prepare('UPDATE recognition_jobs SET lease_expires_at = DATE_ADD(NOW(), INTERVAL 5 MINUTE) WHERE id = ? AND state = \'processing\' AND lease_token = ?')
        .run(job.id, job.lease_token)).changes > 0;
    });
  },
  async settle(job: RecognitionJob, result: { invoiceId: number | null; error?: string; delaySeconds?: number }) {
    await getDb().transaction(async db => {
      await db.prepare(`UPDATE recognition_jobs SET state = ?, invoice_id = ?, last_error = ?,
        next_attempt_at = DATE_ADD(NOW(), INTERVAL ? SECOND), lease_token = NULL, lease_expires_at = NULL,
        completed_at = ?, updated_at = NOW() WHERE id = ? AND state = 'processing' AND lease_token = ?`)
        .run(result.error ? 'retry' : 'completed', result.invoiceId, result.error ?? null, result.delaySeconds ?? 0,
          result.error ? null : new Date().toISOString().slice(0, 19).replace('T', ' '), job.id, job.lease_token);
      await db.prepare('UPDATE recognition_worker_lease SET token = NULL, expires_at = NULL WHERE id = 1 AND token = ?').run(job.lease_token);
    });
  },
  async linkInvoice(job: RecognitionJob, id: number) {
    await getDb().prepare('UPDATE recognition_jobs SET invoice_id = ? WHERE id = ? AND state = \'processing\' AND lease_token = ?').run(id, job.id, job.lease_token);
  },
  async retry(id: number, owner: number) {
    return (await getDb().prepare("UPDATE recognition_jobs SET state = 'queued', next_attempt_at = NOW(), updated_at = NOW() WHERE id = ? AND owner_user_id = ? AND state = 'retry'")
      .run(id, owner)).changes > 0;
  },
  async ownsInvoice(id: number) {
    return !!(await getDb().prepare("SELECT id FROM recognition_jobs WHERE invoice_id = ? AND state IN ('queued','processing','retry') LIMIT 1").get(id));
  },
};
