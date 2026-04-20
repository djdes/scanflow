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
  // CORS: only allow configured origins. With no CORS_ORIGINS env var the
  // policy is "same-origin only" (no Access-Control-Allow-Origin header on
  // cross-origin requests), which is the safe default for an internal tool.
  const allowedOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  app.use(cors({
    origin: (origin, cb) => {
      // Same-origin requests (no Origin header) are always allowed.
      if (!origin) return cb(null, true);
      if (allowedOrigins.length === 0) return cb(null, false);
      if (allowedOrigins.includes('*')) return cb(null, true);
      return cb(null, allowedOrigins.includes(origin));
    },
    credentials: true,
  }));

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

  // Health check (no auth) — runs real probes against the DB, credentials
  // file, anthropic key, and inbox queue depth. Returns 503 if any critical
  // check fails. Used by uptime monitoring.
  app.get('/health', (_req, res) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};
    let allOk = true;

    // DB ping
    try {
      const { getDb } = require('../database/db');
      const db = getDb();
      db.prepare('SELECT 1').get();
      checks.database = { ok: true };
    } catch (e) {
      checks.database = { ok: false, detail: (e as Error).message };
      allOk = false;
    }

    // Google credentials file (optional — only if hybrid mode)
    try {
      const fs = require('fs');
      if (config.googleCredentials && fs.existsSync(config.googleCredentials)) {
        fs.accessSync(config.googleCredentials, fs.constants.R_OK);
        checks.google_credentials = { ok: true };
      } else {
        checks.google_credentials = { ok: true, detail: 'not required (claude_api mode)' };
      }
    } catch (e) {
      checks.google_credentials = { ok: false, detail: (e as Error).message };
      // Not fatal — claude_api mode doesn't need Google
    }

    // Anthropic key present
    checks.anthropic_api_key = config.anthropicApiKey
      ? { ok: true }
      : { ok: false, detail: 'ANTHROPIC_API_KEY not set in env' };
    if (!config.anthropicApiKey) allOk = false;

    // Inbox queue depth (alert if stuck — files not being processed)
    try {
      const fs = require('fs');
      const pendingFiles = fs.existsSync(config.inboxDir)
        ? fs.readdirSync(config.inboxDir).filter((f: string) => !f.startsWith('.')).length
        : 0;
      const stuck = pendingFiles >= 50;
      checks.inbox_queue = {
        ok: !stuck,
        detail: `${pendingFiles} files pending`,
      };
      if (stuck) allOk = false;
    } catch (e) {
      checks.inbox_queue = { ok: false, detail: (e as Error).message };
    }

    res.status(allOk ? 200 : 503).json({
      status: allOk ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      checks,
    });
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
