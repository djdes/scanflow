import type { Request, Response, NextFunction } from 'express';
import { getDb } from '../../database/db';

/**
 * Logs every /api/* request to the database for debugging purposes.
 * Lets us diagnose "did client X actually reach the server?" questions
 * without needing SSH access to tail nginx/pm2 logs.
 *
 * Stores: timestamp, method, path, remote address, user-agent, status
 * code, duration. Queryable via GET /api/debug/requests-log (admin).
 *
 * Old entries (>7 days) are periodically cleaned up by a cron-like
 * prune on each insert (delete where timestamp < now - 7 days).
 */
export function apiRequestLog(req: Request, res: Response, next: NextFunction): void {
  // Only log API requests — skip static files, health checks, etc.
  if (!req.path.startsWith('/api/')) {
    next();
    return;
  }

  const start = Date.now();

  res.on('finish', () => {
    try {
      const db = getDb();
      const remoteAddr = (req.headers['x-forwarded-for'] as string | undefined)
        || req.socket.remoteAddress
        || null;
      const userAgent = (req.headers['user-agent'] as string | undefined) || null;
      const duration = Date.now() - start;

      db.prepare(
        `INSERT INTO api_requests_log (method, path, remote_addr, user_agent, status_code, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(req.method, req.path, remoteAddr, userAgent, res.statusCode, duration);

      // Prune old entries (>7 days). Fires on every insert which is fine at
      // current traffic; no perf concern.
      db.prepare(
        `DELETE FROM api_requests_log WHERE timestamp < datetime('now', '-7 days')`
      ).run();
    } catch {
      // Never break the request pipeline on logging failures
    }
  });

  next();
}
