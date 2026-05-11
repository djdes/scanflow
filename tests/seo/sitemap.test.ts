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
    expect(xml).not.toContain('bad&slug<');
    expect(xml).toContain('bad&amp;slug');
  });

  it('uses article.updated when present, falls back to date', () => {
    const art = { ...a('foo', '2026-01-01'), updated: '2026-05-10' };
    const xml = buildSitemapXml('https://scanflow.ru', [art]);
    expect(xml).toContain('<lastmod>2026-05-10</lastmod>');
  });
});
