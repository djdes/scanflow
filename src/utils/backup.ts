import { logger } from './logger';

/**
 * Database backups are now handled at the MySQL level (e.g. via `mysqldump`
 * scheduled through cron) — the in-process file-copy strategy that worked for
 * SQLite no longer applies. The functions below are kept as stubs so existing
 * callers (e.g. POST /api/debug/backup, disk-space watcher) continue to compile
 * and behave gracefully without crashing.
 *
 * If you need an in-app trigger again, implement a `mysqldump` shell-out here
 * and pipe the result into `data/backups/`.
 */

/**
 * Stub kept for compatibility — always returns `{ ok: true }` because we no
 * longer ship verifiable SQLite snapshots.
 */
export function verifySqliteFile(_filePath: string): { ok: boolean; error?: string } {
  return { ok: true };
}

/**
 * Stub kept for compatibility with the legacy SQLite backup flow. Returns
 * `null` to signal "no backup taken" so callers (which already handle the
 * null case) treat it as a no-op.
 */
export async function backupDatabase(): Promise<string | null> {
  logger.warn('backupDatabase() is a no-op since the migration to MySQL — use mysqldump');
  return null;
}
