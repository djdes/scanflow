import { Router, Request, Response } from 'express';
import { config } from '../../config';
import { logger } from '../../utils/logger';

const router = Router();

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// POST /api/auth/login — exchange username/password for the server's API key.
// The API key is the single source of auth for all other /api/* routes; login
// is just a UX layer so users don't have to paste a raw key.
router.post('/login', (req: Request, res: Response) => {
  const { username, password } = (req.body ?? {}) as { username?: string; password?: string };

  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    res.status(400).json({ error: 'username and password are required' });
    return;
  }

  if (!config.adminPassword) {
    logger.warn('Login attempted but ADMIN_PASSWORD is not set in .env');
    res.status(503).json({ error: 'Admin login is not configured on the server' });
    return;
  }

  const userOk = safeEqual(username, config.adminUsername);
  const passOk = safeEqual(password, config.adminPassword);

  if (!userOk || !passOk) {
    res.status(401).json({ error: 'Неверный логин или пароль' });
    return;
  }

  res.json({ apiKey: config.apiKey });
});

export default router;
