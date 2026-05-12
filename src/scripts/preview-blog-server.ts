/**
 * Standalone preview server for the SEO/blog feature without DB.
 * Same routes as src/api/server.ts for blog/sitemap/landing, but skips
 * the OCR/Sber/DB initialisation entirely. Use it to eyeball the rendered
 * listing + landing-with-preview-cards locally:
 *
 *   npx ts-node src/scripts/preview-blog-server.ts
 *   → http://localhost:8900/
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import { loadArticles } from '../seo/articles';
import { buildSitemapXml } from '../seo/sitemap';
import { renderListingHtml, renderPreviewHtml } from '../seo/blogRender';

const app = express();
const publicDir = path.resolve(process.cwd(), 'public');
const PORT = Number(process.env.PORT) || 8900;

// /blog/ → /blog redirect, must precede express.static (same as server.ts).
app.use((req, res, next) => {
  if (req.method === 'GET' && req.path === '/blog/') {
    return res.redirect(301, '/blog');
  }
  next();
});

// Mock /api/* — preview server has no DB. Returns sensible empty / success
// payloads so the dashboard UI renders all sections without 401s or 500s.
app.use(express.json());

const MOCK_USER = {
  apiKey: 'preview-dev-key',
  username: 'preview-admin',
  role: 'admin',
};

// Sample invoices so the dashboard list page has rows to render — needed for
// чтобы можно было кликать «развернуть» и смотреть фильтры на стат-карточках.
const MOCK_INVOICES = [
  {
    id: 1247,
    invoice_number: 'УТ-0024519',
    invoice_date: '2026-04-28',
    supplier: 'ООО "Продукты Алтая"',
    total_sum: 47830.5,
    status: 'sent_to_1c',
    sber_payment_status: 'created',
    sber_payment_number: 'PP-2026-0418',
    items_total_mismatch: 0,
    file_name: 'inv-2026-04-28-1247.jpg',
    ocr_engine: 'claude_api',
    created_at: '2026-04-28T09:14:32Z',
  },
  {
    id: 1246,
    invoice_number: 'ТН-991/04',
    invoice_date: '2026-04-27',
    supplier: 'ИП Бочкарёв А.С.',
    total_sum: 12450,
    status: 'processed',
    sber_payment_status: null,
    items_total_mismatch: 1,
    file_name: 'inv-2026-04-27-1246.jpg',
    ocr_engine: 'claude_api+multipage',
    created_at: '2026-04-27T16:42:11Z',
  },
  {
    id: 1245,
    invoice_number: '00-00012',
    invoice_date: '2026-04-26',
    supplier: 'АО "Сибирский хлеб"',
    total_sum: 8120,
    status: 'processed',
    sber_payment_status: 'pending',
    items_total_mismatch: 0,
    file_name: 'inv-2026-04-26-1245.jpg',
    ocr_engine: 'claude_api',
    created_at: '2026-04-26T11:07:55Z',
  },
  {
    id: 1244,
    invoice_number: 'ТН-7723',
    invoice_date: '2026-04-25',
    supplier: 'ООО "Колос"',
    total_sum: 65240.75,
    status: 'new',
    sber_payment_status: null,
    items_total_mismatch: 0,
    file_name: 'inv-2026-04-25-1244.jpg',
    ocr_engine: 'google_vision+claude_api',
    created_at: '2026-04-25T08:30:00Z',
  },
];

const mockTable: Array<{ test: RegExp; handler: (req: express.Request, res: express.Response) => void }> = [
  // Auth — accept any creds
  { test: /^\/api\/auth\/login$/, handler: (_req, res) => res.json(MOCK_USER) },
  // Register — мок без БД: примитивная валидация и сразу возвращаем «созданного»
  // юзера с теми же креденшалами что и MOCK_USER, чтобы фронт smoke-тестировался.
  { test: /^\/api\/auth\/register$/, handler: (req, res) => {
    const body = (req as express.Request).body || {};
    const u = (body.username || '').trim();
    if (!/^[a-zA-Z0-9_]{3,30}$/.test(u)) {
      res.status(400).json({ error: 'Логин: 3–30 символов, латиница, цифры, _' });
      return;
    }
    if (typeof body.password !== 'string' || body.password.length < 6) {
      res.status(400).json({ error: 'Пароль должен быть не короче 6 символов' });
      return;
    }
    // В preview всегда «успех» — у этой формы нет хранилища пользователей.
    res.status(201).json({ apiKey: MOCK_USER.apiKey, username: u, role: 'user' });
  }},

  // Invoices — server wraps responses in { data: ... }
  { test: /^\/api\/invoices\/stats$/, handler: (_req, res) => res.json({
    data: {
      total: 12,
      byStatus: [
        { status: 'new', count: 1 },
        { status: 'processed', count: 8 },
        { status: 'sent_to_1c', count: 3 },
        { status: 'error', count: 0 },
      ],
    },
  })},
  { test: /^\/api\/invoices\/pending$/, handler: (_req, res) => res.json({ data: [] }) },
  { test: /^\/api\/invoices(\?.*)?$/, handler: (_req, res) => res.json({ data: MOCK_INVOICES }) },
  { test: /^\/api\/invoices\/\d+/, handler: (_req, res) => res.status(404).json({ error: 'No data in preview mode' }) },

  // Mappings — server wraps in { data: { grouped, unmapped } }
  { test: /^\/api\/mappings(\?.*)?$/, handler: (_req, res) => res.json({ data: { grouped: [], unmapped: [] } }) },

  // Suppliers
  { test: /^\/api\/suppliers(\?.*)?$/, handler: (_req, res) => res.json([]) },

  // Sber
  { test: /^\/api\/sber\/status$/, handler: (_req, res) => res.json({ connected: false, organization: null }) },
  { test: /^\/api\/sber\/payer$/, handler: (_req, res) => res.json({}) },

  // Webhook
  { test: /^\/api\/webhook\/config$/, handler: (_req, res) => res.json({ url: '', token: '', enabled: false }) },

  // Settings
  { test: /^\/api\/settings\/analyzer$/, handler: (_req, res) => res.json({
    mode: 'claude_api',
    claude_model: 'claude-sonnet-4-6',
    anthropic_api_key: '',
    llm_mapper_enabled: true,
    auto_send_to_1c: false,
    auto_send_to_sber: false,
  })},

  // Profile
  { test: /^\/api\/profile$/, handler: (_req, res) => res.json({
    email: '', notify_mode: 'off', notify_events: [],
    telegram_chat_id: null, telegram_bot_token: null,
    username: MOCK_USER.username, role: MOCK_USER.role,
  })},

  // Nomenclature (1C catalog) — client reads { data, last_synced_at }
  { test: /^\/api\/nomenclature(\/.*)?(\?.*)?$/, handler: (_req, res) => res.json({ data: [], last_synced_at: null }) },

  // Debug
  { test: /^\/api\/debug(\/.*)?$/, handler: (_req, res) => res.json([]) },
];

app.use('/api', (req, res, next) => {
  const fullPath = req.originalUrl;
  for (const { test, handler } of mockTable) {
    if (test.test(fullPath)) {
      handler(req, res);
      return;
    }
  }
  // Default: write/patch ops succeed silently; reads return empty array
  if (req.method === 'GET') {
    return res.json([]);
  }
  return res.json({ ok: true, preview: true });
});

// index:false — иначе express.static сам отдаёт index.html для GET / и
// перехватывает кастомный route ниже (где инжектятся blog-preview карточки).
app.use(express.static(publicDir, { redirect: false, index: false }));

// /sitemap.xml
app.get('/sitemap.xml', (_req, res) => {
  const articles = loadArticles();
  res.type('application/xml').send(buildSitemapXml('http://localhost:' + PORT, articles));
});

// /blog listing with server-side card/chip injection
app.get('/blog', (_req, res) => {
  const raw = fs.readFileSync(path.join(publicDir, 'blog/index.html'), 'utf8');
  res.type('html').send(renderListingHtml(raw, loadArticles()));
});

// /blog/:slug
app.get('/blog/:slug', (req, res) => {
  const slug = req.params.slug;
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return res.status(404).send('Not Found');
  const file = path.join(publicDir, 'blog', `${slug}.html`);
  if (!fs.existsSync(file)) return res.status(404).send('Not Found');
  res.sendFile(file);
});

// / with preview injection
app.get('/', (_req, res) => {
  const raw = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  res.type('html').send(renderPreviewHtml(raw, loadArticles()) || raw);
});

// SPA fallback (mirrors server.ts behaviour for hash routes inside the SPA)
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Preview blog server on http://localhost:${PORT}/`);
  console.log(`  /                       → landing with rendered blog-preview cards`);
  console.log(`  /blog                   → listing with rendered cards`);
  console.log(`  /blog/<slug>            → individual article`);
  console.log(`  /sitemap.xml            → dynamic sitemap`);
});
