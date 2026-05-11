import { describe, it, expect, beforeAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

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

  it('GET /blog/ returns 301 redirect to /blog', async () => {
    const res = await request(app).get('/blog/').redirects(0);
    expect(res.status).toBe(301);
    expect(res.headers['location']).toBe('/blog');
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
