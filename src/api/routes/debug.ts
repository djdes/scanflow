import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { getDb } from '../../database/db';
import { backupDatabase } from '../../utils/backup';
import { config } from '../../config';
import { logger } from '../../utils/logger';

const router = Router();

// GET /api/debug/errors — last 10 invoices with status='error' (diagnostic)
router.get('/errors', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, file_name, error_message, created_at
     FROM invoices WHERE status = 'error'
     ORDER BY id DESC LIMIT 10`
  ).all();
  res.json({ data: rows });
});

// POST /api/debug/reprocess-errors — move failed files back to inbox for re-processing
router.post('/reprocess-errors', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, file_name FROM invoices WHERE status = 'error' ORDER BY id DESC LIMIT 10`
  ).all() as Array<{ id: number; file_name: string }>;

  const results: Array<{ id: number; file: string; status: string }> = [];
  for (const row of rows) {
    const fileName = path.basename(row.file_name);
    const failedPath = path.join(config.failedDir, fileName);
    const processedPath = path.join(config.processedDir, fileName);
    const inboxPath = path.join(config.inboxDir, fileName);

    let source: string | null = null;
    if (fs.existsSync(failedPath)) source = failedPath;
    else if (fs.existsSync(processedPath)) source = processedPath;

    if (!source) {
      results.push({ id: row.id, file: fileName, status: 'file_not_found' });
      continue;
    }

    try {
      db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(row.id);
      db.prepare('DELETE FROM invoices WHERE id = ?').run(row.id);
      fs.renameSync(source, inboxPath);
      results.push({ id: row.id, file: fileName, status: 'moved_to_inbox' });
    } catch (e) {
      results.push({ id: row.id, file: fileName, status: 'error: ' + (e as Error).message });
      logger.warn('reprocess-errors: failed to requeue', { id: row.id, error: (e as Error).message });
    }
  }
  res.json({ data: results });
});

// POST /api/debug/backup — trigger manual database backup
router.post('/backup', (_req: Request, res: Response) => {
  const backupPath = backupDatabase();
  if (backupPath) {
    res.json({ success: true, path: backupPath });
  } else {
    res.status(500).json({ success: false, error: 'Backup failed, check server logs' });
  }
});

// GET /api/debug/requests-log?limit=50&path_like=%invoices%
// Returns recent API request log entries (most recent first).
// Used for diagnosing connectivity issues with 1C and other clients.
router.get('/requests-log', (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
  const pathLike = req.query.path_like as string | undefined;
  const sinceMinutes = req.query.since_minutes ? parseInt(req.query.since_minutes as string) : null;

  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (pathLike) {
    conditions.push('path LIKE ?');
    params.push(pathLike);
  }
  if (sinceMinutes !== null && !isNaN(sinceMinutes)) {
    conditions.push(`timestamp > datetime('now', '-${sinceMinutes} minutes')`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = db.prepare(
    `SELECT id, timestamp, method, path, remote_addr, user_agent, status_code, duration_ms
     FROM api_requests_log
     ${where}
     ORDER BY id DESC
     LIMIT ?`
  ).all(...params, limit);

  res.json({ data: rows, count: rows.length });
});

export default router;
