import fs from 'fs';
import path from 'path';
import { logger } from './logger';
import { dumpDatabaseTo, rotateDumps } from './dbDump';


/**
 * Stub kept for compatibility — always returns `{ ok: true }` because we no
 * longer ship verifiable SQLite snapshots.
 */
export function verifySqliteFile(_filePath: string): { ok: boolean; error?: string } {
  return { ok: true };
}

/**
 * Ежедневный бэкап БД (cron 03:00 и на старте, см. src/index.ts): логический
 * дамп в data/backups/scanflow-YYYY-MM-DD.sql.gz, хранится 14 последних.
 * До пакета v2 это был no-op, а внешнего cron на сервере не было — то есть
 * бэкапов MySQL/MariaDB не делалось вообще. Один файл в сутки: если за
 * сегодня уже есть — повторно не снимаем. Никогда не бросает.
 */
export const BACKUP_KEEP = 14;

export async function backupDatabase(): Promise<string | null> {
  const dir = path.resolve(process.env.BACKUP_DIR || './data/backups');
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
  const file = path.join(dir, `scanflow-${day}.sql.gz`);
  try {
    if (fs.existsSync(file)) {
      logger.info('Database backup for today already exists', { file });
      return file;
    }
    const t0 = Date.now();
    const r = await dumpDatabaseTo(file);
    const removed = rotateDumps(dir, BACKUP_KEEP);
    logger.info('Database backup written', { file: r.file, bytes: r.bytes, tables: r.tables, rows: r.rows, ms: Date.now() - t0, rotated: removed.length });
    return r.file;
  } catch (err) {
    logger.error('Database backup failed', { file, error: (err as Error).message });
    return null;
  }
}
