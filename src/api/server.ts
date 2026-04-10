import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';
import { apiKeyAuth } from './middleware/auth';
import { apiRequestLog } from './middleware/requestLog';
import invoicesRouter, { setMapper as setInvoicesMapper } from './routes/invoices';
import mappingsRouter, { setMapper } from './routes/mappings';
import uploadRouter, { setFileWatcher } from './routes/upload';
import webhookRouter from './routes/webhook';
import settingsRouter from './routes/settings';
import debugRouter from './routes/debug';
import nomenclatureRouter, { setMapper as setNomenclatureMapper } from './routes/nomenclature';
import { FileWatcher } from '../watcher/fileWatcher';
import { NomenclatureMapper } from '../mapping/nomenclatureMapper';

export function createServer(fileWatcher: FileWatcher, mapper: NomenclatureMapper): express.Express {
  const app = express();
  const publicDir = path.resolve(process.cwd(), 'public');

  // Static files first (no auth needed)
  app.use(express.static(publicDir));

  // Middleware
  app.use(cors());

  // Security headers. contentSecurityPolicy disabled because the dashboard
  // uses inline onclick handlers extensively; re-enable after refactoring to
  // addEventListener-only handlers.
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }));

  // Global rate limit — catches runaway clients and DoS attempts.
  // 300 req/min/IP is generous for legit use, hard wall for abuse.
  const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, try again later' },
  });
  app.use(globalLimiter);

  app.use(express.json({ limit: '10mb' }));

  // Debug: log every /api/* request to DB so we can diagnose "did the client
  // actually reach us?" without SSH access to pm2/nginx logs
  app.use(apiRequestLog);

  // Stricter limit specifically for uploads (expensive: disk + Claude API).
  // Applied below on /api/upload route mount.
  const uploadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many uploads, slow down' },
  });

  // Inject dependencies
  setMapper(mapper);
  setNomenclatureMapper(mapper);
  setInvoicesMapper(mapper);
  setFileWatcher(fileWatcher);

  // Health check (no auth)
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // API routes (with auth)
  // NOTE: /api/errors and /api/reprocess-errors moved under /api/debug/* which
  // is already protected by apiKeyAuth. See src/api/routes/debug.ts.
  app.use('/api/invoices', apiKeyAuth, invoicesRouter);
  app.use('/api/mappings', apiKeyAuth, mappingsRouter);
  app.use('/api/upload', apiKeyAuth, uploadLimiter, uploadRouter);
  app.use('/api/webhook', apiKeyAuth, webhookRouter);
  app.use('/api/settings', apiKeyAuth, settingsRouter);
  app.use('/api/debug', apiKeyAuth, debugRouter);
  app.use('/api/nomenclature', apiKeyAuth, nomenclatureRouter);

  // Mobile camera page (no auth — accessed from phone on local network)
  app.get('/camera', (_req, res) => {
    res.sendFile(path.join(publicDir, 'camera.html'));
  });

  // SPA fallback: serve index.html for unmatched GET requests
  app.get('/{*splat}', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  logger.info('Serving dashboard from', { path: publicDir });

  return app;
}

export function startServer(fileWatcher: FileWatcher, mapper: NomenclatureMapper): void {
  const app = createServer(fileWatcher, mapper);

  app.listen(config.apiPort, () => {
    logger.info(`API server listening on port ${config.apiPort}`);
    logger.info(`Health check: http://localhost:${config.apiPort}/health`);
    logger.info(`Dashboard: http://localhost:${config.apiPort}/`);
  });
}
