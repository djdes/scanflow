import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';
import { invoiceRepo } from '../database/repositories/invoiceRepo';
import { emit as emitNotification } from '../notifications/events';
import type { FileWatcher } from './fileWatcher';

/**
 * How many times a stale invoice may be re-driven through OCR before we park it
 * in 'error'. A photo that reliably kills the process burns exactly one attempt
 * per restart, so the loop always terminates.
 */
export const MAX_RECOVERY_ATTEMPTS = 2;

/**
 * Startup crash recovery. After a restart, any invoice still sitting in
 * 'ocr_processing'/'parsing' is dead by definition — no live watcher owns it.
 * Three outcomes:
 *
 *   - has items                  → Claude finished, only the status flip was
 *                                  lost → mark 'processed'.
 *   - no items, attempts left    → re-drive THE SAME ROW through OCR in place.
 *   - no items, out of attempts  → 'error', photo to failed/, one notification.
 *
 * The stale row is never DELETED. It used to be — the photo was dropped back
 * into inbox/ so the watcher would pick it up as a fresh upload. But deleting
 * the row also erased the file_hash that processFile's SHA-256 dedup checks, so
 * a photo that crashed the process was re-ingested as a BRAND-NEW invoice, with
 * a fresh photo_uploaded notification, on every single restart. With a 256 MB
 * PM2 ceiling and a 3-photo batch that peaked at 470 MB, that ran ~20 times in
 * 40 minutes (2026-07-14). Keeping the row keeps the hash dedup honest and lets
 * the attempt counter survive.
 *
 * Returns the ids to re-drive. Re-driving means Claude calls, so the caller runs
 * them AFTER the HTTP server is listening rather than blocking startup.
 */
export async function recoverStaleInvoices(watcher: FileWatcher): Promise<number[]> {
  const stale = await invoiceRepo.listStaleForRecovery();
  const toRetry: number[] = [];
  let promoted = 0;
  let exhausted = 0;

  for (const s of stale) {
    if (s.itemsCount > 0) {
      await invoiceRepo.updateStatus(s.id, 'processed');
      promoted++;
      continue;
    }

    // Burn the attempt BEFORE the retry runs. If this photo kills the process
    // again mid-OCR, the next boot reads the higher count and gives up on it.
    const attempts = await invoiceRepo.incrementRecoveryAttempts(s.id);
    const files = filesOf(s.file_name);

    if (attempts > MAX_RECOVERY_ATTEMPTS) {
      for (const f of files) moveTo(config.failedDir, f);
      await invoiceRepo.updateStatus(
        s.id,
        'error',
        `Обработка прерывалась ${attempts - 1} раз(а) подряд (процесс падал). `
        + 'Фото отложено в failed/ — проверьте логи и запустите «Пересканировать фото» вручную.',
      );
      emitNotification('recognition_error', {
        invoice_id: s.id,
        error_message: 'Не удалось обработать фото: процесс падал на нём несколько раз подряд.',
      }, null).catch(() => {});
      exhausted++;
      continue;
    }

    // Claim the inbox copy so the watcher's initial scan can't race us for it
    // and open a second invoice for the same photo (CLAUDE.md rule 6).
    for (const f of files) watcher.markProcessing(path.join(config.inboxDir, f));
    toRetry.push(s.id);
  }

  if (promoted > 0 || exhausted > 0 || toRetry.length > 0) {
    logger.warn('Recovered stale invoices', {
      stuck: stale.length, promoted, retrying: toRetry.length, exhausted,
    });
  }
  return toRetry;
}

/**
 * Re-drive stale invoices through OCR, strictly one at a time.
 *
 * Sequential on purpose: three *concurrent* Claude image analyses are what
 * pushed RSS past the PM2 memory ceiling and started the restart loop in the
 * first place. Recovery must not recreate the conditions it exists to clean up.
 *
 * reprocessInvoice() reuses the existing row — no second invoice is created and,
 * critically, no photo_uploaded notification fires.
 */
export async function retryStaleInvoices(watcher: FileWatcher, ids: number[]): Promise<void> {
  for (const id of ids) {
    try {
      logger.info('Crash recovery: re-processing stale invoice in place', { id });
      await watcher.reprocessInvoice(id);

      // Success — retire the inbox copy so the watcher stops seeing it.
      const inv = await invoiceRepo.getById(id);
      for (const f of filesOf(inv?.file_name ?? '')) moveTo(config.processedDir, f);
    } catch (err) {
      // Leave the row stale. The next restart bumps the counter again and
      // eventually parks it in 'error'. Never re-queue the file, never open a
      // second row — that is exactly the loop this module was written to kill.
      logger.error('Crash recovery: re-processing failed', {
        id, error: (err as Error).message,
      });
    }
  }
}

function filesOf(fileName: string | null): string[] {
  return (fileName || '').split(',').map(f => f.trim()).filter(Boolean);
}

/** Move a photo into `destDir` from wherever it currently sits. */
function moveTo(destDir: string, fileName: string): void {
  const dest = path.join(destDir, fileName);
  for (const dir of [config.inboxDir, config.processedDir, config.failedDir]) {
    if (dir === destDir) continue;
    const src = path.join(dir, fileName);
    try {
      if (fs.existsSync(src) && !fs.existsSync(dest)) fs.renameSync(src, dest);
    } catch (err) {
      // The watcher may have moved it already — ENOENT is normal (CLAUDE.md rule 7).
      logger.debug('Crash recovery: file move skipped', {
        fileName, destDir, error: (err as Error).message,
      });
    }
  }
}
