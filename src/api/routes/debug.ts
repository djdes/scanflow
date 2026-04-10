import { Router, Request, Response } from 'express';
import { getDb } from '../../database/db';
import { backupDatabase } from '../../utils/backup';

const router = Router();

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
