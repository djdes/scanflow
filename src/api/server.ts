import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { LEGAL_PAGES } from '../legal/documents';
import { readOrBuildPromoBundle } from '../seo/promoCache';
import { prefersMarkdown } from '../seo/promoMarkdown';
import { config } from '../config';
import { logger } from '../utils/logger';
import { apiKeyAuth, requireAdmin } from './middleware/auth';
import { apiRequestLog } from './middleware/requestLog';
import { terminalErrorHandler } from './middleware/errorHandler';
import invoicesRouter, { setMapper as setInvoicesMapper, setFileWatcher as setInvoicesFileWatcher } from './routes/invoices';
import mappingsRouter, { setMapper } from './routes/mappings';
import uploadRouter, { setFileWatcher } from './routes/upload';
import webhookRouter from './routes/webhook';
import settingsRouter from './routes/settings';
import chatgptRouter from './routes/chatgpt';
import aiRouter from './routes/ai';
import productAssistantRouter from './routes/productAssistant';
import debugRouter from './routes/debug';
import nomenclatureRouter, { setMapper as setNomenclatureMapper } from './routes/nomenclature';
import dispatcherRouter, { setMapper as setDispatcherMapper } from './routes/dispatcher';
import { registerAfterCatalogSync } from '../services/catalogSyncWatcher';
import { remapUnsentInvoices } from '../services/remapUnsent';
import { linkCreatedNewItems } from '../services/newItemActions';
import newItemsRouter, { setMapper as setNewItemsMapper } from './routes/newItems';
import queueRouter, { setMapper as setQueueMapper } from './routes/queue';
import authRouter from './routes/auth';
import { userRepo } from '../database/repositories/userRepo';
import profileRouter from './routes/profile';
import sberRouter, { sberCallbackRouter } from './routes/sber';
import suppliersRouter from './routes/suppliers';
import integrationsRouter from './routes/integrations';
import usersRouter from './routes/users';
import operationsRouter from './routes/operations';
import goldenRouter from './routes/golden';
import learningRouter from './routes/learning';
import analyticsRouter from './routes/analytics';
import billingRouter, { robokassaCallbackRouter } from './routes/billing';
import unitCostRouter from './routes/unitCost';
import recognitionQueueRouter from './routes/recognitionQueue';
import { registerMobileRoutes } from './mobileRoutes';
import pushRouter from './routes/push';
import { inboundPublicRouter, inboundConfigRouter, setInboundFileWatcher } from './routes/inbound';
import { onecAdminRouter, onecExchangeRouter, onecPairRouter, onecUserRouter, setOnecMapper } from './routes/onec';
import { FileWatcher } from '../watcher/fileWatcher';
import { NomenclatureMapper } from '../mapping/nomenclatureMapper';
import { aiEngineState } from '../ai/engine';

