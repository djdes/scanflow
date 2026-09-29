import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from './logger';
import { goldenRepo } from '../database/repositories/goldenRepo';
import { photoRepo } from '../database/repositories/photoRepo';

const RETENTION_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isMissingColumnError(err: unknown): boolean {
  const e = err as { code?: string; errno?: number } | null;
  return e?.code === 'ER_BAD_FIELD_ERROR' || e?.errno === 1054;
}

/**
 * Фото эталонных накладных (invoices.golden = 1, п.17 v2) не удаляются никогда:
 * по ним прогон эталонов заново распознаёт документ и сверяет с проверенными
 * данными — без фото эталон бесполезен.
 *
 * null — список получить не удалось: чистку в этот раз пропускаем, иначе
 * можно удалить фото эталона. Исключение — колонки golden ещё нет (миграция 71
 * не применена): тогда и эталонов быть не может, чистим как раньше.
 */
async function loadProtectedNames(): Promise<Set<string> | null> {
  try {
    return new Set(await goldenRepo.listGoldenFileNames());
  } catch (err) {
    if (isMissingColumnError(err)) {
      logger.warn('Photo retention: invoices.golden ещё нет (миграция 71 не применена) — исключений для эталонов нет', {
        error: (err as Error).message,
      });
      return new Set();
    }
    logger.error('Photo retention: не удалось получить список эталонов — очистка пропущена, чтобы не удалить их фото', {
      error: (err as Error).message,
    });
    return null;
  }
}

/**
 * Фото накладных, которые ещё не ушли в 1С или ушли меньше RETENTION_DAYS
 * назад: без фото накладную из очереди не перепроверить и не перераспознать
 * (29.09 в очереди было 70 накладных, и 20 их фото удалились бы в октябре).
 * null — список получить не удалось: чистку пропускаем.
 */
async function loadUnsentNames(): Promise<Set<string> | null> {
  try {
    return new Set(await photoRepo.listNotYetExpiredFileNames(RETENTION_DAYS));
  } catch (err) {
    logger.error('Photo retention: не удалось получить список неотправленных накладных — очистка пропущена', {
      error: (err as Error).message,
    });
    return null;
  }
}

/**
 * Delete photos in processed/ older than RETENTION_DAYS, except photos of
 * golden (reference) invoices and of invoices not yet sent to 1C (or sent less
 * than RETENTION_DAYS ago).
 * Does NOT touch the database — old invoices stay, only the source image
 * is gone. If the user needs the photo again, they can re-upload.
 * Never rejects: every error is logged and reported as "nothing deleted".
 */
export async function cleanupOldPhotos(): Promise<{ deleted: number; freedMB: number; keptGolden: number; keptUnsent: number }> {
  const none = { deleted: 0, freedMB: 0, keptGolden: 0, keptUnsent: 0 };
  try {
    if (!fs.existsSync(config.processedDir)) {
      return none;
    }
    const protectedNames = await loadProtectedNames();
    if (!protectedNames) return none;
    const unsentNames = await loadUnsentNames();
    if (!unsentNames) return none;

    const cutoff = Date.now() - (RETENTION_DAYS * MS_PER_DAY);
    const files = fs.readdirSync(config.processedDir);
    let deleted = 0;
    let keptGolden = 0;
    let keptUnsent = 0;
    let freedBytes = 0;
    for (const file of files) {
      if (file.startsWith('.')) continue;
      const filePath = path.join(config.processedDir, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          if (protectedNames.has(file)) {
            keptGolden++;
            continue;
          }
          if (unsentNames.has(file)) {
            keptUnsent++;
            continue;
          }
          freedBytes += stat.size;
          fs.unlinkSync(filePath);
          deleted++;
        }
      } catch {
        // ignore individual file errors
      }
    }
    const freedMB = Math.round(freedBytes / 1024 / 1024 * 100) / 100;
    if (deleted > 0 || keptGolden > 0 || keptUnsent > 0) {
      logger.info('Photo retention cleanup', { deleted, freedMB, keptGolden, keptUnsent, retentionDays: RETENTION_DAYS });
    }
    return { deleted, freedMB, keptGolden, keptUnsent };
  } catch (err) {
    logger.error('Photo retention cleanup failed', { error: (err as Error).message });
    return none;
  }
}
