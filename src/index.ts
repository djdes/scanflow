import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { config } from './config';
import { logger } from './utils/logger';
import { initDb, closeDb } from './database/db';
import { OcrManager } from './ocr/ocrManager';
import { NomenclatureMapper } from './mapping/nomenclatureMapper';
import { FileWatcher } from './watcher/fileWatcher';
import { startServer } from './api/server';
import { backupDatabase } from './utils/backup';
import { cleanupOldRequestLogs } from './api/middleware/requestLog';
import { integrationEventRepo } from './database/repositories/integrationEventRepo';
import { cleanupOldPhotos } from './utils/photoRetention';
import { checkDiskSpace } from './utils/diskMonitor';
import { invoiceRepo } from './database/repositories/invoiceRepo';
import { supplierExtractJobRepo } from './database/repositories/supplierExtractJobRepo';
import { notifySupplierExtractError } from './notifications/events';
import { seedAdminUser } from './auth/seedAdmin';
import { startDigestWorker } from './notifications/digestWorker';

let ocrManager: OcrManager;
let fileWatcher: FileWatcher;

async function main(): Promise<void> {
  logger.info('=== 1C-JPGExchange starting ===');
  logger.info('Configuration loaded', {
    ocrChain: config.ocrChain,
    ocrForceEngine: config.ocrForceEngine,
    inboxDir: config.inboxDir,
    apiPort: config.apiPort,
    debug: config.debug,
    dryRun: config.dryRun,
  });

  // Initialize database (opens MariaDB pool + runs migrations)
  await initDb();
  logger.info('Database ready');

  // Seed/sync admin user from .env. Idempotent — safe on every startup.
  try {
    await seedAdminUser();
  } catch (e) {
    logger.error('Admin seed failed', { error: (e as Error).message });
  }

  // Recover from crashes / interrupted deploys. After process restart, ANY
  // invoice in 'ocr_processing'/'parsing' is by definition dead — нет живого
  // watcher'а, кто бы её сейчас обрабатывал. Two paths:
  //   - has items already (Claude finished, only status flip didn't run) →
  //     UPDATE status='processed'.
  //   - no items (crash happened earlier, mid-Claude or mid-OCR) → DELETE
  //     запись и переместить файл из processed/ обратно в inbox/, чтобы
  //     watcher переобработал как новую.
  try {
    const stale = await invoiceRepo.listStaleForRecovery();
    let promoted = 0, requeued = 0;
    for (const s of stale) {
      if (s.itemsCount > 0) {
        await invoiceRepo.updateStatus(s.id, 'processed');
        promoted++;
      } else {
        // Re-queue the file for fresh processing
        const firstFile = (s.file_name || '').split(',')[0].trim();
        if (firstFile) {
          const processedPath = path.join(config.processedDir, firstFile);
          const inboxPath = path.join(config.inboxDir, firstFile);
          if (fs.existsSync(processedPath) && !fs.existsSync(inboxPath)) {
            try { fs.renameSync(processedPath, inboxPath); } catch { /* ignore */ }
          }
        }
        await invoiceRepo.delete(s.id);
        requeued++;
      }
    }
    if (promoted > 0 || requeued > 0) {
      logger.warn('Recovered stale invoices', { stuck: stale.length, promoted, requeued });
    }
    // Catch-all: anything still non-terminal older than 1 minute → error.
    // Should be empty after the loop above, but kept as safety net.
    const fallback = await invoiceRepo.markStaleAsFailed(1);
    if (fallback > 0) {
      logger.warn('Marked remaining stale as error', { count: fallback });
    }
  } catch (e) {
    logger.error('Startup stale-invoice recovery failed', { error: (e as Error).message });
  }

  // Initialize OCR
  ocrManager = new OcrManager();
  logger.info('OCR manager ready');

  // Initialize nomenclature mapper
  const mapper = new NomenclatureMapper();
  logger.info('Nomenclature mapper ready');

  // Initialize file watcher
  fileWatcher = new FileWatcher(ocrManager, mapper);
  fileWatcher.start();
  logger.info('File watcher ready');

  // Start REST API server
  startServer(fileWatcher, mapper);

  // Schedule daily database backup at 03:00 server time
  cron.schedule('0 3 * * *', () => {
    logger.info('Running scheduled database backup...');
    backupDatabase().catch(err => logger.error('scheduled backup failed', { error: (err as Error).message }));
  });
  logger.info('Daily database backup scheduled at 03:00');

  // Schedule daily request log cleanup at 03:05 (after backup so the backup
  // captures the cleaned-up state). Moves the DELETE out of the request hot path.
  cron.schedule('5 3 * * *', () => {
    cleanupOldRequestLogs()
      .then(deleted => logger.info('API request log cleanup', { deleted }))
      .catch(err => logger.error('request log cleanup failed', { error: (err as Error).message }));
    integrationEventRepo.prune(90)
      .then(deleted => { if (deleted > 0) logger.info('Pruned old integration_events', { deleted }); })
      .catch(err => logger.error('integration_events prune failed', { error: (err as Error).message }));
  });

  // Weekly photo cleanup on Sunday at 03:10 — deletes processed/ files
  // older than 90 days to prevent unbounded disk growth.
  cron.schedule('10 3 * * 0', () => {
    logger.info('Running weekly photo retention cleanup...');
    cleanupOldPhotos();
  });

  // Disk space check every 6 hours + once on startup.
  // Emails when free space < 5 GB.
  cron.schedule('0 */6 * * *', () => {
    checkDiskSpace().catch(err => logger.error('disk space check failed', { error: (err as Error).message }));
  });

  // Dispatcher-mode timeout sweep: every 5 min, mark any invoice whose
  // dispatcher_started_at is older than 15 min as error. Without this,
  // a crashed Claude Code dispatcher session would leave invoices stuck
  // in ocr_processing forever.
  cron.schedule('*/5 * * * *', () => {
    invoiceRepo.markStaleDispatchersAsFailed(15)
      .then(n => { if (n > 0) logger.warn('Dispatcher timeout sweep: marked as error', { count: n }); })
      .catch(err => logger.error('dispatcher timeout sweep failed', { error: (err as Error).message }));
    supplierExtractJobRepo.markStaleAsFailed(15)
      .then(jobs => {
        if (!jobs.length) return;
        logger.warn('Supplier-extract timeout sweep: marked as error', { count: jobs.length });
        for (const j of jobs) {
          notifySupplierExtractError(j.file_name, 'Диспетчер не ответил в течение 15 минут (таймаут).').catch(() => {});
        }
      })
      .catch(err => logger.error('supplier-extract timeout sweep failed', { error: (err as Error).message }));
  });
  checkDiskSpace().catch(err => logger.error('initial disk space check failed', { error: (err as Error).message }));

  // Run one backup immediately on startup — captures current state
  // before any crash or issues happen in this session.
  backupDatabase().catch(err => logger.error('startup backup failed', { error: (err as Error).message }));

  // Start user notification digest worker (cron: hourly 9-18 MSK + daily 19 MSK + cleanup 03:30 MSK)
  startDigestWorker();

  logger.info('=== 1C-JPGExchange is running ===');
}

// Graceful shutdown
async function shutdown(): Promise<void> {
  logger.info('Shutting down...');

  if (fileWatcher) {
    fileWatcher.stop();
  }

  if (ocrManager) {
    await ocrManager.terminate();
  }

  await closeDb();
  process.exit(0);
}

process.on('SIGINT', () => { shutdown().catch(err => logger.error('shutdown error', { error: (err as Error).message })); });
process.on('SIGTERM', () => { shutdown().catch(err => logger.error('shutdown error', { error: (err as Error).message })); });

// Email critical errors
import { sendErrorEmail } from './utils/mailer';

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  sendErrorEmail('Критическая ошибка (uncaughtException)', `${err.message}\n\n${err.stack || ''}`).catch(() => {});
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : '';
  logger.error('Unhandled rejection', { error: msg });
  sendErrorEmail('Необработанная ошибка (unhandledRejection)', `${msg}\n\n${stack || ''}`).catch(() => {});
});

main().catch((err) => {
  logger.error('Fatal error', { error: err instanceof Error ? err.message : err });
  sendErrorEmail('Фатальная ошибка при запуске', `${err instanceof Error ? err.message : err}\n\n${err instanceof Error ? err.stack : ''}`).catch(() => {});
  process.exit(1);
});
