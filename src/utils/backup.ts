import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { config } from '../config';
import { logger } from './logger';

/**
 * Database backups run `mysqldump` and write a gzipped SQL dump into
 * `data/backups/`. The old in-process SQLite file-copy no longer applies (DB is
 * MySQL/MariaDB now).
 *
 * `mysqldump` must be on PATH (it is on the prod Ubuntu box; override the binary
 * with the MYSQLDUMP_BIN env var if it lives elsewhere). If it's missing or the
 * dump fails, we log loudly and return null so callers treat it as "no backup"
 * rather than crashing — but the failure is visible, not silent.
 */

const BACKUP_DIR = path.resolve(process.cwd(), 'data', 'backups');
const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS) || 14;

/**
 * Legacy stub kept for compatibility — SQLite snapshots no longer exist, so
 * there's nothing to verify.
 */
export function verifySqliteFile(_filePath: string): { ok: boolean; error?: string } {
  return { ok: true };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local timestamp `YYYY-MM-DDTHH-mm-ss` for a stable, sortable filename. */
function stamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/**
 * Run mysqldump and gzip the result into data/backups/. Returns the file path on
 * success, or null if backups can't be taken (missing binary, missing password,
 * dump error). Never throws — callers already handle null.
 */
export async function backupDatabase(): Promise<string | null> {
  if (!config.dbPassword) {
    logger.error('BACKUP SKIPPED: DB_PASSWORD is empty — cannot run mysqldump. No database backup was taken.');
    return null;
  }

  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  } catch (err) {
    logger.error('BACKUP FAILED: cannot create backup dir', { dir: BACKUP_DIR, error: (err as Error).message });
    return null;
  }

  const bin = process.env.MYSQLDUMP_BIN || 'mysqldump';
  const outPath = path.join(BACKUP_DIR, `${config.dbName}-${stamp(new Date())}.sql.gz`);
  const args = [
    `--host=${config.dbHost}`,
    `--port=${config.dbPort}`,
    `--user=${config.dbUser}`,
    '--single-transaction',
    '--quick',
    '--routines',
    '--triggers',
    '--default-character-set=utf8mb4',
    config.dbName,
  ];

  // Password via MYSQL_PWD (not argv) so it never shows in the process list.
  const child = spawn(bin, args, {
    env: { ...process.env, MYSQL_PWD: config.dbPassword },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });

  const spawnFailed = new Promise<never>((_, reject) => {
    child.on('error', (err) => reject(err));
  });
  const exited = new Promise<number>((resolve) => {
    child.on('close', (code) => resolve(code ?? -1));
  });

  const gzip = zlib.createGzip();
  const out = fs.createWriteStream(outPath);

  try {
    // Race the pipeline against a spawn-time failure (e.g. ENOENT: mysqldump not
    // installed) so we don't hang waiting on a stream that will never flow.
    await Promise.race([
      pipeline(child.stdout, gzip, out),
      spawnFailed,
    ]);
    const code = await exited;
    if (code !== 0) {
      logger.error('BACKUP FAILED: mysqldump exited non-zero', { code, stderr: stderr.slice(0, 500) });
      fs.promises.unlink(outPath).catch(() => { /* best-effort */ });
      return null;
    }
  } catch (err) {
    const msg = (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? `mysqldump binary not found ('${bin}'). Install a MySQL client or set MYSQLDUMP_BIN.`
      : (err as Error).message;
    logger.error('BACKUP FAILED: mysqldump could not run — NO database backup was taken', { error: msg, stderr: stderr.slice(0, 500) });
    fs.promises.unlink(outPath).catch(() => { /* best-effort */ });
    return null;
  }

  let bytes = 0;
  try { bytes = fs.statSync(outPath).size; } catch { /* ignore */ }
  logger.info('Database backup written', { path: outPath, bytes });

  pruneOldBackups();
  return outPath;
}

/** Delete gzipped dumps older than RETENTION_DAYS. Best-effort, never throws. */
function pruneOldBackups(): void {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let files: string[] = [];
  try {
    files = fs.readdirSync(BACKUP_DIR);
  } catch {
    return;
  }
  for (const name of files) {
    if (!name.endsWith('.sql.gz')) continue;
    const full = path.join(BACKUP_DIR, name);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) {
        fs.unlinkSync(full);
        logger.info('Pruned old backup', { path: full });
      }
    } catch {
      /* best-effort */
    }
  }
}
