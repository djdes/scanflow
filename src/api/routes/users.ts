import { Router, Request, Response } from 'express';
import { userRepo, UpdateUserFields } from '../../database/repositories/userRepo';
import { setCompanyAllKg, invalidateCompanyUnits } from '../../services/companyUnits';
import { listCompanyHealth } from '../../services/companyHealth';
import { requireAdmin } from '../middleware/auth';
import { hashPassword, generateApiKey, generatePassword } from '../../auth/password';
import { logger } from '../../utils/logger';

const router = Router();

const VALID_ROLES = new Set(['admin', 'user']);
const VALID_TARIFFS = new Set(['beta', 'start', 'pro', 'business', 'unlimited']);

// GET /api/users — list all registered users with management metadata (admin only).
router.get('/', requireAdmin, async (_req: Request, res: Response) => {
  const users = await userRepo.listAll();
  res.json({ data: users });
});

// GET /api/users/companies — company health overview (admin only).
router.get('/companies', requireAdmin, async (_req: Request, res: Response) => {
  const companies = await listCompanyHealth();
  res.json({ data: companies });
});

// POST /api/users — create a new user account directly from admin/superadmin panel.
router.post('/', requireAdmin, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const rawUsername = typeof body.username === 'string' ? body.username.trim() : '';
  const rawEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const rawCompany = typeof body.company_name === 'string' ? body.company_name.trim() : '';
  const rawPassword = typeof body.password === 'string' ? body.password : '';
  const isSuperadmin = Boolean(body.is_superadmin);
  const role = isSuperadmin ? 'admin' : (typeof body.role === 'string' && VALID_ROLES.has(body.role) ? body.role : 'user');
  const tariffPlan = typeof body.tariff_plan === 'string' && VALID_TARIFFS.has(body.tariff_plan) ? body.tariff_plan : 'beta';
  const tariffLimit = body.tariff_limit === null || body.tariff_limit === '' || body.tariff_limit === undefined
    ? null
    : Math.max(0, Math.floor(Number(body.tariff_limit)));
  const tariffExpiresAt = normalizeDateInput(body.tariff_expires_at);
  const unitsAllKg = Boolean(body.units_all_kg);

  if (!rawUsername || rawUsername.length < 2 || rawUsername.length > 64 || /\s/.test(rawUsername)) {
    res.status(400).json({ error: 'Укажите логин (2–64 символа, без пробелов)' });
    return;
  }

  if (await userRepo.findByUsername(rawUsername)) {
    res.status(409).json({ error: 'Пользователь с таким логином уже существует' });
    return;
  }

  if (rawEmail) {
    const byEmail = await userRepo.findByEmail(rawEmail);
    if (byEmail) {
      res.status(409).json({ error: 'Пользователь с таким email уже существует' });
      return;
    }
  }

  if (rawPassword && rawPassword.length < 4) {
    res.status(400).json({ error: 'Пароль должен быть не короче 4 символов' });
    return;
  }

  const finalPassword = rawPassword || generatePassword(12);
  const apiKey = generateApiKey();

  const id = await userRepo.create({
    username: rawUsername,
    email: rawEmail || null,
    company_name: rawCompany || null,
    password_hash: hashPassword(finalPassword),
    api_key: apiKey,
    role,
    is_superadmin: isSuperadmin,
    tariff_plan: tariffPlan,
    tariff_limit: Number.isFinite(tariffLimit) ? tariffLimit : null,
    tariff_expires_at: tariffExpiresAt,
    units_all_kg: unitsAllKg,
  });

  logger.info('Admin created user account', {
    adminId: req.user?.id,
    createdUserId: id,
    username: rawUsername,
    role,
    isSuperadmin,
    tariffPlan,
  });

  const users = await userRepo.listAll();
  const created = users.find((u) => u.id === id);
  res.status(201).json({
    data: created,
    generatedPassword: rawPassword ? undefined : finalPassword,
  });
});

