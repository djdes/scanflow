# SEO + Blog + Initial Content Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an SEO-foundationed scanflow.ru with a six-article blog at `/blog/`, hand-written content, and a landing-page section that surfaces the three newest articles — all without introducing a build step for the client.

**Architecture:** Pure static HTML for the blog (`public/blog/<slug>.html`), a single `public/blog/articles.json` as metadata source-of-truth, and three new Express handlers (`/sitemap.xml`, `/robots.txt`, `/blog`, `/blog/:slug`) registered _before_ the SPA fallback. The landing's "latest articles" section is rendered server-side by substituting a marker in an in-memory copy of `index.html` at server startup. JSON-LD scripts are inlined per page. CSS lives in a new `public/css/article.css` that extends `landing.css` via shared CSS custom properties.

**Tech Stack:** Express 5 + TypeScript (existing), vitest + supertest for HTTP tests (existing), vanilla HTML/CSS for the blog (existing project rule: no client-side build step). No new dependencies.

---

## Pre-flight

Before starting:

- Read [`docs/superpowers/specs/2026-05-11-seo-blog-content-design.md`](../specs/2026-05-11-seo-blog-content-design.md) end-to-end — the plan executes against it.
- Read [`CLAUDE.md`](../../../CLAUDE.md) for project conventions, especially: every async migration is done, all route order matters, never break the `skipKeywords` parser regex (irrelevant here but important not to touch).
- Familiarize with the existing landing files:
  - [`public/index.html`](../../../public/index.html) — landing markup, head with anti-FOUC theme script, navbar, sections, FAQ accordion at `#faq`, signup at `#auth`.
  - [`public/css/landing.css`](../../../public/css/landing.css) — design tokens at `:root` and `[data-theme="light"]`, bento components, theme switcher.
  - [`public/js/landing.js`](../../../public/js/landing.js) — IntersectionObserver `data-animate`, theme switcher, magnetic CTA, FAQ accordion.
- Test runner: `npm test` (vitest). HTTP tests use `supertest`. See [`tests/api/profile.test.ts`](../../../tests/api/profile.test.ts) for the pattern (mock repos, import `createServer`, drive via supertest).
- Dev server: `npm run dev` starts on port 8899 (nodemon + ts-node). For UI verification, a static-only preview is `cd public && python -m http.server 8899` — fastest way to inspect blog HTML without a TS rebuild.
- Project memory under `C:\Users\Yaroslav\.claude\projects\c--www-ScanFlow\memory\`: `feedback_landing_design_language.md` is binding — every new UI must use the existing tokens, fonts, and component vocabulary. `feedback_git_workflow.md` — commit eagerly after every logical chunk, never push.

Working dir for all commands: `c:\www\ScanFlow`.

Commit prefix convention (mirrors recent log): `feat(landing)`, `feat(seo)`, `feat(blog)`, `docs(seo)`, `feat(content)`, `test(blog)`.

---

## Phase 0: Foundations (server-side helpers + tests)

### Task 0.1: `articles.json` schema + initial empty file

**Files:**
- Create: `public/blog/articles.json`
- Create: `src/seo/articles.ts`
- Test: `tests/seo/articles.test.ts`

- [ ] **Step 1: Create the empty articles.json with the schema declared via a top-level "_schema" comment-style key**

Write file `public/blog/articles.json`:

```json
{
  "_schema": "Each article has slug, title (≤60), description (140-160), tags[], date (YYYY-MM-DD), readingMinutes (int), ogImage (path), updated? (YYYY-MM-DD optional). 'tags' use the slugs in docs/.../seo-blog-content-design.md tag taxonomy.",
  "articles": []
}
```

- [ ] **Step 2: Create `src/seo/articles.ts` with the typed loader**

```typescript
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

export interface Article {
  slug: string;
  title: string;
  description: string;
  tags: string[];
  date: string;             // ISO YYYY-MM-DD
  readingMinutes: number;
  ogImage: string;          // path relative to site root, e.g. "/og/default.jpg"
  updated?: string;
}

export interface ArticlesIndex {
  articles: Article[];
}

const ARTICLES_JSON = path.resolve(process.cwd(), 'public/blog/articles.json');

/**
 * Load and validate articles.json. Returns a sorted-by-date (descending) array.
 * On any error returns []. Never throws — a missing or malformed file should
 * gracefully degrade to "no articles", not crash the server.
 */
export function loadArticles(filePath: string = ARTICLES_JSON): Article[] {
  try {
    if (!fs.existsSync(filePath)) {
      logger.warn('articles.json missing — blog will render empty', { filePath });
      return [];
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw) as Partial<ArticlesIndex>;
    if (!data || !Array.isArray(data.articles)) return [];
    const valid = data.articles.filter(isValid);
    return [...valid].sort((a, b) => b.date.localeCompare(a.date));
  } catch (err) {
    logger.error('Failed to load articles.json', { error: (err as Error).message });
    return [];
  }
}

function isValid(a: unknown): a is Article {
  if (!a || typeof a !== 'object') return false;
  const x = a as Record<string, unknown>;
  return (
    typeof x.slug === 'string' && /^[a-z0-9-]+$/.test(x.slug) &&
    typeof x.title === 'string' && x.title.length > 0 &&
    typeof x.description === 'string' && x.description.length > 0 &&
    Array.isArray(x.tags) && x.tags.every((t) => typeof t === 'string') &&
    typeof x.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.date) &&
    typeof x.readingMinutes === 'number' && x.readingMinutes > 0 &&
    typeof x.ogImage === 'string'
  );
}

/**
 * Return all distinct tag slugs across articles, preserving the order of
 * first appearance (so the tag chips render in a stable order).
 */
export function distinctTags(articles: Article[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of articles) for (const t of a.tags) if (!seen.has(t)) { seen.add(t); out.push(t); }
  return out;
}

/**
 * Pick up to N articles that share at least one tag with the source, excluding the source itself.
 * Used for the "Related" section at the end of each article.
 */
export function relatedArticles(all: Article[], source: Article, n = 3): Article[] {
  const tagSet = new Set(source.tags);
  return all
    .filter((a) => a.slug !== source.slug && a.tags.some((t) => tagSet.has(t)))
    .slice(0, n);
}
```

- [ ] **Step 3: Create test `tests/seo/articles.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadArticles, distinctTags, relatedArticles, Article } from '../../src/seo/articles';

function tmpJson(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-articles-'));
  const p = path.join(dir, 'articles.json');
  fs.writeFileSync(p, contents, 'utf8');
  return p;
}

const sample: Article = {
  slug: 'a', title: 'A', description: 'd', tags: ['ocr'], date: '2026-05-01',
  readingMinutes: 5, ogImage: '/og/default.jpg',
};

describe('loadArticles', () => {
  it('returns [] when file is missing', () => {
    expect(loadArticles('/nonexistent.json')).toEqual([]);
  });

  it('returns [] when JSON is malformed', () => {
    const p = tmpJson('{ not json');
    expect(loadArticles(p)).toEqual([]);
  });

  it('returns [] when articles is not an array', () => {
    const p = tmpJson('{"articles": "nope"}');
    expect(loadArticles(p)).toEqual([]);
  });

  it('filters out invalid entries', () => {
    const p = tmpJson(JSON.stringify({
      articles: [sample, { ...sample, slug: 'BAD SLUG WITH SPACES' }],
    }));
    expect(loadArticles(p).map((a) => a.slug)).toEqual(['a']);
  });

  it('sorts by date descending', () => {
    const p = tmpJson(JSON.stringify({
      articles: [
        { ...sample, slug: 'old', date: '2026-01-01' },
        { ...sample, slug: 'new', date: '2026-05-01' },
        { ...sample, slug: 'mid', date: '2026-03-01' },
      ],
    }));
    expect(loadArticles(p).map((a) => a.slug)).toEqual(['new', 'mid', 'old']);
  });
});

describe('distinctTags', () => {
  it('preserves order of first appearance', () => {
    expect(distinctTags([
      { ...sample, slug: '1', tags: ['ocr', '1c-unf'] },
      { ...sample, slug: '2', tags: ['1c-unf', 'sber'] },
      { ...sample, slug: '3', tags: ['ocr', 'sber'] },
    ])).toEqual(['ocr', '1c-unf', 'sber']);
  });
});

