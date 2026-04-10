import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from './logger';
import { sendErrorEmail } from './mailer';

const WARNING_THRESHOLD_GB = 5;

/**
 * Check free disk space on the partition holding the database.
 * Emails an alert if free space < WARNING_THRESHOLD_GB.
 * Uses fs.statfsSync (Node 18.15+).
 */
export async function checkDiskSpace(): Promise<void> {
  try {
    const dbDir = path.dirname(config.dbPath);
    if (!fs.existsSync(dbDir)) return;

    // statfsSync is available on Node >= 18.15. Fall back to no-op if unsupported.
    const statfs = (fs as unknown as { statfsSync?: (p: string) => { bavail: bigint; bsize: bigint } }).statfsSync;
    if (!statfs) {
      logger.debug('fs.statfsSync unavailable, skipping disk check');
      return;
    }

    const stat = statfs(dbDir);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
    const freeGB = freeBytes / 1024 / 1024 / 1024;

    logger.info('Disk space check', { path: dbDir, freeGB: freeGB.toFixed(2) });

    if (freeGB < WARNING_THRESHOLD_GB) {
      const msg = `Free disk space below threshold: ${freeGB.toFixed(2)} GB at ${dbDir}`;
      logger.warn(msg);
      await sendErrorEmail(
        'Мало места на диске',
        `${msg}\n\nПорог: ${WARNING_THRESHOLD_GB} GB\n\nРекомендации:\n- Проверить data/processed/\n- Проверить logs/\n- Проверить data/backups/`
      );
    }
  } catch (err) {
    logger.error('Disk space check failed', { error: (err as Error).message });
  }
}
