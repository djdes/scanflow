import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from './logger';

const BACKUP_DIR = path.join(path.dirname(config.dbPath), 'backups');
const MAX_BACKUPS = 7; // keep 7 days of backups

/**
 * Verify a file is a real SQLite 3 database.
 * The first 16 bytes of a valid DB are always the literal "SQLite format 3\0"
 * header — if the copy got truncated or the source was corrupted, this will
 * catch it BEFORE we trust the backup for disaster recovery.
 */
export function verifySqliteFile(filePath: string): { ok: boolean; error?: string } {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const header = Buffer.alloc(16);
      const bytesRead = fs.readSync(fd, header, 0, 16, 0);
      if (bytesRead < 16) return { ok: false, error: `file too short (${bytesRead} bytes)` };
      if (header.toString('ascii', 0, 15) !== 'SQLite format 3') {
        return { ok: false, error: 'bad SQLite header' };
      }
      return { ok: true };
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Create a timestamped backup of the SQLite database.
 *
 * Uses fs.copyFileSync which is safe with WAL mode — SQLite continues
 * appending to the WAL while the main db file is copied, and the copy
 * captures a consistent snapshot up to the last checkpoint.
 *
 * Returns the path to the backup file, or null on failure.
 */
export function backupDatabase(): string | null {
  try {
    if (!fs.existsSync(config.dbPath)) {
      logger.warn('Backup skipped: database file does not exist', { path: config.dbPath });
      return null;
    }

    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupPath = path.join(BACKUP_DIR, `database-${timestamp}.sqlite`);

    fs.copyFileSync(config.dbPath, backupPath);

    // Verify the copy is a real SQLite file. If not, delete it immediately —
    // we don't want a corrupt backup to survive cleanup and later be restored
    // in a panic.
    const verdict = verifySqliteFile(backupPath);
    if (!verdict.ok) {
      logger.error('Backup file failed verification, discarding', {
        path: backupPath,
        error: verdict.error,
      });
      try { fs.unlinkSync(backupPath); } catch { /* ignore */ }
      return null;
    }

    const sizeMB = (fs.statSync(backupPath).size / 1024 / 1024).toFixed(2);
    logger.info('Database backup created', { path: backupPath, sizeMB });

    cleanupOldBackups();
    return backupPath;
  } catch (err) {
    logger.error('Database backup failed', { error: (err as Error).message });
    return null;
  }
}

/**
 * Delete backups older than MAX_BACKUPS, keeping newest.
 */
function cleanupOldBackups(): void {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return;

    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('database-') && f.endsWith('.sqlite'))
      .map(f => ({
        name: f,
        path: path.join(BACKUP_DIR, f),
        mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime); // newest first

    const toDelete = files.slice(MAX_BACKUPS);
    for (const f of toDelete) {
      fs.unlinkSync(f.path);
      logger.debug('Old backup deleted', { file: f.name });
    }
  } catch (err) {
    logger.warn('Backup cleanup failed', { error: (err as Error).message });
  }
}