// PATCH /api/users/:id — comprehensive user/account update (credentials, role, access, tariff, settings).
router.patch('/:id', requireAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid user id' });
    return;
  }

  const target = await userRepo.findById(id);
  if (!target) {
    res.status(404).json({ error: 'Пользователь не найден' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const updates: UpdateUserFields = {};

  if (body.username !== undefined) {
    const newUsername = String(body.username).trim();
    if (!newUsername || newUsername.length < 2 || newUsername.length > 64 || /\s/.test(newUsername)) {
      res.status(400).json({ error: 'Логин должен содержать 2–64 символа без пробелов' });
      return;
    }
    if (newUsername.toLowerCase() !== target.username.toLowerCase()) {
      const conflict = await userRepo.findByUsername(newUsername);
      if (conflict && conflict.id !== id) {
        res.status(409).json({ error: 'Этот логин уже занят другим аккаунтом' });
        return;
      }
    }
    updates.username = newUsername;
  }

  if (body.email !== undefined) {
    const newEmail = body.email === null ? '' : String(body.email).trim().toLowerCase();
    if (newEmail) {
      const conflict = await userRepo.findByEmail(newEmail);
      if (conflict && conflict.id !== id) {
        res.status(409).json({ error: 'Этот email уже привязан к другому аккаунту' });
        return;
      }
      updates.email = newEmail;
    } else {
      updates.email = null;
    }
  }

  if (body.company_name !== undefined) {
    const comp = body.company_name === null ? '' : String(body.company_name).trim();
    updates.company_name = comp || null;
  }

  if (body.password !== undefined && body.password !== null && String(body.password) !== '') {
    const pwd = String(body.password);
    if (pwd.length < 4) {
      res.status(400).json({ error: 'Пароль должен быть не короче 4 символов' });
      return;
    }
    updates.password_hash = hashPassword(pwd);
  }

  if (body.is_superadmin !== undefined) {
    const nextSuper = Boolean(body.is_superadmin);
    if (!nextSuper && target.is_superadmin) {
      const superCount = await userRepo.countSuperadmins();
      if (superCount <= 1) {
        res.status(400).json({ error: 'Нельзя снять права суперадмина с единственного суперадмина' });
        return;
      }
    }
    updates.is_superadmin = nextSuper;
    if (nextSuper) {
      updates.role = 'admin';
    }
  }

  if (body.role !== undefined && updates.is_superadmin !== true) {
    const nextRole = String(body.role);
    if (!VALID_ROLES.has(nextRole)) {
      res.status(400).json({ error: 'role must be "admin" or "user"' });
      return;
    }
    const effectiveSuper = updates.is_superadmin !== undefined ? updates.is_superadmin : Boolean(target.is_superadmin);
    if (effectiveSuper && nextRole !== 'admin') {
      res.status(400).json({ error: 'Суперадмин всегда имеет роль администратора' });
      return;
    }
    if (target.role === 'admin' && nextRole !== 'admin') {
      const admins = await userRepo.countAdmins();
      if (admins <= 1) {
        res.status(400).json({ error: 'В системе должен остаться хотя бы один администратор' });
        return;
      }
    }
    updates.role = nextRole;
  }

  if (body.is_blocked !== undefined) {
    const nextBlocked = Boolean(body.is_blocked);
    if (nextBlocked) {
      if (req.user?.id === id) {
        res.status(400).json({ error: 'Нельзя заблокировать собственный аккаунт' });
        return;
      }
      if (target.role === 'admin' && (await userRepo.countAdmins()) <= 1) {
        res.status(400).json({ error: 'Нельзя заблокировать единственного администратора' });
        return;
      }
      if (target.is_superadmin && (await userRepo.countSuperadmins()) <= 1) {
        res.status(400).json({ error: 'Нельзя заблокировать единственного суперадмина' });
        return;
      }
    }
    updates.is_blocked = nextBlocked;
  }

  if (body.tariff_plan !== undefined) {
    const plan = String(body.tariff_plan);
    if (!VALID_TARIFFS.has(plan)) {
      res.status(400).json({ error: 'Некорректный тарифный план' });
      return;
    }
    updates.tariff_plan = plan;
  }

  if (body.tariff_limit !== undefined) {
    if (body.tariff_limit === null || body.tariff_limit === '') {
      updates.tariff_limit = null;
    } else {
      const lim = Math.floor(Number(body.tariff_limit));
      if (!Number.isFinite(lim) || lim < 0) {
        res.status(400).json({ error: 'Лимит страниц должен быть неотрицательным числом' });
        return;
      }
      updates.tariff_limit = lim;
    }
  }

  if (body.tariff_expires_at !== undefined) {
    updates.tariff_expires_at = normalizeDateInput(body.tariff_expires_at);
  }

  if (body.units_all_kg !== undefined) {
    updates.units_all_kg = Boolean(body.units_all_kg);
  }

  if (body.telegram_chat_id !== undefined) {
    const chat = body.telegram_chat_id === null ? '' : String(body.telegram_chat_id).trim();
    updates.telegram_chat_id = chat || null;
  }

  if (body.telegram_bot_token !== undefined) {
    const tok = body.telegram_bot_token === null ? '' : String(body.telegram_bot_token).trim();
    updates.telegram_bot_token = tok || null;
  }

  if (body.sber_purpose_template !== undefined) {
    updates.sber_purpose_template = String(body.sber_purpose_template);
  }

  await userRepo.updateUser(id, updates);
  if (updates.units_all_kg !== undefined) {
    invalidateCompanyUnits(id);
  }
  logger.info('Admin updated user account', {
    adminId: req.user?.id,
    targetUserId: id,
    updatedFields: Object.keys(updates).filter((k) => k !== 'password_hash' && k !== 'telegram_bot_token'),
    passwordChanged: Boolean(updates.password_hash),
  });

  const all = await userRepo.listAll();
  const updated = all.find((u) => u.id === id);
  res.json({ data: updated });
});

// POST /api/users/:id/impersonate — log in as target user (superadmin/admin capability).
router.post('/:id/impersonate', requireAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid user id' });
    return;
  }

  const target = await userRepo.findById(id);
  if (!target) {
    res.status(404).json({ error: 'Пользователь не найден' });
    return;
  }

  let apiKey = target.api_key;
  if (!apiKey) {
    apiKey = generateApiKey();
    await userRepo.updateApiKey(target.id, apiKey);
  }

  logger.info('Admin impersonated user account', {
    adminId: req.user?.id,
    adminUsername: req.user?.username,
    targetUserId: target.id,
    targetUsername: target.username,
  });

  res.json({
    data: {
      id: target.id,
      username: target.username,
      email: target.email,
      role: target.role === 'admin' || target.is_superadmin ? 'admin' : 'user',
      isSuperadmin: Boolean(target.is_superadmin),
      apiKey,
    },
  });
});

