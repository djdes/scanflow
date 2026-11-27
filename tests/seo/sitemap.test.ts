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

  it('emits lastmod in W3C YYYY-MM-DD format', () => {
    const xml = buildSitemapXml('https://scanflow.ru', [a('foo', '2026-05-01')]);
    const matches = xml.match(/<lastmod>([^<]+)<\/lastmod>/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    for (const m of matches) {
      expect(m).toMatch(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
    }
  });

  it('never stamps today: blog index gets the newest article date, landing gets no lastmod', () => {
    const today = new Date().toISOString().slice(0, 10);
    const arts = [a('old', '2026-03-01'), { ...a('edited', '2026-02-01'), updated: '2026-06-15' }, a('mid', '2026-05-01')];
    const xml = buildSitemapXml('https://scanflow.ru', arts);
    expect(xml).not.toContain(`<lastmod>${today}</lastmod>`);
    const blog = xml.match(/<loc>https:\/\/scanflow\.ru\/blog<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/);
    expect(blog?.[1]).toBe('2026-06-15');
    const home = xml.match(/<url>\s*<loc>https:\/\/scanflow\.ru\/<\/loc>([\s\S]*?)<\/url>/);
    expect(home?.[1]).not.toContain('<lastmod>');
  });

  it('omits blog lastmod when there are no articles', () => {
    const xml = buildSitemapXml('https://scanflow.ru', []);
    expect(xml).not.toContain('<lastmod>');
  });
});
