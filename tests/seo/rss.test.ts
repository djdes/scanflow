import { describe, it, expect } from 'vitest';
import { buildRssXml, injectRssAlternateLink } from '../../src/seo/rss';
import type { Article } from '../../src/seo/articles';

const a = (slug: string, date: string, extra: Partial<Article> = {}): Article => ({
  slug, title: `T ${slug}`, description: 'd', tags: ['ocr'], date,
  readingMinutes: 5, ogImage: '/og/default.png', ...extra,
});

describe('buildRssXml', () => {
  it('builds a valid RSS 2.0 channel with self link', () => {
    const xml = buildRssXml('https://scanflow.ru/', [a('foo', '2026-05-01')]);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<rss version="2.0"');
    expect(xml).toContain('<link>https://scanflow.ru/blog</link>');
    expect(xml).toContain('href="https://scanflow.ru/blog/rss.xml" rel="self"');
    expect(xml).toContain('<language>ru</language>');
    expect(xml).toContain('<guid isPermaLink="true">https://scanflow.ru/blog/foo</guid>');
    expect(xml).toContain('<pubDate>Fri, 01 May 2026 00:00:00 GMT</pubDate>');
    expect(xml).toContain('<category>ocr</category>');
  });

  it('orders items by update date and uses it for lastBuildDate', () => {
    const xml = buildRssXml('https://scanflow.ru', [
      a('old', '2026-04-01', { updated: '2026-10-26' }),
      a('new', '2026-05-01'),
    ]);
    expect(xml.indexOf('/blog/old<')).toBeLessThan(xml.indexOf('/blog/new<'));
    expect(xml).toContain('<lastBuildDate>Mon, 26 Oct 2026 00:00:00 GMT</lastBuildDate>');
  });

  it('escapes titles and descriptions', () => {
    const xml = buildRssXml('https://scanflow.ru', [a('x', '2026-01-01', { title: 'A & <B>', description: '"q"' })]);
    expect(xml).toContain('<title>A &amp; &lt;B&gt;</title>');
    expect(xml).toContain('<description>&quot;q&quot;</description>');
  });
});

describe('injectRssAlternateLink', () => {
  it('adds the feed link into <head> once', () => {
    const once = injectRssAlternateLink('<html><head><title>x</title></head></html>', 'https://scanflow.ru');
    expect(once).toContain('<link rel="alternate" type="application/rss+xml" title="Блог ScanFlow" href="https://scanflow.ru/blog/rss.xml">');
    expect(injectRssAlternateLink(once, 'https://scanflow.ru')).toBe(once);
  });
});