// POST /api/users/:id/regenerate-key — rotate target user's API key.
router.post('/:id/regenerate-key', requireAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid user id' });
    return;
  }

  const target = await userRepo.findById(id);
  if (!target) {
    res.status(404).json({ error: 'Пользователь не найден' });
    return;
  }

  const newKey = generateApiKey();
  await userRepo.updateApiKey(id, newKey);
  logger.info('Admin regenerated user API key', { adminId: req.user?.id, targetUserId: id });
  res.json({ data: { id, apiKey: newKey } });
});

// PATCH /api/users/:id/role — promote/demote between `admin` and `user`.
// Refuses to demote the last remaining admin so the system cannot be locked
// out of admin-only routes.
router.patch('/:id/role', requireAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { role } = (req.body ?? {}) as { role?: string };

  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid user id' });
    return;
  }
  if (typeof role !== 'string' || !VALID_ROLES.has(role)) {
    res.status(400).json({ error: 'role must be "admin" or "user"' });
    return;
  }

  const target = await userRepo.findById(id);
  if (!target) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  if (target.role === 'admin' && role !== 'admin') {
    const admins = await userRepo.countAdmins();
    if (admins <= 1) {
      res.status(400).json({ error: 'В системе должен остаться хотя бы один администратор' });
      return;
    }
  }

  await userRepo.setRole(id, role);
  res.json({ data: { id, username: target.username, role } });
});

// PATCH /api/users/:id/units — админ переключает «всё в кг» любой компании
// из раздела «Настройки → Компании». Сама компания меняет это же поле через
// PUT /api/profile (для себя).
router.patch('/:id/units', requireAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { units_all_kg } = (req.body ?? {}) as { units_all_kg?: unknown };
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid user id' });
    return;
  }
  if (typeof units_all_kg !== 'boolean') {
    res.status(400).json({ error: 'units_all_kg must be boolean' });
    return;
  }
  const target = await userRepo.findById(id);
  if (!target) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  await setCompanyAllKg(id, units_all_kg);
  res.json({ data: { id, username: target.username, units_all_kg } });
});

function normalizeDateInput(val: unknown): string | null {
  if (val === null || val === undefined || val === '') return null;
  const s = String(val).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s} 23:59:59`;
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?/.test(s)) {
    return s.replace('T', ' ').slice(0, 19);
  }
  return null;
}

export default router;
