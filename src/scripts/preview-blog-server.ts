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

app.use(express.static(publicDir, { redirect: false }));

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
