import { Request, Response, NextFunction } from 'express';
import { userRepo } from '../../database/repositories/userRepo';

// Paths that legitimately need ?key=... because a browser <img>/<a> tag can't
// set custom headers. Keep the whitelist as tight as possible.
const QUERY_KEY_WHITELIST = [
  /^\/api\/invoices\/\d+\/photos\/[^/]+$/,
];

// Extend Express request with the authenticated user (so downstream routes
// can read req.user without re-querying the DB).
declare module 'express-serve-static-core' {
  interface Request {
    user?: {
      id: number;
      username: string;
      role: string;
    };
  }
}

function lookupUserByKey(apiKey: string): { id: number; username: string; role: string } | null {
  const user = userRepo.findByApiKey(apiKey);
  if (!user) return null;
  return { id: user.id, username: user.username, role: user.role };
}

// All API keys are now resolved against the `users` table. Most routes REQUIRE
// the X-API-Key header so the secret never lands in nginx access logs,
// referrers, or browser history. A small whitelist of image-serving endpoints
// also accepts ?key=... for <img> compatibility.
export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const headerKey = req.headers['x-api-key'] as string | undefined;
  const queryKey = typeof req.query.key === 'string' ? req.query.key : undefined;
  const isWhitelisted = QUERY_KEY_WHITELIST.some(rx => rx.test(req.baseUrl + req.path));
  const apiKey = headerKey || (isWhitelisted ? queryKey : undefined);

  if (!apiKey) {
    res.status(401).json({ error: 'Unauthorized: invalid or missing API key (use X-API-Key header)' });
    return;
  }

  const user = lookupUserByKey(apiKey);
  if (!user) {
    res.status(401).json({ error: 'Unauthorized: invalid or missing API key (use X-API-Key header)' });
    return;
  }

  req.user = user;
  next();
}

/**
 * Variant of apiKeyAuth that also accepts ?key=... — use ONLY for routes that
 * serve binary content to <img>/<a> tags where custom headers can't be added.
 */
export function apiKeyAuthQueryAllowed(req: Request, res: Response, next: NextFunction): void {
  const apiKey = (req.headers['x-api-key'] as string) || (req.query.key as string);

  if (!apiKey) {
    res.status(401).json({ error: 'Unauthorized: invalid or missing API key' });
    return;
  }

  const user = lookupUserByKey(apiKey);
  if (!user) {
    res.status(401).json({ error: 'Unauthorized: invalid or missing API key' });
    return;
  }

  req.user = user;
  next();
}
