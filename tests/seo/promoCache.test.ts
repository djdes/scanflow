import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';

// Poison getDb() so ANY database call during promotional page or Markdown serving immediately fails!
vi.mock('../../src/database/db', () => ({
  getDb: () => {
    throw new Error('Unexpected SQL database access on promotional route!');
  },
}));
vi.mock('../../src/watcher/fileWatcher', () => ({ FileWatcher: class {} }));
vi.mock('../../src/mapping/nomenclatureMapper', () => ({ NomenclatureMapper: class {} }));

import { createServer } from '../../src/api/server';
import { FileWatcher } from '../../src/watcher/fileWatcher';
import { NomenclatureMapper } from '../../src/mapping/nomenclatureMapper';
import { refreshPromoBundle, readPromoEnvelopeSync } from '../../src/seo/promoCache';
import { prefersMarkdown } from '../../src/seo/promoMarkdown';

let app: express.Express;
let tmpCacheDir: string;
const prevCacheDir = process.env.PROMO_CACHE_DIR;

beforeAll(() => {
  tmpCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanflow-promo-cache-'));
  process.env.PROMO_CACHE_DIR = tmpCacheDir;
  refreshPromoBundle(path.resolve(process.cwd(), 'public'), tmpCacheDir);
  app = createServer(new FileWatcher() as never, new NomenclatureMapper() as never);
});

afterAll(() => {
  if (prevCacheDir === undefined) delete process.env.PROMO_CACHE_DIR;
  else process.env.PROMO_CACHE_DIR = prevCacheDir;
  fs.rmSync(tmpCacheDir, { recursive: true, force: true });
});

describe('ScanFlow promo JSON snapshot cache & AI capabilities (0 DB SELECT)', () => {
  it('serves the blog RSS feed and links it from blog pages', async () => {
    const rss = await request(app).get('/blog/rss.xml');
    expect(rss.status).toBe(200);
    expect(rss.headers['content-type']).toMatch(/application\/rss\+xml/);
    expect(rss.text).toContain('<rss version="2.0"');
    expect(rss.text).toContain('<guid isPermaLink="true">https://scanflow.ru/blog/ocr-nakladnyh-kak-rabotaet</guid>');

    const feedLink = 'type="application/rss+xml" title="Блог ScanFlow" href="https://scanflow.ru/blog/rss.xml"';
    const blog = await request(app).get('/blog');
    expect(blog.text).toContain(feedLink);
    const article = await request(app).get('/blog/ocr-nakladnyh-kak-rabotaet');
    expect(article.text).toContain(feedLink);
  });

  it('writes promo-bundle.json atomically without leaving .tmp files', () => {
    const files = fs.readdirSync(tmpCacheDir);
    expect(files).toEqual(['promo-bundle.json']);
    const env = readPromoEnvelopeSync(tmpCacheDir);
    expect(env?.version).toBe(1);
    expect(env?.dataset).toBe('promo-bundle');
    expect(Object.keys(env?.data.articlesBySlug || {}).length).toBeGreaterThanOrEqual(7);
  });

  it('serves HTML promo pages with 0 DB calls, semantic landmarks, Vary: Accept, and markdown alternates', async () => {
    const home = await request(app).get('/');
    expect(home.status).toBe(200);
    expect(home.headers['vary']).toMatch(/Accept/i);
    expect(home.text).toContain('rel="alternate" type="text/markdown" href="https://scanflow.ru/index.md"');
    expect(home.text).toContain('id="main-content"');
    expect(home.text).toContain('<time datetime="');

    const blog = await request(app).get('/blog');
    expect(blog.status).toBe(200);
    expect(blog.headers['vary']).toMatch(/Accept/i);
    expect(blog.text).toContain('href="https://scanflow.ru/blog.md"');
    expect(blog.text).toContain('id="main-content"');

    const article = await request(app).get('/blog/ocr-nakladnyh-kak-rabotaet');
    expect(article.status).toBe(200);
    expect(article.headers['vary']).toMatch(/Accept/i);
    expect(article.text).toContain('href="https://scanflow.ru/blog/ocr-nakladnyh-kak-rabotaet.md"');
    expect(article.text).toContain('<article class="article-prose">');

    const missing = await request(app).get('/blog/nonexistent-bot-probe-999');
    expect(missing.status).toBe(404);
  });

  it('serves clean Markdown via .md URLs and Accept: text/markdown negotiation with 0 DB calls', async () => {
    expect(prefersMarkdown('text/markdown, text/html;q=0.8')).toBe(true);
    expect(prefersMarkdown('text/html,application/xhtml+xml,*/*;q=0.8')).toBe(false);

    const homeMdExt = await request(app).get('/index.md');
    expect(homeMdExt.status).toBe(200);
    expect(homeMdExt.headers['content-type']).toMatch(/text\/markdown/);
    expect(homeMdExt.headers['x-robots-tag']).toBe('noindex, follow');
    expect(homeMdExt.headers['link']).toContain('<https://scanflow.ru/>; rel="canonical"');
    expect(homeMdExt.text).toContain('# ScanFlow');
    expect(homeMdExt.text).toContain('| **Pro** |');

    const homeNegotiated = await request(app)
      .get('/')
      .set('Accept', 'text/markdown, text/html;q=0.5');
    expect(homeNegotiated.status).toBe(200);
    expect(homeNegotiated.headers['content-type']).toMatch(/text\/markdown/);
    expect(homeNegotiated.headers['x-robots-tag']).toBeUndefined();
    expect(homeNegotiated.text).toBe(homeMdExt.text);

    const artMd = await request(app).get('/blog/ocr-nakladnyh-kak-rabotaet.md');
    expect(artMd.status).toBe(200);
    expect(artMd.headers['content-type']).toMatch(/text\/markdown/);
    expect(artMd.text).toContain('Канонический URL:** https://scanflow.ru/blog/ocr-nakladnyh-kak-rabotaet');

    const privacyMd = await request(app)
      .get('/privacy')
      .set('Accept', 'text/markdown');
    expect(privacyMd.status).toBe(200);
    expect(privacyMd.headers['content-type']).toMatch(/text\/markdown/);
    expect(privacyMd.text).toContain('Политика обработки персональных данных');
  });

  it('serves live /llms.txt, /llms-full.txt, and Content-Signal in /robots.txt with 0 DB calls', async () => {
    const llms = await request(app).get('/llms.txt');
    expect(llms.status).toBe(200);
    expect(llms.text).toContain('https://scanflow.ru/llms-full.txt');

    const llmsFull = await request(app).get('/llms-full.txt');
    expect(llmsFull.status).toBe(200);
    expect(llmsFull.text).toContain('ocr-nakladnyh-kak-rabotaet');
    expect(llmsFull.text.length).toBeGreaterThan(llms.text.length * 2);

    const robots = await request(app).get('/robots.txt');
    expect(robots.status).toBe(200);
    expect(robots.text).toContain('Content-Signal: search=yes, ai-input=yes, ai-train=no');
    expect(robots.text).toContain('Allow: /llms-full.txt');
  });
});
