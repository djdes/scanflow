import { Router, Request, Response } from 'express';
import { userRepo } from '../../database/repositories/userRepo';
import {
  verifyPassword,
  hashPassword,
  generateApiKey,
  generatePassword,
  generateMagicToken,
} from '../../auth/password';
import { sendAuthEmail } from '../../utils/mailer';
import { logger } from '../../utils/logger';

const router = Router();

const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_PASSWORD_LEN = 6;
const MAGIC_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function magicTokenExpiry(): Date {
  return new Date(Date.now() + MAGIC_TOKEN_TTL_MS);
}

// Public origin для magic-ссылки в письме. На проде это https://scanflow.ru
// (берётся из env). Локально fallback на тот же сервер по hostname запроса.
function publicOrigin(req: Request): string {
  return process.env.PUBLIC_ORIGIN || `${req.protocol}://${req.get('host') || 'localhost'}`;
}

// Email local-part → кандидат на username, обрезанный до правил USERNAME_RE.
// Если коллизия (логин занят) — пробуем base, base2, base3, …
async function reserveUsernameFromEmail(email: string): Promise<string> {
  const local = email.split('@')[0] || 'user';
  let base = local.toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (base.length < 3) base = `user${base}`;
  if (base.length > 28) base = base.slice(0, 28);

  if (!(await userRepo.findByUsername(base))) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}${i}`.slice(0, 30);
    if (!(await userRepo.findByUsername(candidate))) return candidate;
  }
  // Космический случай — добавляем random suffix.
  return `${base.slice(0, 22)}_${Math.random().toString(36).slice(2, 8)}`;
}

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

// POST /api/auth/register-email — email-only регистрация. Сервер генерирует
// username (из local-part), временный пароль и magic-token, и отправляет
// письмо с креденшалами + кнопкой «Открыть кабинет». Ответ клиенту НЕ
// содержит api_key — пользователь должен пройти через email, чтобы убедиться
// что адрес рабочий.
router.post('/register-email', async (req: Request, res: Response) => {
  const { email } = (req.body ?? {}) as { email?: string };
  const trimmedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!trimmedEmail || !EMAIL_RE.test(trimmedEmail)) {
    res.status(400).json({ error: 'Укажите корректный email' });
    return;
  }

  const existingByEmail = await userRepo.findByEmail(trimmedEmail);
  if (existingByEmail) {
    // Не раскрываем существование email — отправляем второе письмо с
    // НОВЫМИ магик-токеном и паролем (так же как /recover). Так зумер
    // не упирается в «email уже занят» и не догадывается есть ли
    // акаунт в системе у другого пользователя.
    return sendCredentialsAndRespond(req, res, existingByEmail.id, 'recover', trimmedEmail);
  }

  const username = await reserveUsernameFromEmail(trimmedEmail);
  const tempPassword = generatePassword(12);
  const password_hash = hashPassword(tempPassword);
  const api_key = generateApiKey();
  const magic_token = generateMagicToken();

  let id: number;
  try {
    id = await userRepo.create({
      username,
      password_hash,
      api_key,
      role: 'user',
      email: trimmedEmail,
    });
    await userRepo.setMagicToken(id, magic_token, magicTokenExpiry());
  } catch (e) {
    logger.error('register-email: failed to create user', { error: (e as Error).message });
    res.status(500).json({ error: 'Не удалось создать аккаунт. Попробуйте ещё раз.' });
    return;
  }

  try {
    await sendAuthEmail({
      to: trimmedEmail,
      kind: 'welcome',
      username,
      password: tempPassword,
      magicUrl: `${publicOrigin(req)}/magic/${magic_token}`,
    });
  } catch (e) {
    // Письмо не ушло, но аккаунт уже создан. Отдадим 502 чтобы фронт показал
    // «не смогли отправить, попробуй ещё раз» — пользователь не зависнет в
    // успехе без ключевой части потока.
    logger.error('register-email: sendAuthEmail failed', { error: (e as Error).message, email: trimmedEmail });
    res.status(502).json({ error: 'Не удалось отправить письмо. Попробуйте ещё раз через пару минут.' });
    return;
  }

  logger.info('Email-only registration complete', { id, username, email: trimmedEmail });
  res.status(201).json({ ok: true, email: trimmedEmail });
});

// POST /api/auth/recover — восстановление по email. Всегда отвечаем 200 с
// нейтральным сообщением — чтобы атакующий не мог проверять существование
// email перебором (email enumeration). Внутри: если email есть в БД —
// перегенерим пароль + magic_token и отправим письмо.
router.post('/recover', async (req: Request, res: Response) => {
  const { email } = (req.body ?? {}) as { email?: string };
  const trimmedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!trimmedEmail || !EMAIL_RE.test(trimmedEmail)) {
    res.status(400).json({ error: 'Укажите корректный email' });
    return;
  }

  const user = await userRepo.findByEmail(trimmedEmail);
  if (!user) {
    // Анти-enumeration: тот же ответ что и при успехе, той же таймингом.
    logger.info('recover: email not found, returning neutral 200', { email: trimmedEmail });
    res.status(200).json({ ok: true });
    return;
  }

  return sendCredentialsAndRespond(req, res, user.id, 'recover', trimmedEmail, user.username);
});

// Общий путь: перегенерим пароль/токен, сохраним, отправим письмо, ответим 200.
// Используется и /register-email (при коллизии email), и /recover.
async function sendCredentialsAndRespond(
  req: Request,
  res: Response,
  userId: number,
  kind: 'welcome' | 'recover',
  email: string,
  presetUsername?: string
): Promise<void> {
  const newPassword = generatePassword(12);
  const password_hash = hashPassword(newPassword);
  const magic_token = generateMagicToken();

  try {
    await userRepo.updatePasswordHash(userId, password_hash);
    await userRepo.setMagicToken(userId, magic_token, magicTokenExpiry());
  } catch (e) {
    logger.error('recover: failed to update creds', { userId, error: (e as Error).message });
    res.status(500).json({ error: 'Внутренняя ошибка. Попробуйте позже.' });
    return;
  }

  // Username нужен для письма — если не передан, идём в БД.
  let username = presetUsername;
  if (!username) {
    const u = await userRepo.findByEmail(email);
    username = u?.username || 'user';
  }

  try {
    await sendAuthEmail({
      to: email,
      kind,
      username,
      password: newPassword,
      magicUrl: `${publicOrigin(req)}/magic/${magic_token}`,
    });
  } catch (e) {
    logger.error('recover: sendAuthEmail failed', { userId, error: (e as Error).message });
    // Не палим внутреннюю ошибку юзеру при /recover (anti-enumeration), но
    // и не пишем «ok» в логи — операция реально не завершилась.
    res.status(200).json({ ok: true });
    return;
  }

  logger.info('Recover/re-issue creds sent', { userId, email, kind });
  res.status(200).json({ ok: true });
}

export default router;
