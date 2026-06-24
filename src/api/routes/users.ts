/**
 * Admin user management. Mounted at /api/users behind apiKeyAuth + requireAdmin
 * (see server.ts), so every handler here is admin-only.
 */
import { Router, Request, Response } from 'express';
import { userRepo } from '../../database/repositories/userRepo';
import { logger } from '../../utils/logger';

const router = Router();

const ALLOWED_ROLES = new Set(['admin', 'user']);

// GET /api/users — list users (safe fields only; no password_hash / api_key).
router.get('/', async (_req: Request, res: Response) => {
  const users = await userRepo.listAll();
  res.json({ data: users });
});

// PATCH /api/users/:id/role — change a user's role.
router.patch('/:id/role', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'invalid user id' });
    return;
  }
  const role = (req.body as { role?: string })?.role;
  if (!role || !ALLOWED_ROLES.has(role)) {
    res.status(400).json({ error: 'role must be "admin" or "user"' });
    return;
  }

  const target = await userRepo.findById(id);
  if (!target) {
    res.status(404).json({ error: 'user not found' });
    return;
  }
  if (target.role === role) {
    res.json({ data: { id, role } }); // no-op
    return;
  }

  // Never demote the last admin — that would lock everyone out of the
  // admin-only platform config (settings/sber/webhook/debug + this endpoint).
  if (target.role === 'admin' && role !== 'admin') {
    const admins = await userRepo.countAdmins();
    if (admins <= 1) {
      res.status(400).json({ error: 'Нельзя снять роль с последнего администратора' });
      return;
    }
  }

  await userRepo.setRole(id, role);
  logger.info('User role changed', { actorId: req.user?.id, targetId: id, from: target.role, to: role });
  res.json({ data: { id, role } });
});

export default router;
