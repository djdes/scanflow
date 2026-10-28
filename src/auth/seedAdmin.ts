import { randomBytes } from 'crypto';
import { config } from '../config';
import { logger } from '../utils/logger';
import { userRepo } from '../database/repositories/userRepo';
import { hashPassword } from './password';

const DEFAULT_ADMIN_USERNAME = 'admin';
export const ROOT_SUPERADMIN_EMAIL = 'admin@scanflow.ru';

/**
 * First-run admin & root superadmin bootstrap. Runs at server startup.
 *
 * - If the users table is empty, creates `admin` (bound to `admin@scanflow.ru`)
 *   with `role = 'admin'`, `is_superadmin = 1`, and `api_key = config.apiKey`.
 * - Ensures the root superadmin account `admin@scanflow.ru` exists and has
 *   `role = 'admin'` and `is_superadmin = 1`.
 */
export async function seedAdminUser(): Promise<void> {
  if ((await userRepo.count()) === 0) {
    if (!config.apiKey || config.apiKey === 'your-secret-api-key') {
      logger.warn(
        'seedAdminUser: API_KEY in .env is empty or a placeholder. Admin will be created but the api_key will be unsafe — rotate it before exposing this server.',
      );
    }

    const password = generateInitialPassword();
    await userRepo.create({
      username: DEFAULT_ADMIN_USERNAME,
      email: ROOT_SUPERADMIN_EMAIL,
      password_hash: hashPassword(password),
      api_key: config.apiKey,
      role: 'admin',
      is_superadmin: true,
      company_name: 'Основная компания (Суперадмин)',
    });

    const banner = '='.repeat(72);
    logger.warn(banner);
    logger.warn('FIRST-RUN ADMIN ACCOUNT CREATED — copy the password NOW, it will not be shown again.');
    logger.warn(`  username: ${DEFAULT_ADMIN_USERNAME} (${ROOT_SUPERADMIN_EMAIL})`);
    logger.warn(`  password: ${password}`);
    logger.warn('To change it later: npm run reset-admin-password');
    logger.warn(banner);
    return;
  }

  await ensureRootSuperadmin();
}

export async function ensureRootSuperadmin(): Promise<void> {
  // 1. Primary `admin` account is always a superadmin.
  const primaryAdmin = await userRepo.findByUsername(DEFAULT_ADMIN_USERNAME);
  if (primaryAdmin && (!primaryAdmin.is_superadmin || primaryAdmin.role !== 'admin')) {
    await userRepo.updateUser(primaryAdmin.id, {
      role: 'admin',
      is_superadmin: true,
      is_blocked: false,
    });
  }

  // 2. Ensure `admin@scanflow.ru` exists and is a root superadmin.
  const byEmail = await userRepo.findByEmail(ROOT_SUPERADMIN_EMAIL);
  const byUsername = await userRepo.findByUsername(ROOT_SUPERADMIN_EMAIL);
  const existingRoot = byEmail ?? byUsername;

  if (existingRoot) {
    const patch: Parameters<typeof userRepo.updateUser>[1] = {};
    if (existingRoot.role !== 'admin') patch.role = 'admin';
    if (!existingRoot.is_superadmin) patch.is_superadmin = true;
    if (existingRoot.is_blocked) patch.is_blocked = false;
    if (!existingRoot.email) patch.email = ROOT_SUPERADMIN_EMAIL;
    if (!existingRoot.api_key) patch.api_key = randomBytes(24).toString('hex');
    if (Object.keys(patch).length > 0) {
      await userRepo.updateUser(existingRoot.id, patch);
      logger.info('Promoted existing admin@scanflow.ru account to root superadmin', {
        id: existingRoot.id,
        username: existingRoot.username,
      });
    }
    return;
  }

  // If primary `admin` has no email yet, bind `admin@scanflow.ru` to it.
  if (primaryAdmin && !primaryAdmin.email) {
    await userRepo.updateUser(primaryAdmin.id, {
      email: ROOT_SUPERADMIN_EMAIL,
      role: 'admin',
      is_superadmin: true,
    });
    logger.info('Bound admin@scanflow.ru to primary admin account', { id: primaryAdmin.id });
    return;
  }

  // Otherwise create `admin@scanflow.ru` as a dedicated root superadmin account.
  const password = generateInitialPassword();
  const apiKey = randomBytes(24).toString('hex');
  const id = await userRepo.create({
    username: ROOT_SUPERADMIN_EMAIL,
    email: ROOT_SUPERADMIN_EMAIL,
    password_hash: hashPassword(password),
    api_key: apiKey,
    role: 'admin',
    is_superadmin: true,
    company_name: 'Суперадмин ScanFlow',
    tariff_plan: 'unlimited',
  });

  const banner = '='.repeat(72);
  logger.warn(banner);
  logger.warn('ROOT SUPERADMIN ACCOUNT CREATED — copy the password NOW:');
  logger.warn(`  id:       ${id}`);
  logger.warn(`  login:    ${ROOT_SUPERADMIN_EMAIL}`);
  logger.warn(`  password: ${password}`);
  logger.warn(banner);
}

function generateInitialPassword(): string {
  return randomBytes(12).toString('base64url');
}
