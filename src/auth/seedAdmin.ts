import { config } from '../config';
import { logger } from '../utils/logger';
import { userRepo } from '../database/repositories/userRepo';
import { hashPassword, verifyPassword } from './password';

/**
 * Idempotent admin bootstrap. Runs at server startup.
 *
 * - If no `admin` user exists, creates one with api_key = config.apiKey
 *   (preserves compatibility with existing webhooks/1C/mobile camera that
 *   already hold the .env API_KEY).
 * - If admin exists but ADMIN_PASSWORD in .env no longer matches the stored
 *   hash, rehashes (lets the operator reset the password by editing .env).
 * - If admin exists but config.apiKey was rotated in .env, updates the
 *   stored api_key to match — same rationale as above.
 *
 * Skips silently when ADMIN_PASSWORD is empty (prevents accidentally creating
 * a passwordless admin during a misconfigured deploy).
 */
export function seedAdminUser(): void {
  if (!config.adminPassword) {
    logger.warn('seedAdminUser: ADMIN_PASSWORD is empty in .env — skipping admin seed');
    return;
  }
  if (!config.apiKey || config.apiKey === 'your-secret-api-key') {
    logger.warn('seedAdminUser: API_KEY in .env looks like the default placeholder — set a real key before exposing this server');
  }

  const username = config.adminUsername || 'admin';
  const existing = userRepo.findByUsername(username);

  if (!existing) {
    userRepo.create({
      username,
      password_hash: hashPassword(config.adminPassword),
      api_key: config.apiKey,
      role: 'admin',
    });
    logger.info('seedAdminUser: admin user created', { username });
    return;
  }

  // Sync stored hash with .env password if it changed.
  if (!verifyPassword(config.adminPassword, existing.password_hash)) {
    userRepo.updatePasswordHash(existing.id, hashPassword(config.adminPassword));
    logger.info('seedAdminUser: admin password rehashed from .env', { username });
  }

  // Sync stored api_key with .env (lets you rotate the key without losing
  // login access). Compare by string equality — fine for opaque random tokens.
  if (existing.api_key !== config.apiKey) {
    userRepo.updateApiKey(existing.id, config.apiKey);
    logger.info('seedAdminUser: admin api_key synced from .env', { username });
  }
}
