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

async function lookupUserByKey(apiKey: string): Promise<{ id: number; username: string; role: string } | null> {
  const user = await userRepo.findByApiKey(apiKey);
  if (!user) return null;
  return { id: user.id, username: user.username, role: user.role };
}

// All API keys are now resolved against the `users` table. Most routes REQUIRE
// the X-API-Key header so the secret never lands in nginx access logs,
// referrers, or browser history. A small whitelist of image-serving endpoints
// also accepts ?key=... for <img> compatibility.
export async function apiKeyAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const headerKey = req.headers['x-api-key'] as string | undefined;
  const queryKey = typeof req.query.key === 'string' ? req.query.key : undefined;
  const isWhitelisted = QUERY_KEY_WHITELIST.some(rx => rx.test(req.baseUrl + req.path));
  const apiKey = headerKey || (isWhitelisted ? queryKey : undefined);

  if (!apiKey) {
    res.status(401).json({ error: 'Unauthorized: invalid or missing API key (use X-API-Key header)' });
    return;
  }

  const user = await lookupUserByKey(apiKey);
  if (!user) {
    res.status(401).json({ error: 'Unauthorized: invalid or missing API key (use X-API-Key header)' });
    return;
  }

  req.user = user;
  next();
}

/**
 * Authorization guard: require the authenticated user to have the admin role.
 * MUST be mounted AFTER apiKeyAuth (which populates req.user). Used to fence off
 * platform-global config (OCR keys, Sber connection, webhook, debug) from
 * self-registered role='user' accounts in the multi-tenant deployment.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Forbidden: administrator role required' });
    return;
  }
  next();
}

/**
 * Variant of apiKeyAuth that also accepts ?key=... — use ONLY for routes that
 * serve binary content to <img>/<a> tags where custom headers can't be added.
 */
export async function apiKeyAuthQueryAllowed(req: Request, res: Response, next: NextFunction): Promise<void> {
  const apiKey = (req.headers['x-api-key'] as string) || (req.query.key as string);

  if (!apiKey) {
    res.status(401).json({ error: 'Unauthorized: invalid or missing API key' });
    return;
  }

  const user = await lookupUserByKey(apiKey);
  if (!user) {
    res.status(401).json({ error: 'Unauthorized: invalid or missing API key' });
    return;
  }

  req.user = user;
  next();
}