export function createServer(fileWatcher: FileWatcher, mapper: NomenclatureMapper): express.Express {
  const app = express();
  // Behind nginx (FastPanel) the real client IP arrives in X-Forwarded-For.
  // Trust exactly one proxy hop so express-rate-limit buckets per real client
  // instead of collapsing every request into the single 127.0.0.1 bucket
  // (which made the login/global limits effectively global, not per-IP).
  app.set('trust proxy', 1);
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
    // Шаблоны правовых документов не отдаём как есть: в них нет реквизитов
    // оператора, их подставляет маршрут /privacy, /consent, /terms ниже.
    if (req.path.startsWith('/legal/')) {
      const legal = /^\/legal\/([a-z]+)\.html$/.exec(req.path);
      return legal && (LEGAL_PAGES as readonly string[]).includes(legal[1])
        ? res.redirect(301, `/${legal[1]}`)
        : res.status(404).sendFile('404.html', { root: publicDir });
    }
    next();
  });

  // Static files first (no auth needed).
  // redirect:false disables the automatic /dir → /dir/ 301 that express.static
  // applies when a directory matches the URL — otherwise GET /blog would 301
  // to /blog/ before our explicit /blog route gets a chance to run.
  // index:false — without this express.static auto-serves public/index.html
  // for GET /, which preempts our app.get('/', ...) route below where we
  // inject the blog-preview cards into the landing.
  // no-cache on the SPA shell + its JS/CSS so a deploy is picked up on the
  // next reload (the browser still revalidates via ETag → cheap 304 when
  // unchanged). Without this the dashboard kept serving stale invoices.js /
  // style.css after deploys, hiding new features until a manual Ctrl+F5.
  // Шрифты в public/fonts несут версию в имени (geist-v5-*.woff2) — их можно
  // кешировать навсегда: новая версия придёт под новым именем.
  app.use(express.static(publicDir, {
    redirect: false,
    index: false,
    setHeaders: (res, filePath) => {
      if (/\.(html|js|css)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache');
      } else if (/\.woff2$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  }));

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
    message: { error: 'Слишком много попыток входа. Попробуйте через несколько минут' },
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
    message: { error: 'Слишком много загрузок подряд. Подождите немного' },
  });

  // Inject dependencies
  setMapper(mapper);
  setNomenclatureMapper(mapper);
  setInvoicesMapper(mapper);
  setDispatcherMapper(mapper);
  setNewItemsMapper(mapper);
  setQueueMapper(mapper);
  // После обновления каталога 1С (хуки идут по порядку регистрации):
  // 1) «Новые товары» (п.12) — заявки «Создать в 1С», чья позиция появилась в
  //    справочнике, связываются с ней, строки групп получают именно её;
  // 2) пересопоставить остальные неотправленные строки (п.13).
  registerAfterCatalogSync(owner => linkCreatedNewItems(owner, mapper).then(() => undefined));
  registerAfterCatalogSync(owner => remapUnsentInvoices(owner, mapper).then(() => undefined));
  setFileWatcher(fileWatcher);
  setInvoicesFileWatcher(fileWatcher);
  setInboundFileWatcher(fileWatcher);
  setOnecMapper(mapper);

  // Health check (no auth) — runs real probes against the DB, credentials
  // file, AI engine (informational), and inbox queue depth. Returns 503 if any critical
  // check fails. Used by uptime monitoring.
  app.get('/health', async (_req, res) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};
    let allOk = true;

    // DB ping. Must be awaited — the adapter's get() is async and never throws
    // synchronously, so without await the try/catch never sees a DB outage and
    // /health would falsely report "ok" (and leak an unhandledRejection).
    try {
      const { getDb } = require('../database/db');
      const db = getDb();
      await db.prepare('SELECT 1').get();
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

    // ИИ-движок. Только для сведения: лимит подписки ChatGPT или повторный вход
    // не должны делать /health «degraded» — выкладка ждёт "status":"ok" (deploy.yml),
    // а накладные на это время просто ждут (waiting_ai).
    try {
      const state = await aiEngineState();
      checks.ai_engine = { ok: state.available, detail: `${state.engine}: ${state.available ? 'ready' : state.reason}` };
      // Ключ Anthropic нужен только в режиме claude_api (аккаунта Claude сейчас нет).
      if (state.engine === 'claude') {
        checks.anthropic_api_key = state.available ? { ok: true } : { ok: false, detail: 'ANTHROPIC_API_KEY not set' };
        if (!state.available) allOk = false;
      }
    } catch (e) {
      checks.ai_engine = { ok: false, detail: (e as Error).message };
    }

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
  // Dispatcher callbacks — token-authenticated inside (no apiKeyAuth).
  // Must be mounted before /api/invoices to avoid path collision (it isn't,
  // since path differs — /api/dispatcher/* vs /api/invoices/* — but order
  // costs nothing).
  app.use('/api/dispatcher', dispatcherRouter);
  // Public document-ingress webhooks authenticate their own high-entropy
  // secrets. Mount before apiKey-authenticated routes.
  app.use('/api/inbound/public', inboundPublicRouter);
  // Dedicated 1C tokens are authenticated and scope-limited inside this router.
  app.use('/api/onec/exchange', onecExchangeRouter);
  // Публичный обмен кода на токен — строгий rate-limit против перебора кодов.
  // Должен быть примонтирован ДО `/api/onec` (apiKeyAuth, onecUserRouter) ниже:
  // иначе префиксный apiKeyAuth-мидлвар перехватит /api/onec/pair и обработка
  // 1С без токена получит 401 вместо обмена кода.
  const onecPairLimiter = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false });
  app.use('/api/onec/pair', onecPairLimiter, onecPairRouter);
  // Возврат от Сбера после входа через Сбербанк (OAuth) — без X-API-Key:
  // компания в подписанном state. ДО `/api/sber` (apiKeyAuth), иначе 401.
  const sberCallbackLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });
  app.use('/api/sber/callback', sberCallbackLimiter, sberCallbackRouter);
  // Provider callbacks cannot supply X-API-Key. They stay hard-disabled until
  // persistent, verified settlement is implemented; no payment is acknowledged.
  const billingCallbackLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });
  app.use('/api/payments/robokassa', billingCallbackLimiter, robokassaCallbackRouter);

  app.use('/api/invoices', apiKeyAuth, invoicesRouter);
  app.use('/api/mappings', apiKeyAuth, mappingsRouter);
  app.use('/api/upload', apiKeyAuth, uploadLimiter, uploadRouter);
  // /webhook (legacy 1C webhook config) and /debug (error/diagnostics) are
  // platform-global and have no non-admin UI callers — admin only.
  app.use('/api/webhook', apiKeyAuth, requireAdmin, webhookRouter);
  app.use('/api/settings', apiKeyAuth, settingsRouter);
  // Своё подключение подписки ChatGPT (режим распознавания gpt) — платформенный конфиг, только admin.
  app.use('/api/chatgpt', apiKeyAuth, requireAdmin, chatgptRouter);
  app.use('/api/ai', apiKeyAuth, aiRouter);
  // Уведомления на телефон (Web Push) для мобильного приложения /m/.
  app.use('/api/push', apiKeyAuth, pushRouter);
  app.use('/api/product-assistant', apiKeyAuth, productAssistantRouter);
  app.use('/api/debug', apiKeyAuth, requireAdmin, debugRouter);
  app.use('/api/nomenclature', apiKeyAuth, nomenclatureRouter);
  app.use('/api/profile', apiKeyAuth, profileRouter);
  app.use('/api/billing', apiKeyAuth, billingRouter);
  app.use('/api/unit-cost', apiKeyAuth, unitCostRouter);
  app.use('/api/recognition-queue', apiKeyAuth, recognitionQueueRouter);
  app.use('/api/sber', apiKeyAuth, sberRouter);
  app.use('/api/suppliers', apiKeyAuth, suppliersRouter);
  app.use('/api/integrations', apiKeyAuth, integrationsRouter);
  app.use('/api/operations', apiKeyAuth, operationsRouter);
  // Эталоны (п.17 v2): отметка — владелец накладной, прогон и отчёты — admin
  // (requireAdmin стоит на роутах внутри).
  app.use('/api/golden', apiKeyAuth, goldenRouter);
  // Самообучение: предложения правил и правила пересчёта — в области владельца.
  app.use('/api/learning', apiKeyAuth, learningRouter);
  // «Новые товары» (п.12 v2): строки без позиции 1С — сопоставить группой или
  // «Создать в 1С». Данные строго компании вызывающего.
  app.use('/api/new-items', apiKeyAuth, newItemsRouter);
  // «Очередь в 1С»: мастер проверки неотправленных, перераспознавание очереди,
  // массовый подбор ИИ. Только накладные компании вызывающего.
  app.use('/api/queue', apiKeyAuth, queueRouter);
  // «Аналитика» (п.7, п.11): качество по поставщикам и закупочные цены — только
  // чтение, строго данные компании вызывающего.
  app.use('/api/analytics', apiKeyAuth, analyticsRouter);
  // Self-service: генерация кода подключения доступна любому пользователю.
  app.use('/api/onec', apiKeyAuth, onecUserRouter);
  app.use('/api/onec', apiKeyAuth, requireAdmin, onecAdminRouter);
  app.use('/api/inbound', apiKeyAuth, inboundConfigRouter);
  // User management (list + role changes) — admin only.
  app.use('/api/users', apiKeyAuth, requireAdmin, usersRouter);

  // Мобильное приложение /m/ (PWA и APK), старая /camera ведёт туда же,
  // подтверждение ключа APK (/.well-known/assetlinks.json) и сам APK.
  registerMobileRoutes(app, publicDir, {
    downloadsDir: config.downloadsDir,
    androidCertSha256: config.androidCertSha256,
  });

  // GET /magic/:token — one-click вход через magic-ссылку из welcome/recover
  // письма. На strict-успехе отдаём крошечную HTML-страницу: она кладёт apiKey
  // в localStorage инлайн-скриптом и редиректит в кабинет. Сам token из URL
  // не остаётся в browser history (replace() вместо assign()).
  // Slug-валидация: 32 hex символа — отсекает мусор/SQL до touch'а БД.
  app.get('/magic/:token', async (req, res) => {
    const token = req.params.token;
    if (!/^[a-f0-9]{32}$/.test(token)) {
      res.status(404).type('html').send('<h1>Ссылка недействительна</h1><p>Если письмо старое, попробуйте восстановить доступ на <a href="/">scanflow.ru</a>.</p>');
      return;
    }
    let user;
    try {
      user = await userRepo.findByMagicToken(token);
    } catch (e) {
      logger.error('magic-link lookup failed', { error: (e as Error).message });
      res.status(500).type('html').send('<h1>Внутренняя ошибка</h1>');
      return;
    }
    if (!user) {
      res.status(404).type('html').send('<h1>Ссылка недействительна</h1><p>Возможно, вы запросили новое письмо — старая ссылка перестала работать. Откройте свежее письмо.</p>');
      return;
    }
    // GET only validates the token. The browser exchanges it through same-origin
    // POST below, so mail-provider link scanners cannot consume a one-time link
    // merely by prefetching the URL.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.type('html').send(`<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><title>Входим в ScanFlow…</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#fafafa;color:#171717;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}p{font-size:14px;color:#737373}@media (prefers-color-scheme:dark){body{background:#000;color:#ededed}p{color:#a1a1a1}}</style>
</head><body><p>Открываем кабинет…</p>
<script>
  (async () => {
    try {
      const response = await fetch('/magic/${token}/consume', {
        method: 'POST',
        headers: { 'Accept': 'application/json' },
      });
      const session = await response.json().catch(() => ({}));
      if (!response.ok || !session.apiKey) throw new Error('invalid magic link');
      localStorage.setItem('apiKey', session.apiKey);
      localStorage.setItem('adminUsername', session.username);
      localStorage.setItem('adminRole', session.role);
      // Onboarding-wizard покажется автоматически, если шаги не завершены.
      location.replace('/app.html#/onboarding');
    } catch (e) {
      document.body.innerHTML = '<p>Ссылка уже использована или устарела. Войдите вручную с данными из письма.</p>';
    }
  })();
</script>
</body></html>`);
  });

  // POST /magic/:token/consume — atomically exchange a valid one-time link for
  // the user's existing API key. Kept separate from GET to tolerate safe-link
  // scanners that prefetch email URLs.
  app.post('/magic/:token/consume', async (req, res) => {
    const token = req.params.token;
    if (!/^[a-f0-9]{32}$/.test(token)) {
      res.status(404).json({ error: 'Ссылка для входа устарела или уже использована' });
      return;
    }
    try {
      const user = await userRepo.consumeMagicToken(token);
      if (!user) {
        res.status(404).json({ error: 'Ссылка для входа устарела или уже использована' });
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({ apiKey: user.api_key, username: user.username, role: user.role });
    } catch (e) {
      logger.error('magic-link consume failed', { error: (e as Error).message });
      res.status(500).json({ error: 'Ошибка сервера. Попробуйте ещё раз' });
    }
  });

  // ─── SEO + Blog + AI Markdown routes (0 DB SELECT, 0 RAM heap cache) ───

  const sendPromoMarkdown = (
    res: express.Response,
    markdown: string,
    canonicalUrl: string,
    explicitMdUrl: boolean
  ) => {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Vary', 'Accept');
    res.setHeader('Link', `<${canonicalUrl}>; rel="canonical"`);
    res.setHeader('Content-Signal', 'search=yes, ai-input=yes, ai-train=no');
    if (explicitMdUrl) {
      res.setHeader('X-Robots-Tag', 'noindex, follow');
    }
    res.status(200).send(markdown);
  };

  app.get('/sitemap.xml', (_req, res) => {
    const bundle = readOrBuildPromoBundle(publicDir);
    res.type('application/xml').send(bundle.sitemapXml);
  });

  // RSS блога — до /blog/:slug (у того slug без точки, «rss.xml» ушёл бы в 404).
  app.get('/blog/rss.xml', (_req, res) => {
    const bundle = readOrBuildPromoBundle(publicDir);
    res.type('application/rss+xml; charset=utf-8').send(bundle.rssXml);
  });

  app.get('/llms.txt', (_req, res) => {
    const bundle = readOrBuildPromoBundle(publicDir);
    res.setHeader('Content-Signal', 'search=yes, ai-input=yes, ai-train=no');
    res.type('text/plain; charset=utf-8').send(bundle.llmsTxt);
  });

  app.get('/llms-full.txt', (_req, res) => {
    const bundle = readOrBuildPromoBundle(publicDir);
    res.setHeader('Content-Signal', 'search=yes, ai-input=yes, ai-train=no');
    res.type('text/plain; charset=utf-8').send(bundle.llmsFullTxt);
  });

  app.get('/index.md', (_req, res) => {
    const bundle = readOrBuildPromoBundle(publicDir);
    sendPromoMarkdown(res, bundle.landingMarkdown, 'https://scanflow.ru/', true);
  });

  app.get('/blog.md', (_req, res) => {
    const bundle = readOrBuildPromoBundle(publicDir);
    sendPromoMarkdown(res, bundle.blogIndexMarkdown, 'https://scanflow.ru/blog', true);
  });

  app.get('/blog', (req, res) => {
    const bundle = readOrBuildPromoBundle(publicDir);
    if (prefersMarkdown(req.headers.accept)) {
      return sendPromoMarkdown(res, bundle.blogIndexMarkdown, 'https://scanflow.ru/blog', false);
    }
    res.setHeader('Vary', 'Accept');
    res.type('html').send(bundle.blogIndexHtml);
  });

  app.get('/blog/:slug', (req, res) => {
    const rawParam = req.params.slug;
    const isExplicitMd = rawParam.endsWith('.md') && rawParam.length > 3;
    const slug = isExplicitMd ? rawParam.slice(0, -3) : rawParam;
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return res.status(404).send('Not Found');

    const bundle = readOrBuildPromoBundle(publicDir);
    const entry = bundle.articlesBySlug[slug];
    if (!entry) return res.status(404).send('Not Found');

    if (isExplicitMd || prefersMarkdown(req.headers.accept)) {
      return sendPromoMarkdown(res, entry.markdown, `https://scanflow.ru/blog/${slug}`, isExplicitMd);
    }
    res.setHeader('Vary', 'Accept');
    res.type('html').send(entry.html);
  });

  for (const slug of LEGAL_PAGES) {
    app.get(`/${slug}.md`, (_req, res) => {
      const bundle = readOrBuildPromoBundle(publicDir);
      sendPromoMarkdown(res, bundle.legalBySlug[slug].markdown, `https://scanflow.ru/${slug}`, true);
    });

    app.get(`/${slug}`, (req, res) => {
      const bundle = readOrBuildPromoBundle(publicDir);
      if (prefersMarkdown(req.headers.accept)) {
        return sendPromoMarkdown(res, bundle.legalBySlug[slug].markdown, `https://scanflow.ru/${slug}`, false);
      }
      res.setHeader('Vary', 'Accept');
      res.type('html').send(bundle.legalBySlug[slug].html);
    });
  }

  app.get('/', (req, res) => {
    const bundle = readOrBuildPromoBundle(publicDir);
    if (prefersMarkdown(req.headers.accept)) {
      return sendPromoMarkdown(res, bundle.landingMarkdown, 'https://scanflow.ru/', false);
    }
    res.setHeader('Vary', 'Accept');
    res.type('html').send(bundle.landingHtml);
  });

  // Всё, что не нашлось выше, — честный 404. Кабинет и лендинг маршрутизируются
  // через #hash, сервер этих путей не видит. Раньше здесь отдавалась главная
  // с кодом 200: поисковики видели дубли главной на любом адресе, а /favicon.ico
  // и прочие иконки «существовали» как HTML. Маршрут с параметром оставлен,
  // чтобы мусорные URL сканеров по-прежнему давали 400 через terminalErrorHandler.
  app.get('/{*splat}', (req, res) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.status(404).sendFile('404.html', { root: publicDir });
  });

  // Terminal error handler (must be the LAST app.use): multer → 413/400,
  // мусорный URL → 400 + warn, остальное → JSON 500 + error-лог.
  app.use(terminalErrorHandler);

  logger.info('Serving dashboard from', { path: publicDir });

  return app;
}

export function startServer(fileWatcher: FileWatcher, mapper: NomenclatureMapper): import('http').Server {
  const app = createServer(fileWatcher, mapper);

  const server = app.listen(config.apiPort, () => {
    logger.info(`API server listening on port ${config.apiPort}`);
    logger.info(`Health check: http://localhost:${config.apiPort}/health`);
    logger.info(`Dashboard: http://localhost:${config.apiPort}/`);
  });
  return server;
}
