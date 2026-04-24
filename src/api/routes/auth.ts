import { Router, Request, Response } from 'express';
import { userRepo } from '../../database/repositories/userRepo';
import { verifyPassword } from '../../auth/password';
import { logger } from '../../utils/logger';

const router = Router();

// POST /api/auth/login — exchange username/password for the caller's per-user
// API key. The API key remains the real auth mechanism for /api/* routes;
// login is a UX wrapper so users don't have to paste a raw key.
router.post('/login', (req: Request, res: Response) => {
  const { username, password } = (req.body ?? {}) as { username?: string; password?: string };

  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    res.status(400).json({ error: 'username and password are required' });
    return;
  }

  const user = userRepo.findByUsername(username);
  if (!user) {
    res.status(401).json({ error: 'Неверный логин или пароль' });
    return;
  }

  if (!verifyPassword(password, user.password_hash)) {
    res.status(401).json({ error: 'Неверный логин или пароль' });
    return;
  }

  try {
    userRepo.touchLastLogin(user.id);
  } catch (e) {
    logger.warn('Failed to update last_login_at', { userId: user.id, error: (e as Error).message });
  }

  res.json({ apiKey: user.api_key, username: user.username, role: user.role });
});

export default router;
