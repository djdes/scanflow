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

  it('strips trailing slash from siteUrl so URLs are well-formed', () => {
    const xml = buildSitemapXml('https://scanflow.ru/', [a('foo', '2026-05-01')]);
    expect(xml).toContain('<loc>https://scanflow.ru/</loc>');     // home should be exactly one slash
    expect(xml).toContain('<loc>https://scanflow.ru/blog</loc>'); // not //blog
    expect(xml).toContain('<loc>https://scanflow.ru/blog/foo</loc>');
    expect(xml).not.toContain('//blog');
  });

  it('emits lastmod in W3C YYYY-MM-DD format for home and blog', () => {
    const xml = buildSitemapXml('https://scanflow.ru', []);
    // Both static entries should have a YYYY-MM-DD lastmod (not full ISO timestamp).
    const matches = xml.match(/<lastmod>([^<]+)<\/lastmod>/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    for (const m of matches) {
      expect(m).toMatch(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
    }
  });
});
