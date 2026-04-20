import { Request, Response, NextFunction } from 'express';
import { config } from '../../config';

// Paths that legitimately need ?key=... because a browser <img>/<a> tag can't
// set custom headers. Keep the whitelist as tight as possible.
const QUERY_KEY_WHITELIST = [
  /^\/api\/invoices\/\d+\/photos\/[^/]+$/,
];

// Most routes REQUIRE the X-API-Key header so the secret never lands in
// nginx access logs, referrers, or browser history. A small whitelist of
// image-serving endpoints also accepts ?key=... for <img> compatibility.
export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const headerKey = req.headers['x-api-key'] as string | undefined;
  const queryKey = typeof req.query.key === 'string' ? req.query.key : undefined;
  const isWhitelisted = QUERY_KEY_WHITELIST.some(rx => rx.test(req.baseUrl + req.path));
  const apiKey = headerKey || (isWhitelisted ? queryKey : undefined);

  if (!apiKey || apiKey !== config.apiKey) {
    res.status(401).json({ error: 'Unauthorized: invalid or missing API key (use X-API-Key header)' });
    return;
  }

  next();
}

/**
 * Variant of apiKeyAuth that also accepts ?key=... — use ONLY for routes that
 * serve binary content to <img>/<a> tags where custom headers can't be added.
 */
export function apiKeyAuthQueryAllowed(req: Request, res: Response, next: NextFunction): void {
  const apiKey = (req.headers['x-api-key'] as string) || (req.query.key as string);

  if (!apiKey || apiKey !== config.apiKey) {
    res.status(401).json({ error: 'Unauthorized: invalid or missing API key' });
    return;
  }

  next();
}
