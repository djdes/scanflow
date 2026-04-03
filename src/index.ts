import { config } from './config';
import { logger } from './utils/logger';
import { getDb, closeDb } from './database/db';
import { OcrManager } from './ocr/ocrManager';
import { NomenclatureMapper } from './mapping/nomenclatureMapper';
import { FileWatcher } from './watcher/fileWatcher';
import { startServer } from './api/server';

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

main().catch((err) => {
  logger.error('Fatal error', { error: err instanceof Error ? err.message : err });
  process.exit(1);
});