describe('relatedArticles', () => {
  it('returns articles sharing at least one tag, excluding source', () => {
    const all: Article[] = [
      { ...sample, slug: 'src', tags: ['ocr', 'sber'] },
      { ...sample, slug: 'a',   tags: ['ocr'] },
      { ...sample, slug: 'b',   tags: ['sber', '1c-unf'] },
      { ...sample, slug: 'c',   tags: ['multi-page'] },
    ];
    const r = relatedArticles(all, all[0], 3).map((a) => a.slug);
    expect(r).toEqual(['a', 'b']);
  });

  it('respects N', () => {
    const all: Article[] = [
      { ...sample, slug: 'src', tags: ['ocr'] },
      { ...sample, slug: '1',   tags: ['ocr'] },
      { ...sample, slug: '2',   tags: ['ocr'] },
      { ...sample, slug: '3',   tags: ['ocr'] },
    ];
    expect(relatedArticles(all, all[0], 2).length).toBe(2);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/seo/articles.test.ts`
Expected: 7 passing.

- [ ] **Step 5: Commit**

```bash
git -c safe.directory=C:/www/ScanFlow add public/blog/articles.json src/seo/articles.ts tests/seo/articles.test.ts
git -c safe.directory=C:/www/ScanFlow commit -m "feat(seo): articles.json loader with validation + tests"
```

---

### Task 0.2: Sitemap builder

**Files:**
- Create: `src/seo/sitemap.ts`
- Test: `tests/seo/sitemap.test.ts`

- [ ] **Step 1: Write the failing test `tests/seo/sitemap.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { buildSitemapXml } from '../../src/seo/sitemap';
import type { Article } from '../../src/seo/articles';

const a = (slug: string, date: string): Article => ({
  slug, title: 't', description: 'd', tags: ['ocr'], date,
  readingMinutes: 5, ogImage: '/og/default.jpg',
});

describe('buildSitemapXml', () => {
  it('includes home and blog with priority and changefreq', () => {
    const xml = buildSitemapXml('https://scanflow.ru', []);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<loc>https://scanflow.ru/</loc>');
    expect(xml).toContain('<loc>https://scanflow.ru/blog</loc>');
    expect(xml).toMatch(/<priority>1\.0<\/priority>/);
  });

  it('appends a <url> for each article with lastmod', () => {
    const xml = buildSitemapXml('https://scanflow.ru', [a('foo', '2026-05-01'), a('bar', '2026-04-01')]);
    expect(xml).toContain('<loc>https://scanflow.ru/blog/foo</loc>');
    expect(xml).toContain('<lastmod>2026-05-01</lastmod>');
    expect(xml).toContain('<loc>https://scanflow.ru/blog/bar</loc>');
    expect(xml).toContain('<lastmod>2026-04-01</lastmod>');
  });

  it('escapes slugs against XML injection', () => {
    const xml = buildSitemapXml('https://scanflow.ru', [a('bad&slug', '2026-01-01')]);
    expect(xml).not.toContain('&slug');
    expect(xml).toContain('bad&amp;slug');
  });

  it('uses article.updated when present, falls back to date', () => {
    const art = { ...a('foo', '2026-01-01'), updated: '2026-05-10' };
    const xml = buildSitemapXml('https://scanflow.ru', [art]);
    expect(xml).toContain('<lastmod>2026-05-10</lastmod>');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/seo/sitemap.test.ts`
Expected: FAIL ("Cannot find module './sitemap'").

- [ ] **Step 3: Implement `src/seo/sitemap.ts`**

```typescript
import { Article } from './articles';

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Build a sitemap.xml document for the site. Static entries are the landing
 * and the blog index; dynamic entries are one per article. `lastmod` uses
 * article.updated when present and falls back to article.date.
 */
export function buildSitemapXml(siteUrl: string, articles: Article[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    `  <url>`,
    `    <loc>${siteUrl}/</loc>`,
    `    <lastmod>${today}</lastmod>`,
    `    <changefreq>monthly</changefreq>`,
    `    <priority>1.0</priority>`,
    `  </url>`,
    `  <url>`,
    `    <loc>${siteUrl}/blog</loc>`,
    `    <lastmod>${today}</lastmod>`,
    `    <changefreq>weekly</changefreq>`,
    `    <priority>0.8</priority>`,
    `  </url>`,
  ];
  for (const a of articles) {
    const lastmod = a.updated ?? a.date;
    lines.push(`  <url>`);
    lines.push(`    <loc>${siteUrl}/blog/${xmlEscape(a.slug)}</loc>`);
    lines.push(`    <lastmod>${lastmod}</lastmod>`);
    lines.push(`    <changefreq>monthly</changefreq>`);
    lines.push(`    <priority>0.7</priority>`);
    lines.push(`  </url>`);
  }
  lines.push('</urlset>');
  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/seo/sitemap.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git -c safe.directory=C:/www/ScanFlow add src/seo/sitemap.ts tests/seo/sitemap.test.ts
git -c safe.directory=C:/www/ScanFlow commit -m "feat(seo): sitemap.xml builder + tests"
```

---

### Task 0.3: Static `robots.txt`

**Files:**
- Create: `public/robots.txt`

- [ ] **Step 1: Create the file**

Write `public/robots.txt`:

```
User-agent: *
Allow: /
Disallow: /app.html
Disallow: /camera
Disallow: /api/

Sitemap: https://scanflow.ru/sitemap.xml
```

- [ ] **Step 2: Commit**

```bash
git -c safe.directory=C:/www/ScanFlow add public/robots.txt
git -c safe.directory=C:/www/ScanFlow commit -m "feat(seo): static robots.txt"
```

`express.static(publicDir)` already serves it at `/robots.txt`. No route needed.

---

### Task 0.4: Default OG image placeholder

**Files:**
- Create: `public/og/.gitkeep`
- Create: `public/og/default.svg`

- [ ] **Step 1: Create the SVG placeholder OG image**

This is a vector OG until we generate per-article rasters. 1200×630, ScanFlow logo + tagline + gradient. Save as `public/og/default.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1200" y2="630" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#06080d"/>
      <stop offset="100%" stop-color="#0c1018"/>
    </linearGradient>
    <linearGradient id="brand" x1="0" y1="0" x2="600" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#3b82f6"/>
      <stop offset="100%" stop-color="#06d6a0"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <g transform="translate(80,80)">
    <rect x="0" y="0" width="64" height="64" rx="14" fill="none" stroke="url(#brand)" stroke-width="4"/>
    <text x="80" y="44" font-family="Outfit, sans-serif" font-size="36" font-weight="700" fill="#e8ecf4">ScanFlow</text>
  </g>
  <text x="80" y="340" font-family="Outfit, sans-serif" font-size="92" font-weight="800" fill="#e8ecf4">Скан → платёжка</text>
  <text x="80" y="450" font-family="Outfit, sans-serif" font-size="92" font-weight="800" fill="url(#brand)">за 3 секунды</text>
  <text x="80" y="540" font-family="Outfit, sans-serif" font-size="28" font-weight="500" fill="#8892a4">OCR-накладные → 1С УНФ · СберБизнес · Telegram</text>
</svg>
```

- [ ] **Step 2: Also create `public/og/.gitkeep`**

Empty file. Ensures the dir is tracked.

```bash
echo. > public/og/.gitkeep
```

- [ ] **Step 3: Commit**

```bash
git -c safe.directory=C:/www/ScanFlow add public/og/default.svg public/og/.gitkeep
git -c safe.directory=C:/www/ScanFlow commit -m "feat(seo): default OG image (1200x630 SVG)"
```

OG tags will reference `/og/default.svg`. Twitter and Facebook both accept SVG via the `og:image` and `twitter:image` tags. If a crawler rejects SVG, we'll generate a PNG follow-up — out of scope for this round per the spec.

---

## Phase 1: Express routes (sitemap, robots, blog, /blog/:slug)

### Task 1.1: Add helper `src/seo/articles.ts` exports

Already covered by 0.1. Skip if previous task ran.

---

### Task 1.2: Wire `/sitemap.xml` and `/blog`, `/blog/:slug` into `createServer`

**Files:**
- Modify: `src/api/server.ts`
- Test: `tests/api/blog-routes.test.ts`

- [ ] **Step 1: Write the failing HTTP test `tests/api/blog-routes.test.ts`**

```typescript
import { describe, it, expect, beforeAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Mock all the heavy deps that createServer pulls in, so the test only exercises
// route wiring. We don't need DB/OCR/Sber here.
vi.mock('../../src/database/db', () => ({ getDb: () => ({ prepare: () => ({ get: () => 1 }) }) }));
vi.mock('../../src/watcher/fileWatcher', () => ({ FileWatcher: class {} }));
vi.mock('../../src/mapping/nomenclatureMapper', () => ({ NomenclatureMapper: class {} }));

import { createServer } from '../../src/api/server';
import { FileWatcher } from '../../src/watcher/fileWatcher';
import { NomenclatureMapper } from '../../src/mapping/nomenclatureMapper';

let app: express.Express;

beforeAll(() => {
  app = createServer(new FileWatcher() as never, new NomenclatureMapper() as never);
});

describe('SEO routes', () => {
  it('GET /robots.txt returns 200 text/plain with Sitemap directive', async () => {
    const res = await request(app).get('/robots.txt');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toContain('Sitemap: https://scanflow.ru/sitemap.xml');
    expect(res.text).toContain('Disallow: /api/');
  });

  it('GET /sitemap.xml returns 200 application/xml with home and blog entries', async () => {
    const res = await request(app).get('/sitemap.xml');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/xml/);
    expect(res.text).toContain('<loc>https://scanflow.ru/</loc>');
    expect(res.text).toContain('<loc>https://scanflow.ru/blog</loc>');
  });
});

describe('Blog routes', () => {
  it('GET /blog serves the listing page', async () => {
    const res = await request(app).get('/blog');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    // The listing page contains the eyebrow text
    expect(res.text).toMatch(/Блог/);
  });

  it('GET /blog/<unknown-slug> returns 404 (not SPA fallback)', async () => {
    const res = await request(app).get('/blog/does-not-exist-xyz');
    expect(res.status).toBe(404);
  });

  it('GET / still serves the landing (SPA fallback intact for non-blog paths)', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/api/blog-routes.test.ts`
Expected: FAIL (most tests fail because routes do not exist; `/blog` returns the landing via SPA fallback).

- [ ] **Step 3: Add the routes to `src/api/server.ts`**

In `src/api/server.ts`, add this block IMMEDIATELY BEFORE the `// SPA fallback` comment at line 185:

```typescript
  // ─── SEO + Blog routes (must be before the SPA fallback) ───

  // GET /sitemap.xml — generated on each request from articles.json (cheap;
  // alternative would be a startup-time cache, but startup loadtime isn't
  // worth the staleness on dev).
  app.get('/sitemap.xml', (_req, res) => {
    const articles = loadArticles();
    const xml = buildSitemapXml('https://scanflow.ru', articles);
    res.type('application/xml').send(xml);
  });

  // GET /blog — canonical listing (no trailing slash). /blog/ → 301 to /blog.
  app.get('/blog/', (_req, res) => res.redirect(301, '/blog'));
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
```

Also at the top of the file, add the imports (right after the existing `path` import):

```typescript
import fs from 'fs';
import { loadArticles } from '../seo/articles';
import { buildSitemapXml } from '../seo/sitemap';
```

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/api/blog-routes.test.ts`
Expected: 5 passing. The `/blog` test passes because `public/blog/index.html` will exist by Task 2.2; if running before that, the test will fail — that's OK, we'll re-run the suite after Task 2.2.

If running this in isolation right now (before Task 2.2): the `GET /blog` test will return 200 from the SPA fallback (because the file doesn't exist yet, `res.sendFile` will error and Express defaults to 500 or, depending on config, falls through). Mark this test `.skip` temporarily and re-enable in Task 2.2.

Actually, simpler: create a minimal placeholder `public/blog/index.html` now so the test passes, then replace it fully in Task 2.2.

- [ ] **Step 5: Create placeholder `public/blog/index.html`**

```html
<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8"><title>Блог</title></head>
<body><h1>Блог</h1></body></html>
```

- [ ] **Step 6: Re-run tests**

Run: `npm test -- tests/api/blog-routes.test.ts`
Expected: 5 passing.

- [ ] **Step 7: Commit**

```bash
git -c safe.directory=C:/www/ScanFlow add src/api/server.ts public/blog/index.html tests/api/blog-routes.test.ts
git -c safe.directory=C:/www/ScanFlow commit -m "feat(blog): /sitemap.xml /blog /blog/:slug routes registered before SPA fallback"
```

---

## Phase 2: Blog UI — listing page

### Task 2.1: Article CSS (`public/css/article.css`)

**Files:**
- Create: `public/css/article.css`

This file is large (~400 lines) because it covers the full article typography system, blog listing grid, and per-page chrome. Write it all in one go.

- [ ] **Step 1: Create `public/css/article.css`**

```css
/* ============================================================
   ScanFlow Article + Blog CSS
   Extends landing.css. Reuses --bg, --text, --accent-*, etc.
   ============================================================ */

/* Reset article-specific margins (the body is shared with landing) */

.article-page {
  min-height: 100vh;
}

/* ────────────── Listing page ────────────── */

.blog-hero {
  padding: 120px 0 56px;
  position: relative;
}

.blog-hero .container { position: relative; }

.blog-eyebrow {
  display: inline-block;
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 500;
  color: var(--text-muted);
  letter-spacing: 0.18em;
  text-transform: uppercase;
  margin-bottom: 18px;
}

.blog-hero h1 {
  font-family: var(--font-display);
  font-size: clamp(36px, 6vw, 64px);
  font-weight: 800;
  line-height: 1.02;
  letter-spacing: -0.03em;
  margin-bottom: 18px;
}

.blog-hero .sub {
  font-size: 18px;
  line-height: 1.6;
  color: var(--text-dim);
  max-width: 640px;
  margin-bottom: 40px;
}

.blog-tag-filter {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 56px;
}

.blog-tag-chip {
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 500;
  color: var(--text-dim);
  background: var(--surface-tint);
  border: 1px solid var(--border);
  padding: 6px 14px;
  border-radius: 100px;
  cursor: pointer;
  transition: var(--transition);
  text-transform: lowercase;
}

.blog-tag-chip:hover {
  border-color: var(--border-lit);
  color: var(--text);
}

.blog-tag-chip[aria-pressed="true"] {
  background: var(--accent-blue);
  color: var(--on-accent);
  border-color: var(--accent-blue);
}

/* Bento-like grid for cards */
.blog-grid {
  display: grid;
  grid-template-columns: 2fr 1fr;
  grid-auto-rows: minmax(180px, auto);
  gap: 16px;
  padding-bottom: 80px;
}

.blog-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  padding: 24px 26px 22px;
  display: flex;
  flex-direction: column;
  text-decoration: none;
  color: inherit;
  transition: var(--transition);
}

.blog-card:hover {
  border-color: var(--border-lit);
  transform: translateY(-3px);
  box-shadow: var(--shadow-glow);
}

.blog-card--featured { grid-column: 1; }
.blog-card--full { grid-column: 1 / -1; }

.blog-card-tags {
  display: flex;
  gap: 8px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}

.blog-card-tag {
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--accent-blue);
  background: rgba(59,130,246,0.10);
  padding: 3px 8px;
  border-radius: 100px;
}

.blog-card h3 {
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.15;
  margin-bottom: 10px;
  color: var(--text);
}

.blog-card--featured h3,
.blog-card--full h3 { font-size: 30px; }

.blog-card-desc {
  font-size: 14.5px;
  line-height: 1.6;
  color: var(--text-dim);
  margin-bottom: 18px;
  flex: 1;
}

.blog-card-meta {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text-muted);
  letter-spacing: 0.04em;
}

.blog-card-meta b { color: var(--text); font-weight: 600; }

@media (max-width: 920px) {
  .blog-grid { grid-template-columns: 1fr; }
  .blog-card--featured h3,
  .blog-card--full h3 { font-size: 24px; }
}

/* ────────────── Article page ────────────── */

.article-hero {
  padding: 120px 0 36px;
  position: relative;
}

.article-hero .container { position: relative; }

.article-breadcrumb {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 24px;
  text-transform: lowercase;
}

.article-breadcrumb a {
  color: var(--text-muted);
  text-decoration: none;
  border-bottom: 1px dotted var(--border-lit);
}

.article-breadcrumb a:hover { color: var(--accent-blue); }

.article-breadcrumb-sep { opacity: 0.5; }

.article-tags {
  display: flex;
  gap: 8px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}

.article-tag {
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--accent-blue);
  background: rgba(59,130,246,0.10);
  border: 1px solid rgba(59,130,246,0.18);
  padding: 4px 12px;
  border-radius: 100px;
}

.article-hero h1 {
  font-family: var(--font-display);
  font-size: clamp(32px, 5.5vw, 64px);
  font-weight: 800;
  line-height: 1.06;
  letter-spacing: -0.025em;
  margin-bottom: 24px;
  max-width: 820px;
}

.article-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  font-family: var(--mono);
  font-size: 13px;
  color: var(--text-muted);
  flex-wrap: wrap;
}

.article-meta .sep { opacity: 0.4; }
.article-meta b { color: var(--text); font-weight: 600; }

/* Reading-progress bar */
.read-progress {
  position: fixed;
  top: 0;
  left: 0;
  height: 3px;
  width: 0;
  background: var(--gradient);
  z-index: 1200;
  transition: width 0.1s linear;
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) { .read-progress { display: none; } }

/* Two-column article body on desktop */
.article-layout {
  display: grid;
  grid-template-columns: minmax(0, 740px) 220px;
  gap: 56px;
  padding: 32px 0 80px;
  align-items: flex-start;
}

@media (max-width: 1100px) {
  .article-layout { grid-template-columns: 1fr; gap: 0; }
  .article-toc { display: none; }
  .article-toc-mobile { display: block; }
}

@media (min-width: 1101px) {
  .article-toc-mobile { display: none; }
}

.article-toc {
  position: sticky;
  top: 100px;
  font-size: 13px;
  line-height: 1.7;
}

.article-toc-label {
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-muted);
  margin-bottom: 12px;
  padding-bottom: 10px;
  border-bottom: 1px dashed var(--border);
}

.article-toc ol,
.article-toc-mobile ol {
  list-style: none;
  padding: 0;
  margin: 0;
}

.article-toc li,
.article-toc-mobile li { padding: 4px 0; }

.article-toc a,
.article-toc-mobile a {
  color: var(--text-dim);
  text-decoration: none;
  border-left: 2px solid transparent;
  padding-left: 10px;
  display: block;
  transition: var(--transition);
}

.article-toc a:hover { color: var(--accent-blue); border-left-color: var(--accent-blue); }
.article-toc a.current { color: var(--text); border-left-color: var(--accent-blue); }

.article-toc-mobile {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 18px;
  margin-bottom: 32px;
}

.article-toc-mobile summary {
  cursor: pointer;
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
  list-style: none;
}

.article-toc-mobile summary::-webkit-details-marker { display: none; }
.article-toc-mobile summary::after { content: '↓'; float: right; transition: var(--transition); }
.article-toc-mobile[open] summary::after { transform: rotate(180deg); }

/* Prose */
.article-prose {
  font-size: 17px;
  line-height: 1.78;
  color: var(--text);
  max-width: 740px;
}

.article-prose p { margin-bottom: 1.2em; }
.article-prose p:last-child { margin-bottom: 0; }

.article-prose > p:first-of-type {
  font-size: 19px;
  color: var(--text-dim);
  line-height: 1.65;
  margin-bottom: 1.6em;
}

.article-prose h2 {
  font-family: var(--font-display);
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.1;
  margin: 56px 0 18px;
  color: var(--text);
  scroll-margin-top: 100px;
}

.article-prose h3 {
  font-family: var(--font-display);
  font-size: 21px;
  font-weight: 700;
  letter-spacing: -0.01em;
  line-height: 1.2;
  margin: 32px 0 12px;
  color: var(--text);
  scroll-margin-top: 100px;
}

.article-prose a {
  color: var(--accent-blue);
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-thickness: 1px;
}
.article-prose a:hover { text-decoration-thickness: 2px; }

.article-prose ul, .article-prose ol {
  padding-left: 22px;
  margin-bottom: 1.2em;
}
.article-prose ul li { list-style: none; position: relative; }
.article-prose ul li::before {
  content: '';
  position: absolute;
  left: -16px;
  top: 0.7em;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent-blue);
}
.article-prose ol { list-style: decimal; }
.article-prose ol li::marker { color: var(--accent-blue); font-weight: 700; }

.article-prose strong, .article-prose b { color: var(--text); font-weight: 600; }

.article-prose code {
  font-family: var(--mono);
  font-size: 0.92em;
  background: var(--surface-tint);
  border: 1px solid var(--border);
  padding: 2px 6px;
  border-radius: 4px;
}

.article-prose pre {
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: var(--radius);
  padding: 16px 20px;
  overflow-x: auto;
  margin: 1.4em 0;
  font-size: 13.5px;
  line-height: 1.6;
}

.article-prose pre code {
  background: transparent;
  border: 0;
  padding: 0;
  color: #e2e8f0;
  font-size: inherit;
}

.article-prose blockquote {
  border-left: 3px solid var(--accent-blue);
  padding-left: 18px;
  margin: 1.4em 0;
  color: var(--text-dim);
  font-style: italic;
}

.article-prose img { max-width: 100%; height: auto; border-radius: var(--radius); }

.article-prose figure { margin: 1.6em 0; }
.article-prose figcaption {
  font-size: 13px;
  color: var(--text-muted);
  text-align: center;
  margin-top: 8px;
  font-style: italic;
}

/* Callouts */
.callout {
  display: grid;
  grid-template-columns: 28px 1fr;
  gap: 14px;
  padding: 16px 18px;
  border-radius: var(--radius);
  border-left: 3px solid var(--accent-blue);
  background: rgba(59,130,246,0.06);
  margin: 1.4em 0;
  font-size: 15px;
  line-height: 1.6;
  color: var(--text);
}

.callout--tip  { border-left-color: var(--accent-green); background: rgba(6,214,160,0.08); }
.callout--warn { border-left-color: #fb923c;            background: rgba(251,146,60,0.10); }
.callout--info { border-left-color: var(--accent-blue); background: rgba(59,130,246,0.06); }

.callout-icon { font-size: 22px; line-height: 1; padding-top: 2px; }

.callout p { margin: 0; }
.callout p + p { margin-top: 0.6em; }

/* Pull-quote */
.pull-quote {
  font-family: var(--font-display);
  font-size: 28px;
  font-weight: 600;
  line-height: 1.2;
  letter-spacing: -0.02em;
  color: var(--text);
  margin: 2em 0;
  padding: 0 0 0 36px;
  position: relative;
  max-width: 700px;
}

.pull-quote::before {
  content: '"';
  position: absolute;
  left: 0;
  top: -8px;
  font-size: 60px;
  color: var(--accent-blue);
  line-height: 1;
}

/* Article footer */
.article-footer {
  border-top: 1px solid var(--border);
  padding: 56px 0 80px;
}

.article-cta {
  background: linear-gradient(135deg, rgba(59,130,246,0.08), rgba(6,214,160,0.06));
  border: 1px solid var(--border-lit);
  border-radius: var(--radius-lg);
  padding: 32px 36px;
  text-align: center;
  margin-bottom: 56px;
}

.article-cta h2 {
  font-family: var(--font-display);
  font-size: 28px;
  font-weight: 700;
  margin-bottom: 8px;
  color: var(--text);
}

.article-cta p {
  color: var(--text-dim);
  margin-bottom: 24px;
}

.related-articles h3 {
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.01em;
  margin-bottom: 20px;
  color: var(--text);
}

.related-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}

@media (max-width: 768px) {
  .related-grid { grid-template-columns: 1fr; }
  .article-prose h2 { font-size: 24px; }
  .article-cta { padding: 24px 20px; }
}

/* Decorative paper props on article hero (subtle, only 2) */
.article-hero .hero-papers .paper { opacity: 0.35; }
[data-theme="light"] .article-hero .hero-papers .paper { opacity: 0.45; }

/* Landing blog-preview section */
.blog-preview-section {
  padding: 100px 0 56px;
  position: relative;
}

.blog-preview-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  margin: 48px 0 32px;
}

@media (max-width: 920px) {
  .blog-preview-grid { grid-template-columns: 1fr; }
}

.blog-preview-cta {
  text-align: center;
  margin-top: 24px;
}
```

- [ ] **Step 2: Commit**

```bash
git -c safe.directory=C:/www/ScanFlow add public/css/article.css
git -c safe.directory=C:/www/ScanFlow commit -m "feat(blog): article.css — listing grid, article prose, callouts, ToC, blog-preview"
```

---

### Task 2.2: Listing page `public/blog/index.html`

**Files:**
- Modify: `public/blog/index.html` (replaces the Task 1.2 stub)

- [ ] **Step 1: Replace the placeholder with the real listing**

```html
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">

  <title>Блог ScanFlow — OCR накладных, 1С УНФ, Сбер, контрагенты</title>
  <meta name="description" content="Технические разборы, гайды по интеграции с 1С:УНФ и СберБизнесом, и редкие истории про то, как OCR ломается на ТОРГ-12.">
  <link rel="canonical" href="https://scanflow.ru/blog">
  <meta name="robots" content="index, follow">

  <meta property="og:type" content="website">
  <meta property="og:title" content="Блог ScanFlow">
  <meta property="og:description" content="Технические гайды по OCR накладных, 1С:УНФ, СберБизнесу и проверке контрагентов.">
  <meta property="og:url" content="https://scanflow.ru/blog">
  <meta property="og:image" content="https://scanflow.ru/og/default.svg">
  <meta property="og:site_name" content="ScanFlow">
  <meta property="og:locale" content="ru_RU">

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="Блог ScanFlow">
  <meta name="twitter:description" content="OCR накладных, 1С УНФ, СберБизнес — технические разборы">
  <meta name="twitter:image" content="https://scanflow.ru/og/default.svg">

  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800;900&family=Unbounded:wght@500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/landing.css">
  <link rel="stylesheet" href="/css/article.css">

  <script>
    // Anti-FOUC theme init (same as landing) — see /js/landing.js for full logic.
    (function () {
      function resolveAuto() {
        var h = new Date().getHours();
        if (h >= 7 && h < 19) return 'light';
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
        return 'dark';
      }
      try {
        var raw = localStorage.getItem('sf-theme');
        var mode = (raw === 'light' || raw === 'dark' || raw === 'auto') ? raw : 'auto';
        var theme = (mode === 'auto') ? resolveAuto() : mode;
        document.documentElement.setAttribute('data-theme', theme);
        document.documentElement.setAttribute('data-theme-mode', mode);
      } catch (_) { document.documentElement.setAttribute('data-theme', 'dark'); }
    })();
  </script>

  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "name": "Блог ScanFlow",
    "url": "https://scanflow.ru/blog",
    "description": "Технические гайды по OCR накладных, 1С:УНФ, СберБизнесу и проверке контрагентов."
  }
  </script>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Главная", "item": "https://scanflow.ru/" },
      { "@type": "ListItem", "position": 2, "name": "Блог",    "item": "https://scanflow.ru/blog" }
    ]
  }
  </script>
</head>
<body class="article-page">

  <div class="scan-line" aria-hidden="true"></div>
  <div class="grain-overlay" aria-hidden="true"></div>

  <!-- Header — reuses landing's site-header markup verbatim. Marked with id so theme switcher binds. -->
  <header class="site-header" id="site-header">
    <div class="container header-inner">
      <a href="/" class="logo">
        <div class="logo-icon">
          <svg width="32" height="32" viewBox="0 0 40 40" fill="none">
            <rect x="3" y="3" width="34" height="34" rx="8" stroke="url(#logo-grad)" stroke-width="2.5"/>
            <line x1="11" y1="14" x2="29" y2="14" stroke="url(#logo-grad)" stroke-width="2" stroke-linecap="round"/>
            <line x1="11" y1="20" x2="25" y2="20" stroke="url(#logo-grad)" stroke-width="2" stroke-linecap="round" opacity="0.6"/>
            <line x1="11" y1="26" x2="21" y2="26" stroke="url(#logo-grad)" stroke-width="2" stroke-linecap="round" opacity="0.35"/>
            <defs>
              <linearGradient id="logo-grad" x1="0" y1="0" x2="40" y2="40">
                <stop offset="0%" stop-color="#3b82f6"/>
                <stop offset="100%" stop-color="#06d6a0"/>
              </linearGradient>
            </defs>
          </svg>
        </div>
        <span class="logo-text">ScanFlow</span>
      </a>
      <nav class="main-nav" id="main-nav">
        <a href="/#features">Возможности</a>
        <a href="/#demo">Демо</a>
        <a href="/#pricing">Тарифы</a>
        <a href="/blog" aria-current="page">Блог</a>
      </nav>
      <div class="header-actions">
        <div class="theme-switcher" id="theme-switcher">
          <button class="theme-toggle" id="theme-toggle" type="button"
                  aria-label="Тема" aria-haspopup="menu" aria-expanded="false" title="Выбор темы">
            <span class="icon-sun" aria-hidden="true">☀️</span>
            <span class="icon-moon" aria-hidden="true">🌙</span>
          </button>
          <div class="theme-menu" id="theme-menu" role="menu" aria-hidden="true">
            <button type="button" class="theme-menu-item" role="menuitemradio" data-mode="light" aria-checked="false">
              <span class="theme-menu-icon" aria-hidden="true">☀️</span>
              <span class="theme-menu-label">Светлая</span>
              <span class="theme-menu-check" aria-hidden="true">✓</span>
            </button>
            <button type="button" class="theme-menu-item" role="menuitemradio" data-mode="dark" aria-checked="false">
              <span class="theme-menu-icon" aria-hidden="true">🌙</span>
              <span class="theme-menu-label">Тёмная</span>
              <span class="theme-menu-check" aria-hidden="true">✓</span>
            </button>
            <button type="button" class="theme-menu-item" role="menuitemradio" data-mode="auto" aria-checked="false">
              <span class="theme-menu-icon" aria-hidden="true">⏱</span>
              <span class="theme-menu-label">По&nbsp;времени дня <small>07–19</small></span>
              <span class="theme-menu-check" aria-hidden="true">✓</span>
            </button>
          </div>
        </div>
        <a href="/#auth" class="btn-ghost">Войти</a>
        <a href="/#demo" class="btn-primary-sm">Попробовать</a>
      </div>
    </div>
  </header>

  <main class="blog-hero">
    <div class="container">
      <div class="blog-eyebrow">[ БЛОГ · 6 СТАТЕЙ ]</div>
      <h1>Как мы делаем OCR накладных <span class="gradient-text">и зачем это вам</span></h1>
      <p class="sub">Технические разборы, гайды по интеграции с 1С:УНФ и СберБизнесом, и редкие истории про то, как OCR ломается на ТОРГ-12.</p>

      <div class="blog-tag-filter" role="group" aria-label="Фильтр по темам">
        <!-- BLOG-TAG-CHIPS-PLACEHOLDER -->
      </div>

      <div class="blog-grid" id="blog-grid">
        <!-- BLOG-CARDS-PLACEHOLDER -->
      </div>
    </div>
  </main>

  <footer class="site-footer">
    <div class="container">
      <p>© 2026 ScanFlow · OCR накладных для российского бизнеса</p>
    </div>
  </footer>

  <script src="/js/landing.js"></script>
  <script src="/js/blog.js" defer></script>
</body>
</html>
```

The chips and cards are server-injected (see Task 2.3). The `BLOG-TAG-CHIPS-PLACEHOLDER` and `BLOG-CARDS-PLACEHOLDER` HTML comments are the substitution markers.

- [ ] **Step 2: Commit**

```bash
git -c safe.directory=C:/www/ScanFlow add public/blog/index.html
git -c safe.directory=C:/www/ScanFlow commit -m "feat(blog): blog listing page shell with head + JSON-LD + shared header"
```

---

### Task 2.3: Server-side card/chip injection into listing + landing-preview

**Files:**
- Create: `src/seo/blogRender.ts`
- Modify: `src/api/server.ts`
- Test: `tests/seo/blogRender.test.ts`

The same renderer is used twice:
1. By `/blog` route to fill the listing's `BLOG-CARDS-PLACEHOLDER` and `BLOG-TAG-CHIPS-PLACEHOLDER`.
2. By `/` route to fill the landing's `BLOG-PREVIEW-PLACEHOLDER` with the three newest cards.

- [ ] **Step 1: Write failing test `tests/seo/blogRender.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { renderCard, renderListingHtml, renderPreviewHtml, renderTagChips } from '../../src/seo/blogRender';
import type { Article } from '../../src/seo/articles';

const a = (overrides: Partial<Article> = {}): Article => ({
  slug: 'foo-bar', title: 'Тест статьи', description: 'Описание', tags: ['ocr'],
  date: '2026-05-01', readingMinutes: 7, ogImage: '/og/default.svg', ...overrides,
});

describe('renderCard', () => {
  it('emits an <a> linking to /blog/<slug>', () => {
    const html = renderCard(a());
    expect(html).toContain('href="/blog/foo-bar"');
  });
  it('renders title, description, reading time and pretty date', () => {
    const html = renderCard(a());
    expect(html).toContain('Тест статьи');
    expect(html).toContain('Описание');
    expect(html).toContain('7 мин');
    expect(html).toContain('1 мая 2026');
  });
  it('renders each tag with the .blog-card-tag class', () => {
    const html = renderCard(a({ tags: ['ocr', '1c-unf'] }));
    expect((html.match(/blog-card-tag/g) || []).length).toBe(2);
  });
  it('escapes HTML in title and description', () => {
    const html = renderCard(a({ title: '<script>x</script>' }));
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });
  it('marks the first card as featured when isFeatured=true', () => {
    expect(renderCard(a(), { featured: true })).toContain('blog-card--featured');
  });
  it('marks a card as full when isFull=true', () => {
    expect(renderCard(a(), { full: true })).toContain('blog-card--full');
  });
});

describe('renderListingHtml', () => {
  it('substitutes both chip and card placeholders', () => {
    const html = '<x><!-- BLOG-TAG-CHIPS-PLACEHOLDER --></x><y><!-- BLOG-CARDS-PLACEHOLDER --></y>';
    const out = renderListingHtml(html, [a()]);
    expect(out).toContain('blog-card');
    expect(out).toContain('blog-tag-chip');
    expect(out).not.toContain('PLACEHOLDER');
  });
  it('renders 6+ articles with featured(1st) + full(6th)', () => {
    const arts = Array.from({ length: 6 }, (_, i) => a({ slug: `s${i}`, date: `2026-05-0${i+1}` }));
    const out = renderListingHtml('<!-- BLOG-CARDS-PLACEHOLDER -->', arts);
    expect((out.match(/blog-card--featured/g) || []).length).toBe(1);
    expect((out.match(/blog-card--full/g) || []).length).toBe(1);
  });
});

describe('renderPreviewHtml', () => {
  it('inserts up to 3 newest cards into a doc with the placeholder', () => {
    const doc = '<div class="blog-preview-grid"><!-- BLOG-PREVIEW-PLACEHOLDER --></div>';
    const arts = Array.from({ length: 5 }, (_, i) => a({ slug: `s${i}`, date: `2026-05-0${i+1}` }));
    const out = renderPreviewHtml(doc, arts);
    expect((out.match(/blog-card/g) || []).length).toBe(3);
    expect(out).toContain('s4'); // newest
  });
  it('renders nothing (placeholder removed) when there are no articles', () => {
    const doc = '<!-- BLOG-PREVIEW-PLACEHOLDER -->';
    expect(renderPreviewHtml(doc, [])).toBe('');
  });
});

describe('renderTagChips', () => {
  it('emits an "все" chip first, then one chip per distinct tag', () => {
    const html = renderTagChips([a({ tags: ['ocr'] }), a({ slug: 'b', tags: ['ocr', 'sber'] })]);
    expect((html.match(/blog-tag-chip/g) || []).length).toBe(3);
    expect(html.indexOf('все')).toBeLessThan(html.indexOf('ocr'));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/seo/blogRender.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/seo/blogRender.ts`**

```typescript
import { Article, distinctTags } from './articles';

const TAG_LABELS: Record<string, string> = {
  'ocr': 'OCR',
  '1c-unf': '1С:УНФ',
  'sber': 'Сбер',
  'torg-12': 'ТОРГ-12',
  'suppliers': 'Контрагенты',
  'multi-page': 'Многостраничные',
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDateRu(iso: string): string {
  const months = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${months[m - 1]} ${y}`;
}

interface CardOpts { featured?: boolean; full?: boolean; }

export function renderCard(article: Article, opts: CardOpts = {}): string {
  const classes = ['blog-card'];
  if (opts.featured) classes.push('blog-card--featured');
  if (opts.full) classes.push('blog-card--full');
  const tagChips = article.tags
    .map((t) => `<span class="blog-card-tag">${escapeHtml(TAG_LABELS[t] ?? t)}</span>`)
    .join('');
  return [
    `<a class="${classes.join(' ')}" href="/blog/${escapeHtml(article.slug)}">`,
    `  <div class="blog-card-tags">${tagChips}</div>`,
    `  <h3>${escapeHtml(article.title)}</h3>`,
    `  <p class="blog-card-desc">${escapeHtml(article.description)}</p>`,
    `  <div class="blog-card-meta"><b>${article.readingMinutes}</b> мин · ${escapeHtml(formatDateRu(article.date))}</div>`,
    `</a>`,
  ].join('\n');
}

export function renderTagChips(articles: Article[]): string {
  const tags = distinctTags(articles);
  const chips: string[] = [
    `<button type="button" class="blog-tag-chip" data-tag="all" aria-pressed="true">все</button>`,
  ];
  for (const t of tags) {
    chips.push(
      `<button type="button" class="blog-tag-chip" data-tag="${escapeHtml(t)}" aria-pressed="false">${escapeHtml(TAG_LABELS[t] ?? t)}</button>`,
    );
  }
  return chips.join('\n');
}

/**
 * Inject the chip and card markup into the listing HTML. The HTML must contain
 * the two comment placeholders. Cards: index 0 = featured, index 5 = full, rest regular.
 */
export function renderListingHtml(rawHtml: string, articles: Article[]): string {
  const cards = articles.map((a, i) => renderCard(a, {
    featured: i === 0,
    full: i === 5,
  })).join('\n');
  return rawHtml
    .replace('<!-- BLOG-CARDS-PLACEHOLDER -->', cards)
    .replace('<!-- BLOG-TAG-CHIPS-PLACEHOLDER -->', renderTagChips(articles));
}

/**
 * Inject the three newest articles into the landing's blog-preview section.
 * Returns empty string when no articles — the calling code uses this to remove
 * the section if there's nothing to show.
 */
export function renderPreviewHtml(rawHtml: string, articles: Article[]): string {
  if (articles.length === 0) return '';
  const cards = articles.slice(0, 3).map((a) => renderCard(a)).join('\n');
  return rawHtml.replace('<!-- BLOG-PREVIEW-PLACEHOLDER -->', cards);
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/seo/blogRender.test.ts`
Expected: 10 passing.

- [ ] **Step 5: Wire renderer into the listing route in `src/api/server.ts`**

Replace the existing `app.get('/blog', ...)` from Task 1.2 with:

```typescript
  // Cache the listing-HTML-with-substituted-cards in memory; rebuild on every
  // first request after server start (acceptable for SEO crawl needs).
  let listingHtmlCache: string | null = null;
  app.get('/blog', (_req, res) => {
    if (!listingHtmlCache) {
      const raw = fs.readFileSync(path.join(publicDir, 'blog/index.html'), 'utf8');
      listingHtmlCache = renderListingHtml(raw, loadArticles());
    }
    res.type('html').send(listingHtmlCache);
  });
```

And add the imports at the top:

```typescript
import { renderListingHtml, renderPreviewHtml } from '../seo/blogRender';
```

- [ ] **Step 6: Update the blog-routes test to assert chips and cards are present**

Append to `tests/api/blog-routes.test.ts`:

```typescript
describe('Blog listing rendering', () => {
  // This assumes articles.json has at least one article. If it's still empty
  // from Task 0.1, the test is no-op. Once Task 4.1 adds the first article,
  // re-enable.
  it.skip('listing contains rendered blog-card markup (enable after first article)', async () => {
    const res = await request(app).get('/blog');
    expect(res.text).toMatch(/blog-card/);
    expect(res.text).toMatch(/blog-tag-chip/);
    expect(res.text).not.toContain('BLOG-CARDS-PLACEHOLDER');
  });
});
```

- [ ] **Step 7: Commit**

```bash
git -c safe.directory=C:/www/ScanFlow add src/seo/blogRender.ts src/api/server.ts tests/seo/blogRender.test.ts tests/api/blog-routes.test.ts
git -c safe.directory=C:/www/ScanFlow commit -m "feat(blog): server-side card+chip rendering for listing; in-memory cache"
```

---

## Phase 3: Landing-page upgrades (head SEO + nav link + blog-preview section)

### Task 3.1: Upgrade landing `<head>` with full SEO meta + JSON-LD

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: Replace lines 3–12 (the existing minimal head, up to but NOT including the anti-FOUC `<script>`) with a fuller head**

The existing landing head currently has just `<meta charset>`, viewport, title, description, font preconnect, and CSS link. Replace those with the expanded version. The anti-FOUC `<script>` block below stays unchanged. After this edit the head should look like:

```html
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">

  <title>ScanFlow — OCR накладных за 3 секунды для 1С:УНФ и СберБизнеса</title>
  <meta name="description" content="Сканируйте фото бумажных накладных, получайте готовую приходную в 1С:УНФ, черновик платёжки в СберБизнесе и уведомления в Telegram. Без ручного ввода, без ошибок.">
  <link rel="canonical" href="https://scanflow.ru/">
  <meta name="robots" content="index, follow">

  <meta property="og:type" content="website">
  <meta property="og:title" content="ScanFlow — OCR накладных за 3 секунды">
  <meta property="og:description" content="Фото накладной → приходная в 1С:УНФ + черновик платёжки в Сбере. OCR на Claude Sonnet 4.6, точность 99.2%.">
  <meta property="og:url" content="https://scanflow.ru/">
  <meta property="og:image" content="https://scanflow.ru/og/default.svg">
  <meta property="og:site_name" content="ScanFlow">
  <meta property="og:locale" content="ru_RU">

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="ScanFlow — OCR накладных за 3 секунды">
  <meta name="twitter:description" content="OCR на Claude Sonnet 4.6 + интеграция с 1С:УНФ и СберБизнесом. Бесплатные 5 сканов.">
  <meta name="twitter:image" content="https://scanflow.ru/og/default.svg">

  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="manifest" href="/site.webmanifest">

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800;900&family=Unbounded:wght@500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/landing.css">

  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": "ScanFlow",
    "url": "https://scanflow.ru/",
    "logo": "https://scanflow.ru/og/default.svg",
    "sameAs": []
  }
  </script>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "url": "https://scanflow.ru/",
    "name": "ScanFlow",
    "description": "OCR накладных для российского бизнеса: фото → приходная в 1С:УНФ + платёжка в СберБизнесе"
  }
  </script>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "name": "ScanFlow",
    "applicationCategory": "BusinessApplication",
    "operatingSystem": "Web",
    "offers": [
      { "@type": "Offer", "name": "Старт", "price": "0", "priceCurrency": "RUB" },
      { "@type": "Offer", "name": "Бизнес", "price": "1999", "priceCurrency": "RUB" }
    ]
  }
  </script>

  <script>
    /* Existing anti-FOUC theme init script — preserve as-is from current file */
  </script>
</head>
```

Note: the existing anti-FOUC script (already in `public/index.html`) must be preserved; just the surrounding head is what changes.

- [ ] **Step 2: Manually verify**

Open `public/index.html` and confirm:
- `<title>` is the new one
- All four `<script type="application/ld+json">` blocks are present
- The original anti-FOUC `<script>` immediately follows them
- Nothing in the `<body>` was touched

- [ ] **Step 3: Commit**

```bash
git -c safe.directory=C:/www/ScanFlow add public/index.html
git -c safe.directory=C:/www/ScanFlow commit -m "feat(seo): full head meta + JSON-LD (Organization/WebSite/SoftwareApplication) on landing"
```

---

### Task 3.2: Add FAQ JSON-LD to landing (auto from existing accordion)

The landing already has six FAQ items in `<details class="faq-item">` elements. We don't want to duplicate the Q&A text twice (HTML + JSON-LD); instead, add a build-time inline `<script>` that walks the DOM and constructs JSON-LD on page load. Crawlers DO execute JS for ld+json — Google's been clear about this since 2017.

Actually, a more robust approach: emit the JSON-LD statically in HTML, hand-mirrored from the FAQ content. Crawler reads it immediately, no JS dependency. We'll keep the source-of-truth as the visible HTML and just duplicate into JSON-LD.

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: Find the `</footer>` near the end of `public/index.html` and add this `<script>` BEFORE it**

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "Сколько стоит распознавание одной накладной?",
      "acceptedAnswer": { "@type": "Answer", "text": "На тарифе «Старт» — 5 распознаваний бесплатно после регистрации, потом по 4 ₽/скан. На «Бизнес» (1 999 ₽/мес) — безлимит для одной организации. Платишь только за фактический объём." }
    },
    {
      "@type": "Question",
      "name": "Что если OCR ошибся? Кто проверяет суммы?",
      "acceptedAnswer": { "@type": "Answer", "text": "Каждая позиция проверяется кросс-валидацией qty × price ≈ total. Если что-то не сходится, накладная подсвечивается флагом items_total_mismatch и не уходит в 1С автоматом — ждёт твоего ОК. Эта проверка ловит ~30% OCR-ошибок до того, как ты их увидишь." }
    },
    {
      "@type": "Question",
      "name": "Какой 1С нужен и что устанавливать?",
      "acceptedAnswer": { "@type": "Answer", "text": "1С:Управление нашей фирмой (УНФ), любая редакция от 1.6. Ставится одна внешняя обработка .epf — скачаешь с лендинга после регистрации. 1С сама забирает одобренные накладные из ScanFlow по REST, создаёт «Приходную накладную» с товарами, контрагентом и фото." }
    },
    {
      "@type": "Question",
      "name": "Как работает отправка в Сбер?",
      "acceptedAnswer": { "@type": "Answer", "text": "Создаём черновик платёжного поручения через СберБизнес API. Документ ложится в твоём СберБизнесе в раздел «Черновики» — ты подписываешь его токеном вручную. ЭП на стороне ScanFlow не делаем — деньги уходят только с твоей подписи." }
    },
    {
      "@type": "Question",
      "name": "Куда уходят фото моих накладных?",
      "acceptedAnswer": { "@type": "Answer", "text": "Фото хранятся на наших серверах в РФ. К ним прикладывается документ в 1С. Через 90 дней оригинал удаляется автоматически — остаётся только распознанная JSON-структура. Бэкап MySQL — ежедневно в 03:00." }
    },
    {
      "@type": "Question",
      "name": "Можно ли своих сотрудников добавить?",
      "acceptedAnswer": { "@type": "Answer", "text": "На «Бизнес» — до 5 пользователей в одной организации. У каждого свой логин, свой API-ключ, свой Telegram-bot для уведомлений. Роли: админ / оператор / только просмотр." }
    }
  ]
}
</script>
```

- [ ] **Step 2: Commit**

```bash
git -c safe.directory=C:/www/ScanFlow add public/index.html
git -c safe.directory=C:/www/ScanFlow commit -m "feat(seo): FAQPage JSON-LD on landing mirroring the visible FAQ accordion"
```

---

### Task 3.3: Add `Блог` link to navbar

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: Find `<nav class="main-nav" id="main-nav">` in `public/index.html` and replace its contents**

Current contents (3 links). After editing:

```html
<nav class="main-nav" id="main-nav">
  <a href="#features">Возможности</a>
  <a href="#demo">Демо</a>
  <a href="#pricing">Тарифы</a>
  <a href="/blog">Блог</a>
</nav>
```

- [ ] **Step 2: Commit**

```bash
git -c safe.directory=C:/www/ScanFlow add public/index.html
git -c safe.directory=C:/www/ScanFlow commit -m "feat(landing): add Блог link to main nav"
```

---

### Task 3.4: Add `blog-preview` section to landing + server injection

**Files:**
- Modify: `public/index.html`
- Modify: `src/api/server.ts`

- [ ] **Step 1: Add the section markup to `public/index.html`**

Find the FAQ section's closing `</section>` and the AUTH section's opening `<section class="auth-section" id="auth">`. Insert this between them:

```html
<!-- ========== BLOG PREVIEW ========== -->
<section class="blog-preview-section" id="blog-preview">
  <div class="container">
    <div class="section-label" data-animate="fade-up">Блог</div>
    <h2 class="section-title" data-animate="fade-up" data-delay="1">
      Гайды и <span class="gradient-text">разборы</span>
    </h2>
    <p class="section-sub" data-animate="fade-up" data-delay="1">
      Технические разборы, гайды по интеграции с 1С/Сбером и редкие истории про то, как OCR ломается на ТОРГ-12.
    </p>

    <div class="blog-preview-grid">
      <!-- BLOG-PREVIEW-PLACEHOLDER -->
    </div>

    <div class="blog-preview-cta" data-animate="fade-up" data-delay="4">
      <a href="/blog" class="btn-outline">Все статьи →</a>
    </div>
  </div>
</section>
```

- [ ] **Step 2: Add the `<link rel="stylesheet" href="/css/article.css">` after the existing landing.css link**

In the head of `public/index.html`, change:

```html
<link rel="stylesheet" href="/css/landing.css">
```

to:

```html
<link rel="stylesheet" href="/css/landing.css">
<link rel="stylesheet" href="/css/article.css">
```

The article.css's `.blog-card`, `.blog-preview-section`, `.blog-preview-grid` are reused here.

- [ ] **Step 3: Wire server-side injection in `src/api/server.ts`**

Find this block (currently at the end of `createServer`):

```typescript
  // SPA fallback: serve index.html for unmatched GET requests
  app.get('/{*splat}', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });
```

Replace it with:

```typescript
  // Build the landing HTML once at first GET / and cache it. Crawlers
  // see the three newest blog cards inline (good for internal linking).
  // To refresh after publishing a new article, restart the server.
  let landingHtmlCache: string | null = null;
  function getLandingHtml(): string {
    if (landingHtmlCache) return landingHtmlCache;
    const raw = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    landingHtmlCache = renderPreviewHtml(raw, loadArticles()) || raw;
    return landingHtmlCache;
  }

  // Explicit landing route — must serve the rendered (with blog preview) HTML.
  app.get('/', (_req, res) => res.type('html').send(getLandingHtml()));

  // SPA fallback: serve index.html for unmatched GET requests (no injection;
  // this is for hash-routed subpaths that the SPA handles client-side).
  app.get('/{*splat}', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });
```

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: all tests pass. The blog-routes test that asserts `/` still returns landing HTML will pass.

- [ ] **Step 5: Manual smoke**

Run dev server, open `http://localhost:8899/`. Scroll to between FAQ and signup — the `.blog-preview-section` is visible. Empty `.blog-preview-grid` because `articles.json.articles` is still empty.

- [ ] **Step 6: Commit**

```bash
git -c safe.directory=C:/www/ScanFlow add public/index.html src/api/server.ts
git -c safe.directory=C:/www/ScanFlow commit -m "feat(landing): blog-preview section + server-side card injection"
```

---

## Phase 4: Article template + first article

### Task 4.1: Define the article HTML template + write the first article (`ocr-nakladnyh-kak-rabotaet`)

This is the longest single task. The template is finalized here and reused by Tasks 4.2–4.6.

**Files:**
- Create: `public/blog/ocr-nakladnyh-kak-rabotaet.html`
- Modify: `public/blog/articles.json` (add metadata entry)

- [ ] **Step 1: Write the article HTML — file `public/blog/ocr-nakladnyh-kak-rabotaet.html`**

Full file content:

```html
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">

  <title>Как работает OCR накладных в 2026: от Google Vision к Claude Sonnet 4.6</title>
  <meta name="description" content="Сравнение классической OCR-цепочки и vision-LLM на реальных накладных. Цифры из продакшена ScanFlow: 99.2% точности, 1.2с на страницу, $0.003 за документ.">
  <link rel="canonical" href="https://scanflow.ru/blog/ocr-nakladnyh-kak-rabotaet">
  <meta name="robots" content="index, follow">

  <meta property="og:type" content="article">
  <meta property="og:title" content="Как работает OCR накладных в 2026">
  <meta property="og:description" content="Vision-LLM против классики: реальные цифры точности и стоимости.">
  <meta property="og:url" content="https://scanflow.ru/blog/ocr-nakladnyh-kak-rabotaet">
  <meta property="og:image" content="https://scanflow.ru/og/default.svg">
  <meta property="og:site_name" content="ScanFlow">
  <meta property="og:locale" content="ru_RU">
  <meta property="article:published_time" content="2026-05-11">
  <meta property="article:section" content="OCR">
  <meta property="article:tag" content="ocr">

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="Как работает OCR накладных в 2026">
  <meta name="twitter:description" content="Vision-LLM против классики: реальные цифры.">
  <meta name="twitter:image" content="https://scanflow.ru/og/default.svg">

  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800;900&family=Unbounded:wght@500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/landing.css">
  <link rel="stylesheet" href="/css/article.css">

  <script>
    (function () {
      function resolveAuto() {
        var h = new Date().getHours();
        if (h >= 7 && h < 19) return 'light';
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
        return 'dark';
      }
      try {
        var raw = localStorage.getItem('sf-theme');
        var mode = (raw === 'light' || raw === 'dark' || raw === 'auto') ? raw : 'auto';
        document.documentElement.setAttribute('data-theme', (mode === 'auto') ? resolveAuto() : mode);
        document.documentElement.setAttribute('data-theme-mode', mode);
      } catch (_) { document.documentElement.setAttribute('data-theme', 'dark'); }
    })();
  </script>

  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": "Как работает OCR накладных в 2026: от Google Vision к Claude Sonnet 4.6",
    "description": "Сравнение классической OCR-цепочки и vision-LLM на реальных накладных. Цифры из продакшена ScanFlow.",
    "image": "https://scanflow.ru/og/default.svg",
    "datePublished": "2026-05-11",
    "dateModified": "2026-05-11",
    "author": { "@type": "Organization", "name": "ScanFlow" },
    "publisher": {
      "@type": "Organization",
      "name": "ScanFlow",
      "logo": { "@type": "ImageObject", "url": "https://scanflow.ru/og/default.svg" }
    },
    "mainEntityOfPage": "https://scanflow.ru/blog/ocr-nakladnyh-kak-rabotaet"
  }
  </script>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Главная", "item": "https://scanflow.ru/" },
      { "@type": "ListItem", "position": 2, "name": "Блог",    "item": "https://scanflow.ru/blog" },
      { "@type": "ListItem", "position": 3, "name": "OCR накладных" }
    ]
  }
  </script>
</head>
<body class="article-page">

  <div class="read-progress" id="read-progress" aria-hidden="true"></div>
  <div class="grain-overlay" aria-hidden="true"></div>

  <header class="site-header" id="site-header">
    <div class="container header-inner">
      <a href="/" class="logo">
        <div class="logo-icon">
          <svg width="32" height="32" viewBox="0 0 40 40" fill="none">
            <rect x="3" y="3" width="34" height="34" rx="8" stroke="url(#logo-grad)" stroke-width="2.5"/>
            <line x1="11" y1="14" x2="29" y2="14" stroke="url(#logo-grad)" stroke-width="2" stroke-linecap="round"/>
            <line x1="11" y1="20" x2="25" y2="20" stroke="url(#logo-grad)" stroke-width="2" stroke-linecap="round" opacity="0.6"/>
            <line x1="11" y1="26" x2="21" y2="26" stroke="url(#logo-grad)" stroke-width="2" stroke-linecap="round" opacity="0.35"/>
            <defs><linearGradient id="logo-grad" x1="0" y1="0" x2="40" y2="40"><stop offset="0%" stop-color="#3b82f6"/><stop offset="100%" stop-color="#06d6a0"/></linearGradient></defs>
          </svg>
        </div>
        <span class="logo-text">ScanFlow</span>
      </a>
      <nav class="main-nav" id="main-nav">
        <a href="/#features">Возможности</a>
        <a href="/#demo">Демо</a>
        <a href="/#pricing">Тарифы</a>
        <a href="/blog" aria-current="page">Блог</a>
      </nav>
      <div class="header-actions">
        <a href="/#auth" class="btn-ghost">Войти</a>
        <a href="/#demo" class="btn-primary-sm">Попробовать</a>
      </div>
    </div>
  </header>

  <main>
    <section class="article-hero">
      <div class="hero-papers" aria-hidden="true">
        <span class="paper paper--1">qty × price = 2 200</span>
        <span class="paper paper--3">№ 2841 · 12 850 ₽</span>
      </div>
      <div class="container">
        <nav class="article-breadcrumb" aria-label="Хлебные крошки">
          <a href="/">Главная</a>
          <span class="article-breadcrumb-sep">/</span>
          <a href="/blog">Блог</a>
          <span class="article-breadcrumb-sep">/</span>
          <span>OCR накладных</span>
        </nav>
        <div class="article-tags">
          <span class="article-tag">OCR</span>
        </div>
        <h1>Как работает <span class="gradient-text">OCR накладных</span> в 2026: от Google Vision к Claude Sonnet 4.6</h1>
        <div class="article-meta">
          <span>автор <b>Команда ScanFlow</b></span>
          <span class="sep">·</span>
          <span><b>7 мин</b> чтения</span>
          <span class="sep">·</span>
          <span>11 мая 2026</span>
        </div>
      </div>
    </section>

    <div class="container article-layout">
      <article class="article-prose">

        <!-- Mobile ToC -->
        <details class="article-toc-mobile">
          <summary>Содержание</summary>
          <ol>
            <li><a href="#problem">Проблема</a></li>
            <li><a href="#classic">Как обычно решают</a></li>
            <li><a href="#scanflow">Как это работает в ScanFlow</a></li>
            <li><a href="#gotchas">Что важно учесть</a></li>
            <li><a href="#faq">FAQ</a></li>
            <li><a href="#next">Что дальше</a></li>
          </ol>
        </details>

        <p>OCR — это <em>распознавание текста с изображения</em>. Применительно к российским накладным звучит просто: «возьмите фото, верните таблицу позиций». На практике это до сих пор одна из самых хрупких задач в B2B-автоматизации: ТОРГ-12 пишут от руки, штампы переезжают на текст, лента кассового аппарата затирает суммы, страницы накладной фотографируют под наклоном с подсветкой от окна.</p>

        <p>За последние два года рынок изменился сильнее, чем за десять до этого: vision-LLM (Claude Sonnet 4.6, GPT-4o vision, Gemini 1.5 Pro) научились читать целую накладную в один заход — без отдельной OCR-стадии. В этой статье мы разберём, как именно — на цифрах из продакшена <a href="/">ScanFlow</a>.</p>

        <h2 id="problem">Проблема: почему обычный OCR проигрывает на накладных</h2>

        <p>Классическая OCR-задача — это плоский текст: книга, договор, абзацы. Накладная — это <strong>таблица</strong>, в которой важен не только текст, но и геометрия: какая ячейка относится к колонке «количество», а какая — к «итого». Если потерять колонку, числа поплывут.</p>

        <p>Типовые ошибки на накладных:</p>
        <ul>
          <li><strong>SKU прочитан как количество.</strong> В ТОРГ-12 артикулы выглядят как «113393» — длинное число рядом с позицией. Без понимания структуры таблицы OCR парсит его в графу «количество», а реальное «10» уходит в графу «цена».</li>
          <li><strong>Перенос между страницами.</strong> Многостраничная накладная: на странице 1 — 15 позиций, на странице 2 — продолжение нумерации, а на странице 3 — только итоги и подпись. Если соединять их «текстом», ИТОГО будет посчитан дважды.</li>
          <li><strong>Своп НДС и итога.</strong> Колонки «без НДС / НДС / с НДС» близко друг к другу, OCR путает их местами в строках, где НДС не выписан явно.</li>
        </ul>

        <h2 id="classic">Как обычно решают: классическая цепочка</h2>

        <p>Стандартная архитектура «OCR-стартапа» 2019-2022 годов выглядела так:</p>

        <ol>
          <li><strong>Препроцессинг изображения</strong> — deskew (выравнивание наклона), denoise (шумоподавление), бинаризация. Обычно через OpenCV или Sharp.</li>
          <li><strong>Сам OCR</strong> — Google Cloud Vision / Yandex SpeechKit OCR / Tesseract — даёт сырой текст с bounding-box'ами.</li>
          <li><strong>Layout analysis</strong> — поиск таблиц: где границы, где заголовки колонок. Чаще всего регулярки и эвристики.</li>
          <li><strong>Парсер позиций</strong> — извлекает (название, qty, price, total) из распознанных строк таблицы, опять же regex-ами.</li>
          <li><strong>Валидация</strong> — `qty × price ≈ total` для каждой строки; если не сходится — флаг.</li>
        </ol>

        <p>Эта цепочка работает, но <strong>каждый шаг — точка отказа</strong>. Google Vision отлично читает буквы, но не понимает, что «113393» — это артикул. Регулярки парсера ломаются на любом нестандартном формате таблицы. Layout analysis на 4-страничной накладной с переносом колонок — это отдельная боль.</p>

        <div class="callout callout--warn">
          <span class="callout-icon">⚠</span>
          <div>
            <p><strong>Подводный камень:</strong> в нашем регулярном парсере есть массив <code>skipKeywords</code> — каждое слово там <em>блокирует реальный false-positive</em>, пойманный на проде. Удалить любое — значит вернуть конкретную ошибку. Это типично для regex-based OCR: эвристики растут как бородавки.</p>
          </div>
        </div>

        <h2 id="scanflow">Как это работает в ScanFlow: один вызов вместо четырёх</h2>

        <p>Сегодня в продакшене ScanFlow OCR работает <strong>в одном API-вызове</strong>: фото уходит напрямую в Claude Sonnet 4.6 (vision-режим), модель возвращает структурированный JSON со всеми позициями накладной.</p>

        <h3>Что происходит под капотом</h3>

        <ol>
          <li><strong>Препроцессинг — только ориентация.</strong> Sharp поворачивает изображение по EXIF, а Claude Haiku 4.5 на маленьком превью определяет правильную ориентацию (документ может быть боком). Без этого vision-модели сильно галлюцинируют на повёрнутом тексте.</li>
          <li><strong>Vision-запрос с typed schema.</strong> Claude получает картинку и инструкцию вернуть JSON по схеме <code>{invoice_number, supplier, items: [{name, qty, unit, price, total, vat_rate}]}</code>.</li>
          <li><strong>Валидация в коде.</strong> Для каждой строки проверяем <code>qty × price ≈ total ± 1%</code>. Если расходится — флаг <code>items_total_mismatch</code>, накладная не уходит в 1С автоматом.</li>
          <li><strong>Маппинг номенклатуры.</strong> Названия типа «мол. 3.2% Простоквашино» сопоставляются с каталогом 1С через Fuse.js fuzzy + Claude LLM-маппер. Это уже не OCR, но часть пайплайна.</li>
        </ol>

        <h3>Реальные цифры из продакшена</h3>

        <p>За 6 месяцев работы пайплайна на реальных накладных российских поставщиков (продукты, общепит, опт):</p>

        <ul>
          <li><strong>Точность на уровне позиции:</strong> 99.2% (доля строк, где qty, price и total распознаны верно).</li>
          <li><strong>Среднее время:</strong> 1.2 секунды на страницу, 3.2 секунды на 3-страничную накладную (включая препроцессинг и валидацию).</li>
          <li><strong>Стоимость:</strong> ~$0.003 за документ при текущих ценах Claude Sonnet 4.6 API. На один скан выходит около 25 копеек.</li>
          <li><strong>Многостраничные:</strong> 12% документов в выборке многостраничные; объединение работает корректно в 97% случаев.</li>
        </ul>

        <p class="pull-quote">Главный сдвиг — не «точность OCR стала выше». Главный сдвиг — модель <em>понимает</em> накладную как документ.</p>

        <h3>Почему fallback-цепочка всё ещё в коде</h3>

        <p>В <code>src/ocr/ocrManager.ts</code> по-прежнему живут Google Vision и Tesseract — мы их не выбросили. Причины:</p>

        <ul>
          <li>Network-сбои до Anthropic API случаются. Когда падает <code>api.anthropic.com</code>, лучше отдать пользователю результат из Google Vision с regex-парсингом, чем 500.</li>
          <li>Дешёвая фолбэк-валидация: если новый Claude-ответ выглядит подозрительно (например, total на порядок меньше суммы позиций), мы сверяем с Google Vision OCR-текстом.</li>
          <li>Регуляторно полезно иметь deterministic-парсер как точку доверия.</li>
        </ul>

        <h2 id="gotchas">Что важно учесть</h2>

        <p>Если вы строите свой OCR-пайплайн на vision-LLM, не повторяйте наших ошибок:</p>

        <h3>Не доверяйте суммам</h3>

        <p>Claude иногда округляет числа «для красоты»: возвращает 3 500.00, когда в накладной 3 482.50. Всегда сверяйте <code>qty × price = total</code> и <code>sum(items.total) = invoice.total</code>. На наших данных эта проверка ловит ~30% мелких ошибок до того, как они уходят в 1С.</p>

        <h3>Считайте rate-limits и стоимость заранее</h3>

        <p>Claude Sonnet 4.6 vision при 200 запросах/мин (стандартный лимит) выдерживает ~2 одновременных пользователя, делающих batch-загрузку. Если у вас планируется массовая обработка — заранее запрашивайте увеличение rate-limit.</p>

        <h3>Кешируйте ориентацию</h3>

        <p>Определение ориентации через Claude Haiku — это лишний API-вызов на каждой картинке. Мы кешируем результат по hash файла; повторно отправленная накладная не платит дважды.</p>

        <div class="callout callout--tip">
          <span class="callout-icon">💡</span>
          <div>
            <p><strong>Совет:</strong> если бюджет важен — используйте Claude Haiku вместо Sonnet для самых простых накладных (1 страница, типографский шрифт). Точность падает с 99.2% до ~97%, но стоимость снижается в 10×. У нас в Settings есть тумблер выбора модели.</p>
          </div>
        </div>

        <h2 id="faq">FAQ</h2>

        <h3>Можно ли подключить ваш OCR к своему 1С через API?</h3>

        <p>Да, у нас есть REST с <code>X-API-Key</code>: <code>POST /api/upload</code> принимает файл и возвращает structured JSON. См. документацию интеграции на странице «Возможности».</p>

        <h3>Что с рукописными накладными?</h3>

        <p>Печатный текст — 99%+, рукописный (с правками поверх печатной формы) — около 85%. Полностью рукописная накладная — нестандартный кейс, который мы не оптимизируем.</p>

        <h3>А если ваш сервис ляжет — что с данными?</h3>

        <p>Распознанные документы хранятся в нашей MySQL в России, ежедневные дампы. Фото исходников хранятся 90 дней. По запросу выгружаем всё в JSON.</p>

        <h2 id="next">Что дальше</h2>

        <p>Если OCR — это вход, выход — интеграция с учётной системой. Читайте, как мы соединяем результат OCR с 1С:УНФ:</p>

        <ul>
          <li><a href="/blog/perevod-paper-zacenok-v-1c-unf">От фото накладной до приходной в 1С:УНФ за 3 секунды</a> — внешняя обработка, маппинг номенклатуры, НДС по дате.</li>
          <li><a href="/blog/torg-12-kak-pravilno-raspoznat">ТОРГ-12: какие графы важны и где OCR ошибается чаще всего</a> — углубление по самой популярной форме.</li>
        </ul>
      </article>

      <aside class="article-toc" id="article-toc-desktop" aria-label="Содержание">
        <div class="article-toc-label">Содержание</div>
        <ol>
          <li><a href="#problem">Проблема</a></li>
          <li><a href="#classic">Как обычно решают</a></li>
          <li><a href="#scanflow">Как это работает в ScanFlow</a></li>
          <li><a href="#gotchas">Что важно учесть</a></li>
          <li><a href="#faq">FAQ</a></li>
          <li><a href="#next">Что дальше</a></li>
        </ol>
      </aside>
    </div>

    <footer class="article-footer">
      <div class="container">
        <div class="article-cta">
          <h2>Понравилось?</h2>
          <p>Попробуйте ScanFlow — 5 распознаваний бесплатно после регистрации.</p>
          <a href="/#auth" class="btn-primary">Начать бесплатно</a>
        </div>

        <div class="related-articles">
          <h3>Читать дальше</h3>
          <div class="related-grid">
            <!-- Two related cards are emitted server-side; for now they're hardcoded -->
            <a class="blog-card" href="/blog/perevod-paper-zacenok-v-1c-unf">
              <div class="blog-card-tags"><span class="blog-card-tag">1С:УНФ</span></div>
              <h3>От фото накладной до приходной в 1С:УНФ за 3 секунды</h3>
              <p class="blog-card-desc">Полный пайплайн: что забирает 1С через REST, как сопоставляется номенклатура, как считается НДС по дате.</p>
              <div class="blog-card-meta"><b>8 мин</b> · 11 мая 2026</div>
            </a>
            <a class="blog-card" href="/blog/torg-12-kak-pravilno-raspoznat">
              <div class="blog-card-tags"><span class="blog-card-tag">ТОРГ-12</span></div>
              <h3>ТОРГ-12: какие графы важны и где OCR ошибается чаще всего</h3>
              <p class="blog-card-desc">Структура формы, что важно вытащить и как кросс-валидация ловит 30% ошибок до того, как вы их увидите.</p>
              <div class="blog-card-meta"><b>6 мин</b> · 11 мая 2026</div>
            </a>
          </div>
        </div>
      </div>
    </footer>
  </main>

  <footer class="site-footer">
    <div class="container">
      <p>© 2026 ScanFlow · OCR накладных для российского бизнеса</p>
    </div>
  </footer>

  <script src="/js/landing.js"></script>
  <script src="/js/article.js" defer></script>
</body>
</html>
```

- [ ] **Step 2: Add the metadata entry to `public/blog/articles.json`**

Replace the `"articles": []` with:

```json
{
  "_schema": "Each article has slug, title (≤60), description (140-160), tags[], date (YYYY-MM-DD), readingMinutes (int), ogImage (path), updated? (YYYY-MM-DD optional).",
  "articles": [
    {
      "slug": "ocr-nakladnyh-kak-rabotaet",
      "title": "Как работает OCR накладных в 2026: от Google Vision к Claude Sonnet 4.6",
      "description": "Сравнение классической OCR-цепочки и vision-LLM на реальных накладных. Цифры из продакшена ScanFlow.",
      "tags": ["ocr"],
      "date": "2026-05-11",
      "readingMinutes": 7,
      "ogImage": "/og/default.svg"
    }
  ]
}
```

- [ ] **Step 3: Restart dev server and smoke-test**

Run `npm run dev` (or kill+restart if already running). Open:

- `http://localhost:8899/blog` — listing now shows one card.
- `http://localhost:8899/blog/ocr-nakladnyh-kak-rabotaet` — article opens.
- `http://localhost:8899/sitemap.xml` — includes the article URL.
- `http://localhost:8899/` — blog-preview section shows one card.

- [ ] **Step 4: Enable the previously skipped test**

In `tests/api/blog-routes.test.ts`, remove `.skip` from the listing-rendering test (it can now pass).

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git -c safe.directory=C:/www/ScanFlow add public/blog/ocr-nakladnyh-kak-rabotaet.html public/blog/articles.json tests/api/blog-routes.test.ts
git -c safe.directory=C:/www/ScanFlow commit -m "feat(content): first article — OCR накладных в 2026; template validated"
```

---

## Phase 5: Articles 2–6

Each article reuses the Task 4.1 template structure verbatim. Only the `<title>`, `<meta>`, JSON-LD, body content, related cards, and `articles.json` entry change. To avoid pasting the full template six times, each task lists ONLY the differences.

**Source-of-truth for technical facts in each article (NOT to be invented):**
- [`CLAUDE.md`](../../../CLAUDE.md) — pipeline architecture, hard constraints, Sber gotchas, multi-page logic.
- [`docs/_archive/CLAUDE-v1.6-2026-04-30.md`](../../../docs/_archive/CLAUDE-v1.6-2026-04-30.md) — extended historical context for OCR strategy and parser internals.
- Source comments in `src/ocr/`, `src/parser/`, `src/sber/`, `src/mapping/` — the most precise specs of how things actually work.
- [`docs/superpowers/specs/2026-05-06-sber-business-payments-design.md`](../specs/2026-05-06-sber-business-payments-design.md) and the corresponding plan — for Sber details.

Tone reminder: engineer-expert, first-person plural ("мы видим"), no press-release fluff, every article has 1–2 real code/JSON fragments and 1 `callout--warn` from production. Length 1500–2500 words.

### Task 5.1: Article — `perevod-paper-zacenok-v-1c-unf`

**Files:**
- Create: `public/blog/perevod-paper-zacenok-v-1c-unf.html`
- Modify: `public/blog/articles.json` (append entry)

- [ ] **Step 1: Copy Task 4.1's article HTML as a starting template, then replace per the below**

Use the exact same template as Task 4.1, with these substitutions throughout:

- Title: `От фото накладной до приходной в 1С:УНФ за 3 секунды`
- Meta description: `Полный пайплайн интеграции ScanFlow с 1С:УНФ — что забирает 1С по REST, как маппится номенклатура, как считается НДС по дате (18%/20%/22%).`
- Canonical / og:url: `https://scanflow.ru/blog/perevod-paper-zacenok-v-1c-unf`
- Breadcrumb 3rd item: `1С:УНФ`
- Article tags: `1С:УНФ`, `OCR`
- H1: `От <span class="gradient-text">фото накладной</span> до приходной в 1С:УНФ за 3 секунды`
- Article meta: `8 мин чтения`, date `11 мая 2026`
- JSON-LD `Article.headline` matches the title; `datePublished` 2026-05-11.

Body structure (H2s):
- `id="problem"` "Проблема: ручной ввод накладных съедает час в день"
- `id="classic"` "Как обычно: бухгалтер открывает скан и набивает в УНФ"
- `id="scanflow"` "Как это работает в ScanFlow" — H3 подсекции:
  - "Внешняя обработка `.epf`" (что качается, куда положить, как запустить)
  - "REST контракт: `/api/invoices/pending` + `/confirm`"
  - "Маппинг номенклатуры: Fuse.js fuzzy + Claude LLM"
  - "НДС по дате: `Справочники.СтавкиНДС.СтавкаНДС(ВидСтавки, Period)` — почему важно"
- `id="gotchas"` "Что важно учесть" — H3:
  - "Прикреплять фото через `РаботаСФайлами.ДобавитьФайл`, а не `ФайлХранилище`"
  - "Очерёдность сохранения: сначала контрагент, потом документ"
  - "Что делать с расхождением сумм"
- `id="faq"` 3 Q&A: какая версия УНФ?  кто видит платёжку? — куда смотреть логи?
- `id="next"` — ссылки на статьи 1 (OCR) и 3 (Sber).

Related cards at the footer: статья 1 (OCR) и статья 3 (Sber).

- [ ] **Step 2: Append the metadata entry to `public/blog/articles.json`**

Insert this object into the `"articles"` array (after the first entry):

```json
    {
      "slug": "perevod-paper-zacenok-v-1c-unf",
      "title": "От фото накладной до приходной в 1С:УНФ за 3 секунды",
      "description": "Полный пайплайн интеграции ScanFlow с 1С:УНФ — что забирает 1С по REST, как маппится номенклатура, как считается НДС по дате.",
      "tags": ["1c-unf", "ocr"],
      "date": "2026-05-11",
      "readingMinutes": 8,
      "ogImage": "/og/default.svg"
    }
```

- [ ] **Step 3: Restart server, smoke-test, run all tests**

Run: `npm test`
Expected: all pass; listing now shows two cards.

- [ ] **Step 4: Commit**

```bash
git -c safe.directory=C:/www/ScanFlow add public/blog/perevod-paper-zacenok-v-1c-unf.html public/blog/articles.json
git -c safe.directory=C:/www/ScanFlow commit -m "feat(content): article — фото накладной → 1С:УНФ за 3 секунды"
```

---

### Task 5.2: Article — `avto-platezhka-v-sberbiznes`

Same flow as Task 5.1. Substitutions:

- Title: `Автоматическое создание платёжки в СберБизнес из накладной`
- Description: `Гайд по СберБизнес API: mTLS, OAuth, формат purpose, особенность Authorization без Bearer-префикса. Реальные грабли из продакшена.`
- Canonical: `https://scanflow.ru/blog/avto-platezhka-v-sberbiznes`
- Tags: `Сбер`
- H1: `Автоматическое создание <span class="gradient-text">платёжки в СберБизнес</span> из накладной`
- Meta: `9 мин чтения`

Body H2s:
- `problem` — "Платёжки бухгалтер тоже бьёт руками"
- `classic` — "Как обычно: открыть Сбер, скопировать реквизиты, вписать назначение"
- `scanflow` — "Как это работает в ScanFlow"
  - H3 "mTLS + OAuth-flow"
  - H3 "Особенность Authorization: без `Bearer`-префикса"
  - H3 "Поле `purpose`: 210 символов ASCII-safe — почему"
  - H3 "Почему только черновик, а не подписанный платёж"
- `gotchas` — H3:
  - "Двойная отправка: UNIQUE(invoice_id) спасает от повторов"
  - "Что делать с истёкшим access_token"
- `faq` — 3 Q&A: что если у меня не Сбер? кто видит черновик? отзывается ли черновик автоматом?
- `next` — статьи 2 (1С) и 5 (контрагенты).

Related cards: 2 и 5.

`articles.json` entry:

```json
    {
      "slug": "avto-platezhka-v-sberbiznes",
      "title": "Автоматическое создание платёжки в СберБизнес из накладной",
      "description": "Гайд по СберБизнес API: mTLS, OAuth, формат purpose, особенность Authorization без Bearer-префикса.",
      "tags": ["sber"],
      "date": "2026-05-11",
      "readingMinutes": 9,
      "ogImage": "/og/default.svg"
    }
```

- [ ] **Steps 1–4: same pattern**

```bash
git -c safe.directory=C:/www/ScanFlow add public/blog/avto-platezhka-v-sberbiznes.html public/blog/articles.json
git -c safe.directory=C:/www/ScanFlow commit -m "feat(content): article — платёжка в СберБизнес из накладной"
```

---

### Task 5.3: Article — `torg-12-kak-pravilno-raspoznat`

Substitutions:

- Title: `ТОРГ-12: какие графы важны и где OCR ошибается чаще всего`
- Description: `Структура ТОРГ-12, что нужно вытащить из накладной, типичные ошибки OCR на этой форме и как их ловит кросс-валидация qty × price ≈ total.`
- Tags: `ТОРГ-12`, `OCR`
- H1: `<span class="gradient-text">ТОРГ-12</span>: какие графы важны и где OCR ошибается чаще всего`
- Meta: `6 мин чтения`

Body H2s:
- `problem` — "ТОРГ-12 — самая популярная и самая ломкая форма"
- `classic` — "Что нужно вытащить из ТОРГ-12"
- `scanflow` — "Как это работает в ScanFlow"
  - H3 "Поля формы: что обязательно, что опционально"
  - H3 "Типичные OCR-ошибки на ТОРГ-12: SKU↔qty, НДС↔total, перенос между страницами"
  - H3 "Кросс-валидация: `qty × price ≈ total ± 1%`"
- `gotchas` — H3:
  - "Лимит 4 цифры на количество (артикулы 6-значные)"
  - "Подписи поверх итогов"
- `faq` — 3 Q&A
- `next` — статьи 1 (OCR), 6 (multi-page).

`articles.json`:

```json
    {
      "slug": "torg-12-kak-pravilno-raspoznat",
      "title": "ТОРГ-12: какие графы важны и где OCR ошибается чаще всего",
      "description": "Структура ТОРГ-12, что нужно вытащить, типичные OCR-ошибки и как их ловит кросс-валидация qty × price ≈ total.",
      "tags": ["torg-12", "ocr"],
      "date": "2026-05-11",
      "readingMinutes": 6,
      "ogImage": "/og/default.svg"
    }
```

- [ ] **Same flow + commit**

```bash
git -c safe.directory=C:/www/ScanFlow add public/blog/torg-12-kak-pravilno-raspoznat.html public/blog/articles.json
git -c safe.directory=C:/www/ScanFlow commit -m "feat(content): article — ТОРГ-12 OCR-ошибки и валидация"
```

---

### Task 5.4: Article — `dadata-i-kontragenty-po-inn`

Substitutions:

- Title: `Автозаполнение контрагентов по ИНН через DaData: как это устроено`
- Description: `Что возвращает DaData по ИНН, цена, лимиты, сравнение с СПАРК и Контур.Фокус, и как ScanFlow кеширует результаты в локальной таблице suppliers.`
- Tags: `Контрагенты`
- H1: `Автозаполнение <span class="gradient-text">контрагентов по ИНН</span> через DaData`
- Meta: `7 мин чтения`

Body H2s:
- `problem` — "Реквизиты контрагента бьют руками из подписанной накладной"
- `classic` — "Что доступно: ФНС-выписка / СПАРК / Контур.Фокус / DaData"
- `scanflow` — "Как это работает в ScanFlow"
  - H3 "DaData API: что возвращает по ИНН"
  - H3 "Локальная таблица `suppliers` (PK=ИНН) — почему кешируем"
  - H3 "Сравнение DaData / СПАРК / Контур.Фокус по 4 параметрам"
- `gotchas` — H3:
  - "DaData не проверяет, действующий ли контрагент"
  - "Лимит 10 000 запросов/сутки на бесплатном тарифе"
- `faq` — 3 Q&A
- `next` — статьи 3 (Sber), 2 (1С).

`articles.json`:

```json
    {
      "slug": "dadata-i-kontragenty-po-inn",
      "title": "Автозаполнение контрагентов по ИНН через DaData: как это устроено",
      "description": "Что возвращает DaData по ИНН, цена, лимиты, сравнение с СПАРК и Контур.Фокус, и как кешировать в локальной таблице.",
      "tags": ["suppliers"],
      "date": "2026-05-11",
      "readingMinutes": 7,
      "ogImage": "/og/default.svg"
    }
```

- [ ] **Same flow + commit**

```bash
git -c safe.directory=C:/www/ScanFlow add public/blog/dadata-i-kontragenty-po-inn.html public/blog/articles.json
git -c safe.directory=C:/www/ScanFlow commit -m "feat(content): article — DaData контрагенты по ИНН"
```

---

### Task 5.5: Article — `multi-page-nakladnye-sliyanie`

Substitutions:

- Title: `Накладная на 3 страницах: как ScanFlow собирает её обратно в один документ`
- Description: `Как работает merge многостраничных накладных в ScanFlow: общий номер + поставщик → одна запись, кейсы когда мердж не сработает, findRecentByNumber.`
- Tags: `Многостраничные`, `OCR`
- H1: `<span class="gradient-text">Накладная на 3 страницах</span>: как ScanFlow собирает её обратно в один документ`
- Meta: `5 мин чтения`

Body H2s:
- `problem` — "Бумажная накладная не всегда умещается в 1 кадр"
- `classic` — "Как обычно делают: бухгалтер вручную клеит позиции"
- `scanflow` — "Как это работает в ScanFlow"
  - H3 "Алгоритм мерджа: общий номер + поставщик"
  - H3 "Что внутри `findRecentByNumber`"
  - H3 "Какой страницей подписывается merged-документ"
- `gotchas` — H3:
  - "Разные форматы номеров: «№2841», «2841/2026», «No 2841»"
  - "Оторванная подпись: что если страница ИТОГО не загружена"
- `faq` — 3 Q&A
- `next` — статьи 4 (ТОРГ-12), 1 (OCR).

`articles.json`:

```json
    {
      "slug": "multi-page-nakladnye-sliyanie",
      "title": "Накладная на 3 страницах: как ScanFlow собирает её обратно в один документ",
      "description": "Как работает merge многостраничных накладных в ScanFlow: общий номер + поставщик → одна запись, кейсы когда мердж не сработает.",
      "tags": ["multi-page", "ocr"],
      "date": "2026-05-11",
      "readingMinutes": 5,
      "ogImage": "/og/default.svg"
    }
```

- [ ] **Same flow + commit**

```bash
git -c safe.directory=C:/www/ScanFlow add public/blog/multi-page-nakladnye-sliyanie.html public/blog/articles.json
git -c safe.directory=C:/www/ScanFlow commit -m "feat(content): article — multi-page invoice merge"
```

---

## Phase 6: Client-side polish

### Task 6.1: Blog listing tag filter + ToC scroll-spy script

**Files:**
- Create: `public/js/blog.js`
- Create: `public/js/article.js`

- [ ] **Step 1: Create `public/js/blog.js` — tag filter for listing**

```javascript
(function () {
  'use strict';
  var chips = document.querySelectorAll('.blog-tag-chip');
  var cards = document.querySelectorAll('#blog-grid .blog-card');
  if (!chips.length || !cards.length) return;

  chips.forEach(function (chip) {
    chip.addEventListener('click', function () {
      var tag = chip.dataset.tag;
      chips.forEach(function (c) { c.setAttribute('aria-pressed', c === chip ? 'true' : 'false'); });
      cards.forEach(function (card) {
        if (tag === 'all') { card.style.display = ''; return; }
        var tags = (card.querySelectorAll('.blog-card-tag') || []);
        var match = false;
        tags.forEach(function (t) {
          if (t.dataset && t.dataset.tag === tag) match = true;
        });
        // Fallback: tag chip uses label like "1С:УНФ", card tag uses label too.
        // Match by visible text:
        if (!match) {
          tags.forEach(function (t) {
            if (t.textContent && t.textContent.trim().toLowerCase() === chip.textContent.trim().toLowerCase()) match = true;
          });
        }
        card.style.display = match ? '' : 'none';
      });
    });
  });
})();
```

- [ ] **Step 2: Create `public/js/article.js` — reading-progress + ToC scroll-spy**

```javascript
(function () {
  'use strict';

  // Reading progress bar
  var bar = document.getElementById('read-progress');
  if (bar) {
    function update() {
      var docHeight = document.documentElement.scrollHeight - window.innerHeight;
      var pct = docHeight > 0 ? (window.scrollY / docHeight) * 100 : 0;
      bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
    }
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    update();
  }

  // ToC scroll-spy: highlight currently-visible H2
  var tocLinks = document.querySelectorAll('.article-toc a');
  if (tocLinks.length) {
    var sectionIds = Array.from(tocLinks).map(function (a) { return a.getAttribute('href').slice(1); });
    var sections = sectionIds.map(function (id) { return document.getElementById(id); }).filter(Boolean);

    function refresh() {
      var y = window.scrollY + 130;
      var current = sections[0];
      for (var i = 0; i < sections.length; i++) {
        if (sections[i].offsetTop <= y) current = sections[i]; else break;
      }
      tocLinks.forEach(function (a) {
        a.classList.toggle('current', a.getAttribute('href') === '#' + current.id);
      });
    }
    window.addEventListener('scroll', refresh, { passive: true });
    refresh();
  }
})();
```

- [ ] **Step 3: Commit**

```bash
git -c safe.directory=C:/www/ScanFlow add public/js/blog.js public/js/article.js
git -c safe.directory=C:/www/ScanFlow commit -m "feat(blog): client-side tag filter + reading-progress + ToC scroll-spy"
```

---

### Task 6.2: Update card-tag rendering to include `data-tag` for filtering

The current renderer outputs `<span class="blog-card-tag">OCR</span>` — text only. The filter falls back to text-match, which works, but explicit `data-tag` is more robust.

**Files:**
- Modify: `src/seo/blogRender.ts`
- Test: `tests/seo/blogRender.test.ts`

- [ ] **Step 1: Update the renderCard chip generation**

In `src/seo/blogRender.ts`, change the tagChips construction:

```typescript
  const tagChips = article.tags
    .map((t) => `<span class="blog-card-tag" data-tag="${escapeHtml(t)}">${escapeHtml(TAG_LABELS[t] ?? t)}</span>`)
    .join('');
```

- [ ] **Step 2: Update the test to assert `data-tag` presence**

Add to `tests/seo/blogRender.test.ts`:

```typescript
it('emits data-tag on each card tag for client-side filtering', () => {
  const html = renderCard(a({ tags: ['ocr', '1c-unf'] }));
  expect(html).toContain('data-tag="ocr"');
  expect(html).toContain('data-tag="1c-unf"');
});
```

- [ ] **Step 3: Run tests**

Run: `npm test -- tests/seo/blogRender.test.ts`
Expected: 11 passing.

- [ ] **Step 4: Commit**

```bash
git -c safe.directory=C:/www/ScanFlow add src/seo/blogRender.ts tests/seo/blogRender.test.ts
git -c safe.directory=C:/www/ScanFlow commit -m "feat(blog): data-tag on card tag chips for filter robustness"
```

---

## Phase 7: Semantic core doc

### Task 7.1: Write `docs/marketing/seo-semantic-core.md`

**Files:**
- Create: `docs/marketing/seo-semantic-core.md`

- [ ] **Step 1: Create the doc**

Copy the "Semantic core" section from the spec ([docs/superpowers/specs/2026-05-11-seo-blog-content-design.md](../specs/2026-05-11-seo-blog-content-design.md)) into a standalone markdown file at `docs/marketing/seo-semantic-core.md`. Add a short header explaining what the doc is for and how to update it:

```markdown
# ScanFlow — семантическое ядро

> Эта таблица — основной источник правды для содержания блога и meta-тегов.
> Обновляется при добавлении новых статей или ребалансировке ключей.
> Если правишь — обнови также `articles.json` и meta-теги соответствующих
> страниц.

(...копия секции "Semantic core" из спеки...)
```

- [ ] **Step 2: Commit**

```bash
git -c safe.directory=C:/www/ScanFlow add docs/marketing/seo-semantic-core.md
git -c safe.directory=C:/www/ScanFlow commit -m "docs(seo): semantic core — 6 keyword clusters + linking matrix"
```

---

## Phase 8: Final QA

### Task 8.1: Run full test suite

- [ ] **Step 1: Run tests**

Run: `npm test`
Expected: all green.

If anything fails, fix the underlying issue and re-run. Do NOT commit half-broken state.

---

### Task 8.2: Lighthouse SEO audit + structured-data validation

- [ ] **Step 1: Start dev server**

Run: `npm run dev`

- [ ] **Step 2: Run Lighthouse on landing, listing, and one article**

In Chrome DevTools → Lighthouse → run Mobile audit on:
- `http://localhost:8899/`
- `http://localhost:8899/blog`
- `http://localhost:8899/blog/ocr-nakladnyh-kak-rabotaet`

Acceptance: SEO score = 100 on all three. If any criterion fails (missing alt, weak `<title>`, etc.), fix inline and commit.

- [ ] **Step 3: Validate JSON-LD**

For each of the three pages, copy the JSON-LD scripts into <https://search.google.com/test/rich-results> (or `https://validator.schema.org/`) and confirm 0 errors / 0 warnings on the structured-data parsing.

- [ ] **Step 4: Commit any fixes**

```bash
git -c safe.directory=C:/www/ScanFlow commit -am "fix(seo): Lighthouse and schema-validator findings"
```

(Only if there were fixes; otherwise skip this step.)

---

### Task 8.3: Manual browser check — both themes, mobile, dead links

- [ ] **Step 1: Static-server preview (faster than dev)**

Run: `cd public && python -m http.server 8899`. Open in browser.

- [ ] **Step 2: For each of the three page categories (landing, listing, one article)**

1. Open in dark theme — read top to bottom, look for unstyled elements, overlapping text, broken layout.
2. Click the theme switcher to light — repeat.
3. Resize to ~375px mobile — verify ToC collapses to `<details>`, related cards stack, nav becomes hamburger (if applicable; the landing already handles mobile nav).
4. Click every internal link visible on the page — none should 404.

- [ ] **Step 3: Run a link-check utility**

If you have `lychee` or `linkchecker` installed:

```bash
npx broken-link-checker http://localhost:8899 -r --exclude "fonts.googleapis.com" --exclude "fonts.gstatic.com"
```

If not, open each blog URL manually and click around.

- [ ] **Step 4: Commit any fixes**

If you find any issue, fix and:

```bash
git -c safe.directory=C:/www/ScanFlow commit -am "fix(blog): QA pass — <specific fix>"
```

---

## Self-review

After implementation, walk through the spec section-by-section:

- [ ] **Storage & routing** — files exist at the right paths, routes register before SPA fallback. (Phases 0, 1.)
- [ ] **SEO infrastructure** — every page has full head + JSON-LD; robots and sitemap routes work. (Phases 0.3, 1.2, 3.1, 3.2.)
- [ ] **Semantic core** — doc is present and accurate. (Phase 7.)
- [ ] **Blog pages design** — listing has filter + bento grid; articles have hero + prose + ToC + related + footer. (Phases 2, 4.)
- [ ] **Landing blog-preview** — section visible between FAQ and signup with 3 cards. (Phase 3.4.)
- [ ] **Article content** — 6 articles match the per-article abstracts. (Phases 4, 5.)
- [ ] **Risks/gotchas** — SPA fallback regression checked by test (Task 1.2); graceful degradation when articles.json missing (Task 0.1); canonical URLs hardcoded `scanflow.ru` no www/trailing slash; sitemap freshness documented.

---

## Done

Plan is complete. Implementation roughly: 5 hours of TS work (phases 0–3, 6), 3-4 hours of content writing (phases 4–5), 1 hour of QA (phase 8). Most parallelizable bottlenecks: writing 6 articles can be done in 6 separate sub-agents if using subagent-driven execution.
