import { randomBytes } from 'crypto';
import { config } from '../config';
import { logger } from '../utils/logger';
import { userRepo } from '../database/repositories/userRepo';
import { hashPassword } from './password';

const DEFAULT_ADMIN_USERNAME = 'admin';

/**
 * First-run admin bootstrap. Runs at server startup.
 *
 * - If at least one user exists, do nothing. The DB is the source of truth
 *   for user accounts; we never overwrite from environment or config.
 * - If the users table is empty, create `admin` with:
 *     - a freshly generated 16-character random password (printed ONCE to
 *       the logs — operator must capture it on first start),
 *     - api_key = config.apiKey, so existing webhooks/1C/mobile-camera that
 *       already hold the .env API_KEY keep working without changes.
 *
 * To rotate the admin password later, run:  npm run reset-admin-password
 */
export function seedAdminUser(): void {
  if (userRepo.count() > 0) return;

  if (!config.apiKey || config.apiKey === 'your-secret-api-key') {
    logger.warn(
      'seedAdminUser: API_KEY in .env is empty or a placeholder. Admin will be created but the api_key will be unsafe — rotate it before exposing this server.',
    );
  }

  const password = generateInitialPassword();
  userRepo.create({
    username: DEFAULT_ADMIN_USERNAME,
    password_hash: hashPassword(password),
    api_key: config.apiKey,
    role: 'admin',
  });

  // Use multiple log lines surrounded by separators so the password is easy
  // to spot in `pm2 logs` and unmistakable. Logged ONCE — never again.
  const banner = '='.repeat(72);
  logger.warn(banner);
  logger.warn('FIRST-RUN ADMIN ACCOUNT CREATED — copy the password NOW, it will not be shown again.');
  logger.warn(`  username: ${DEFAULT_ADMIN_USERNAME}`);
  logger.warn(`  password: ${password}`);
  logger.warn('To change it later: npm run reset-admin-password');
  logger.warn(banner);
}

function generateInitialPassword(): string {
  // 12 bytes → 16 base64url chars, ~96 bits of entropy. Enough that a brute
  // force is impractical even without rate limiting; short enough to copy
  // off a terminal once.
  return randomBytes(12).toString('base64url');
}
