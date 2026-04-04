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

  // Capture path/method/ua NOW before Express router mounting rewrites req.path
  // inside the res.on('finish') handler.
  const start = Date.now();
  const capturedPath = req.originalUrl || req.path;
  const capturedMethod = req.method;
  const capturedRemoteAddr = (req.headers['x-forwarded-for'] as string | undefined)
    || req.socket.remoteAddress
    || null;
  const capturedUserAgent = (req.headers['user-agent'] as string | undefined) || null;

  res.on('finish', () => {
    try {
      const db = getDb();
      const duration = Date.now() - start;

      db.prepare(
        `INSERT INTO api_requests_log (method, path, remote_addr, user_agent, status_code, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(capturedMethod, capturedPath, capturedRemoteAddr, capturedUserAgent, res.statusCode, duration);

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
