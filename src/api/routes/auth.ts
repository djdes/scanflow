import { Router, Request, Response } from 'express';
import { userRepo } from '../../database/repositories/userRepo';
import { verifyPassword, hashPassword, generateApiKey } from '../../auth/password';
import { logger } from '../../utils/logger';

const router = Router();

const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_PASSWORD_LEN = 6;

// POST /api/auth/login — exchange username/password for the caller's per-user
// API key. The API key remains the real auth mechanism for /api/* routes;
// login is a UX wrapper so users don't have to paste a raw key.
router.post('/login', async (req: Request, res: Response) => {
  const { username, password } = (req.body ?? {}) as { username?: string; password?: string };

  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    res.status(400).json({ error: 'username and password are required' });
    return;
  }

  const user = await userRepo.findByUsername(username);
  if (!user) {
    res.status(401).json({ error: 'Неверный логин или пароль' });
    return;
  }

  if (!verifyPassword(password, user.password_hash)) {
    res.status(401).json({ error: 'Неверный логин или пароль' });
    return;
  }

  try {
    await userRepo.touchLastLogin(user.id);
  } catch (e) {
    logger.warn('Failed to update last_login_at', { userId: user.id, error: (e as Error).message });
  }

  res.json({ apiKey: user.api_key, username: user.username, role: user.role });
});

// POST /api/auth/register — self-service signup. Creates a `user`-role
// account with a freshly-generated API key и сразу возвращает его клиенту,
// чтобы фронт мог авто-залогинить и провести через #/onboarding wizard.
//
// Rate-limited (общий /api/auth лимитер: 20 запросов / 5 минут per-IP).
router.post('/register', async (req: Request, res: Response) => {
  const { username, password, email } = (req.body ?? {}) as {
    username?: string;
    password?: string;
    email?: string;
  };

  if (typeof username !== 'string' || !USERNAME_RE.test(username.trim())) {
    res.status(400).json({ error: 'Логин: 3–30 символов, латиница, цифры, _' });
    return;
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN) {
    res.status(400).json({ error: `Пароль должен быть не короче ${MIN_PASSWORD_LEN} символов` });
    return;
  }
  const trimmedEmail = typeof email === 'string' ? email.trim() : '';
  if (trimmedEmail && !EMAIL_RE.test(trimmedEmail)) {
    res.status(400).json({ error: 'Email указан в некорректном формате' });
    return;
  }

  const cleanUsername = username.trim();
  const existing = await userRepo.findByUsername(cleanUsername);
  if (existing) {
    res.status(409).json({ error: 'Логин уже занят' });
    return;
  }

  const password_hash = hashPassword(password);
  const api_key = generateApiKey();

  let id: number;
  try {
    id = await userRepo.create({
      username: cleanUsername,
      password_hash,
      api_key,
      role: 'user',
      email: trimmedEmail || null,
    });
  } catch (e) {
    logger.error('Failed to create user during /register', { error: (e as Error).message });
    res.status(500).json({ error: 'Не удалось создать аккаунт. Попробуйте ещё раз.' });
    return;
  }

  logger.info('User registered via /api/auth/register', { id, username: cleanUsername });
  res.status(201).json({ apiKey: api_key, username: cleanUsername, role: 'user' });
});

export default router;
