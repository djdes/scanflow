import cron from 'node-cron';
import { config } from './config';
import { logger } from './utils/logger';
import { getDb, closeDb } from './database/db';
import { OcrManager } from './ocr/ocrManager';
import { NomenclatureMapper } from './mapping/nomenclatureMapper';
import { FileWatcher } from './watcher/fileWatcher';
import { startServer } from './api/server';
import { backupDatabase } from './utils/backup';
import { cleanupOldRequestLogs } from './api/middleware/requestLog';

let ocrManager: OcrManager;
let fileWatcher: FileWatcher;

async function main(): Promise<void> {
  logger.info('=== 1C-JPGExchange starting ===');
  logger.info('Configuration loaded', {
    ocrChain: config.ocrChain,
    ocrForceEngine: config.ocrForceEngine,
    claudeCliPath: config.claudeCliPath,
    inboxDir: config.inboxDir,
    apiPort: config.apiPort,
    debug: config.debug,
    dryRun: config.dryRun,
  });

  // Initialize database
  getDb();
  logger.info('Database ready');

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
    backupDatabase();
  });
  logger.info('Daily database backup scheduled at 03:00');

  // Schedule daily request log cleanup at 03:05 (after backup so the backup
  // captures the cleaned-up state). Moves the DELETE out of the request hot path.
  cron.schedule('5 3 * * *', () => {
    const deleted = cleanupOldRequestLogs();
    logger.info('API request log cleanup', { deleted });
  });

  // Run one backup immediately on startup — captures current state
  // before any crash or issues happen in this session.
  backupDatabase();

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

  closeDb();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

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
