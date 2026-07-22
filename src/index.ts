import cron from 'node-cron';
import path from 'path';
import { config } from './config';
import { logger } from './utils/logger';
import { initDb, closeDb } from './database/db';
import { OcrManager } from './ocr/ocrManager';
import { NomenclatureMapper } from './mapping/nomenclatureMapper';
import { FileWatcher } from './watcher/fileWatcher';
import { recoverStaleInvoices, retryStaleInvoices } from './watcher/crashRecovery';
import { pruneSendLog } from './notifications/rateLimit';
import { startServer } from './api/server';
import { backupDatabase } from './utils/backup';
import { cleanupOldRequestLogs } from './api/middleware/requestLog';
import { integrationEventRepo } from './database/repositories/integrationEventRepo';
import { cleanupOldPhotos } from './utils/photoRetention';
import { checkDiskSpace } from './utils/diskMonitor';
import { invoiceRepo, SBER_OVERDUE_DAYS } from './database/repositories/invoiceRepo';
import { supplierExtractJobRepo } from './database/repositories/supplierExtractJobRepo';
import { notifySupplierExtractError, emit as emitNotification } from './notifications/events';
import { seedAdminUser } from './auth/seedAdmin';
import { startDigestWorker } from './notifications/digestWorker';

let ocrManager: OcrManager;
let fileWatcher: FileWatcher;
let httpServer: import('http').Server | null = null;

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

  // Initialize OCR
  ocrManager = new OcrManager();
  logger.info('OCR manager ready');

  // Initialize nomenclature mapper
  const mapper = new NomenclatureMapper();
  logger.info('Nomenclature mapper ready');

  // Build the watcher BEFORE crash recovery: recovery re-drives stale invoices
  // through it (in place, same row) instead of deleting them and re-queuing the
  // photo as a fresh upload. See src/watcher/crashRecovery.ts for why that
  // distinction is load-bearing.
  fileWatcher = new FileWatcher(ocrManager, mapper);

  // Recover from crashes / interrupted deploys. Returns the ids that still need
  // an OCR re-run; those are slow (Claude calls), so they're kicked off after
  // the HTTP server is listening rather than blocking startup.
  let staleToRetry: number[] = [];
  try {
    staleToRetry = await recoverStaleInvoices(fileWatcher);

    // Catch-all for rows recovery doesn't see: a row that died between INSERT
    // and its first status flip is still 'new', not 'ocr_processing'. Rows
    // queued for an in-place retry are excluded — they sit in 'ocr_processing'
    // on purpose and are about to be re-driven.
    const fallback = await invoiceRepo.markStaleAsFailed(1, staleToRetry);
    if (fallback > 0) {
      logger.warn('Marked remaining stale as error', { count: fallback });
    }
  } catch (e) {
    logger.error('Startup stale-invoice recovery failed', { error: (e as Error).message });
  }

  fileWatcher.start();
  logger.info('File watcher ready');

  // Start REST API server
  httpServer = startServer(fileWatcher, mapper);

  // Now that we're serving, re-drive the stale invoices in the background —
  // one at a time (concurrent Claude image calls are what blew the memory
  // ceiling and started the restart loop this recovery path exists to end).
  if (staleToRetry.length > 0) {
    void retryStaleInvoices(fileWatcher, staleToRetry);
  }

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
    pruneSendLog()
      .then(deleted => { if (deleted > 0) logger.info('Pruned old notification_sends', { deleted }); })
      .catch(err => logger.error('notification_sends prune failed', { error: (err as Error).message }));
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

  // Sber-overdue alert: daily at 09:00. Notify (Telegram + email, once per
  // invoice) about payable invoices that have had no Sber payment for
  // SBER_OVERDUE_DAYS. markSberOverdueNotified stamps each so it fires once.
  cron.schedule('0 9 * * *', () => {
    (async () => {
      const overdue = await invoiceRepo.listNewlyOverdueForSber();
      if (!overdue.length) return;
      logger.warn('Sber-overdue sweep: invoices without a Sber payment', {
        count: overdue.length, days: SBER_OVERDUE_DAYS,
      });
      for (const inv of overdue) {
        const daysOverdue = inv.created_at
          ? Math.floor((Date.now() - new Date(inv.created_at + 'Z').getTime()) / 86_400_000)
          : SBER_OVERDUE_DAYS;
        // emit() never throws; still guard markSberOverdueNotified so one bad row
        // doesn't abort the loop (and re-alert everyone next day).
        await emitNotification('sber_payment_overdue', {
          invoice_id: inv.id,
          invoice_number: inv.invoice_number,
          supplier: inv.supplier,
          total_sum: inv.total_sum,
          created_at: inv.created_at,
          days_overdue: daysOverdue,
        }, inv.owner_user_id);
        try {
          await invoiceRepo.markSberOverdueNotified(inv.id);
        } catch (err) {
          logger.error('Failed to mark invoice sber-overdue-notified', {
            invoiceId: inv.id, error: (err as Error).message,
          });
        }
      }
    })().catch(err => logger.error('sber-overdue sweep failed', { error: (err as Error).message }));
  });

  // Dispatcher-mode timeout sweep: every 5 min. Queue-aware — measures the
  // 15-min "hung" clock from when the worker actually started a task (first
  // photo fetch), and only kills never-started (queued) tasks after a long
  // 180-min grace so a big upload batch can drain on a single serial worker.
  cron.schedule('*/5 * * * *', () => {
    invoiceRepo.markStaleDispatchersAsFailed(15, 180)
      .then(n => { if (n > 0) logger.warn('Dispatcher timeout sweep: marked as error', { count: n }); })
      .catch(err => logger.error('dispatcher timeout sweep failed', { error: (err as Error).message }));
    supplierExtractJobRepo.markStaleAsFailed(15)
      .then(jobs => {
        if (!jobs.length) return;
        logger.warn('Supplier-extract timeout sweep: marked as error', { count: jobs.length });
        for (const j of jobs) {
          notifySupplierExtractError(j.file_name, 'Диспетчер не ответил в течение 15 минут (таймаут).', j.owner_user_id ?? null).catch(() => {});
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

  // Stop new intake first (watcher), then drain in-flight HTTP requests before
  // tearing down the DB pool — closing the pool while a request is mid-query
  // throws "pool is closed". Bounded so a keep-alive connection can't hang exit.
  if (fileWatcher) {
    fileWatcher.stop();
  }

  if (httpServer) {
    const server = httpServer;
    await Promise.race([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ]);
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
