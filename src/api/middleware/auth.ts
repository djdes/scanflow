import { Request, Response, NextFunction } from 'express';
import { logger } from '../../utils/logger';
import { userRepo } from '../../database/repositories/userRepo';

// Paths that legitimately need ?key=... because a browser <img>/<iframe>/<a> tag
// cannot set custom headers. Keep the whitelist tight.
const QUERY_KEY_WHITELIST = [
  /^\/api\/invoices\/\d+\/photos\/[^/]+$/,
  /^\/api\/invoices\/\d+\/review\/image\/[^/]+$/,
];

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: {
        id: number;
        username: string;
        role: 'admin' | 'user';
        is_superadmin?: boolean;
        email?: string | null;
        tariff_plan?: string;
        tariff_limit?: number | null;
        tariff_expires_at?: string | null;
      };
    }
  }
}

/**
 * Resolve the request's API key against the `users` table. The DB is the only
 * authority: the first-run bootstrap (`seedAdminUser`) ensures `admin` exists
 * with `api_key = config.apiKey` so existing 1C / webhook / mobile-camera
 * callers keep working without any fallback to `.env`.
 */
export async function apiKeyAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const headerKey = req.headers['x-api-key'] as string | undefined;
  const rawQueryKey = (typeof req.query.key === 'string' ? req.query.key : undefined)
    || (typeof req.query.api_key === 'string' ? req.query.api_key : undefined);
  const fullPath = (req.baseUrl || '') + (req.path || '');
  const isWhitelisted = QUERY_KEY_WHITELIST.some(rx => rx.test(fullPath));
  const providedKey = headerKey || (isWhitelisted || req.query.api_key ? rawQueryKey : undefined);

  if (!providedKey) {
    logger.warn('Unauthorized API access attempt (no key)', { ip: req.ip, path: req.path });
    res.status(401).json({ error: 'Invalid or missing API key' });
    return;
  }

  const user = await userRepo.findByApiKey(providedKey);
  if (user) {
    if (user.is_blocked) {
      logger.warn('Blocked user attempted API access', { userId: user.id, username: user.username, path: req.path });
      res.status(403).json({ error: 'Доступ к аккаунту приостановлен администратором' });
      return;
    }
    req.user = {
      id: user.id,
      username: user.username,
      role: (user.role === 'admin' || user.is_superadmin ? 'admin' : 'user'),
      is_superadmin: Boolean(user.is_superadmin),
      email: user.email,
      tariff_plan: user.tariff_plan,
      tariff_limit: user.tariff_limit,
      tariff_expires_at: user.tariff_expires_at,
    };
    next();
    return;
  }

  logger.warn('Unauthorized API access attempt', { ip: req.ip, path: req.path });
  res.status(401).json({ error: 'Invalid or missing API key' });
}

/**
 * Gate routes that change global system behaviour (OCR engine/prompts, 1C sync
 * config, raw file upload, user management) behind `role = 'admin'`.
 * Must run AFTER `apiKeyAuth`.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin' && !req.user?.is_superadmin) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}

/**
 * Variant of apiKeyAuth that also accepts ?key=... — use ONLY for routes that
 * serve binary content to <img>/<a> tags where custom headers can't be added.
 */
export async function apiKeyAuthQueryAllowed(req: Request, res: Response, next: NextFunction): Promise<void> {
  const providedKey = (req.headers['x-api-key'] as string | undefined)
    || (typeof req.query.key === 'string' ? req.query.key : undefined)
    || (typeof req.query.api_key === 'string' ? req.query.api_key : undefined);

  if (!providedKey) {
    res.status(401).json({ error: 'Invalid or missing API key' });
    return;
  }

  const user = await userRepo.findByApiKey(providedKey);
  if (!user) {
    res.status(401).json({ error: 'Invalid or missing API key' });
    return;
  }
  if (user.is_blocked) {
    res.status(403).json({ error: 'Доступ к аккаунту приостановлен администратором' });
    return;
  }

  req.user = {
    id: user.id,
    username: user.username,
    role: (user.role === 'admin' || user.is_superadmin ? 'admin' : 'user'),
    is_superadmin: Boolean(user.is_superadmin),
    email: user.email,
    tariff_plan: user.tariff_plan,
    tariff_limit: user.tariff_limit,
    tariff_expires_at: user.tariff_expires_at,
  };
  next();
}
