import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import { loadArticles } from '../seo/articles';
import { buildSitemapXml } from '../seo/sitemap';
import { config } from '../config';
import { logger } from '../utils/logger';
import { apiKeyAuth } from './middleware/auth';
import { apiRequestLog } from './middleware/requestLog';
import invoicesRouter, { setMapper as setInvoicesMapper, setFileWatcher as setInvoicesFileWatcher } from './routes/invoices';
import mappingsRouter, { setMapper } from './routes/mappings';
import uploadRouter, { setFileWatcher } from './routes/upload';
import webhookRouter from './routes/webhook';
import settingsRouter from './routes/settings';
import debugRouter from './routes/debug';
import nomenclatureRouter, { setMapper as setNomenclatureMapper } from './routes/nomenclature';
import authRouter from './routes/auth';
import profileRouter from './routes/profile';
import sberRouter from './routes/sber';
import suppliersRouter from './routes/suppliers';
import { FileWatcher } from '../watcher/fileWatcher';
import { NomenclatureMapper } from '../mapping/nomenclatureMapper';

export function createServer(fileWatcher: FileWatcher, mapper: NomenclatureMapper): express.Express {
  const app = express();
  const publicDir = path.resolve(process.cwd(), 'public');

  // Canonical blog URL has no trailing slash. Catch /blog/ before
  // express.static — otherwise the static middleware would serve
  // public/blog/index.html for /blog/, bypassing the redirect.
  // Express 5 route matching normalises the trailing slash so a separate
  // app.get('/blog/', ...) registration doesn't fire — hence middleware.
  app.use((req, res, next) => {
    if (req.method === 'GET' && req.path === '/blog/') {
      return res.redirect(301, '/blog');
    }
    next();
  });

  // Static files first (no auth needed).
  // redirect:false disables the automatic /dir → /dir/ 301 that express.static
  // applies when a directory matches the URL — otherwise GET /blog would 301
  // to /blog/ before our explicit /blog route gets a chance to run.
  app.use(express.static(publicDir, { redirect: false }));

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
  // 120/min matches the realistic upper bound for a human batch-uploading a
  // stack of invoices sequentially (each upload takes ~5–10s). Still a hard
  // wall against scripted abuse — legit single-user flow never hits it.
  const uploadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many uploads, slow down' },
  });

  // Inject dependencies
  setMapper(mapper);
  setNomenclatureMapper(mapper);
  setInvoicesMapper(mapper);
  setFileWatcher(fileWatcher);
  setInvoicesFileWatcher(fileWatcher);

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

  // Auth (no apiKeyAuth — this is how you GET the API key).
  // Tight per-IP rate limit blunts password-guessing attacks.
  const loginLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Слишком много попыток входа, попробуйте позже' },
  });
  app.use('/api/auth', loginLimiter, authRouter);

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
  app.use('/api/profile', apiKeyAuth, profileRouter);
  app.use('/api/sber', apiKeyAuth, sberRouter);
  app.use('/api/suppliers', apiKeyAuth, suppliersRouter);

  // Mobile camera page (no auth — accessed from phone on local network)
  app.get('/camera', (_req, res) => {
    res.sendFile(path.join(publicDir, 'camera.html'));
  });

  // ─── SEO + Blog routes (must be before the SPA fallback) ───

  // GET /sitemap.xml — generated on each request from articles.json (cheap;
  // alternative would be a startup-time cache, but startup loadtime isn't
  // worth the staleness on dev).
  app.get('/sitemap.xml', (_req, res) => {
    const articles = loadArticles();
    const xml = buildSitemapXml('https://scanflow.ru', articles);
    res.type('application/xml').send(xml);
  });

  // GET /blog — canonical listing (no trailing slash).
  // /blog/ → 301 to /blog is handled by middleware near the top of this file,
  // before express.static gets to serve public/blog/index.html.
  app.get('/blog', (_req, res) => {
    res.sendFile(path.join(publicDir, 'blog/index.html'));
  });

  // GET /blog/:slug — serve the matching article HTML or 404. Slug must be
  // safe (lowercase ascii + hyphens) to avoid path-traversal.
  app.get('/blog/:slug', (req, res) => {
    const slug = req.params.slug;
    if (!/^[a-z0-9-]+$/.test(slug)) return res.status(404).send('Not Found');
    const file = path.join(publicDir, 'blog', `${slug}.html`);
    if (!fs.existsSync(file)) return res.status(404).send('Not Found');
    res.sendFile(file);
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
