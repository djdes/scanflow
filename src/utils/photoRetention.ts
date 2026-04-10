import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from './logger';

const RETENTION_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Delete photos in processed/ older than RETENTION_DAYS.
 * Does NOT touch the database — old invoices stay, only the source image
 * is gone. If the user needs the photo again, they can re-upload.
 */
export function cleanupOldPhotos(): { deleted: number; freedMB: number } {
  try {
    if (!fs.existsSync(config.processedDir)) {
      return { deleted: 0, freedMB: 0 };
    }
    const cutoff = Date.now() - (RETENTION_DAYS * MS_PER_DAY);
    const files = fs.readdirSync(config.processedDir);
    let deleted = 0;
    let freedBytes = 0;
    for (const file of files) {
      if (file.startsWith('.')) continue;
      const filePath = path.join(config.processedDir, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          freedBytes += stat.size;
          fs.unlinkSync(filePath);
          deleted++;
        }
      } catch {
        // ignore individual file errors
      }
    }
    const freedMB = Math.round(freedBytes / 1024 / 1024 * 100) / 100;
    if (deleted > 0) {
      logger.info('Photo retention cleanup', { deleted, freedMB, retentionDays: RETENTION_DAYS });
    }
    return { deleted, freedMB };
  } catch (err) {
    logger.error('Photo retention cleanup failed', { error: (err as Error).message });
    return { deleted: 0, freedMB: 0 };
  }
}
