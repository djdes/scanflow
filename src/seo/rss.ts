import { Article } from './articles';

/** Экранирование для текста внутри XML. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Дата RFC 822 — её ждут RSS-читалки. Статьи хранят YYYY-MM-DD, берём полночь UTC. */
function rfc822(date: string): string {
  return new Date(`${date}T00:00:00Z`).toUTCString();
}

export const RSS_PATH = '/blog/rss.xml';

/**
 * RSS 2.0 блога: по записи на статью, описание — из articles.json (не весь текст),
 * чтобы читалки и агрегаторы (Дзен, Feedly, Telegram-боты RSS) вели на сайт.
 */
export function buildRssXml(siteUrl: string, articles: Article[]): string {
  const base = siteUrl.replace(/\/+$/, '');
  const sorted = [...articles].sort((a, b) =>
    (b.updated ?? b.date).localeCompare(a.updated ?? a.date)
  );
  const lastBuild = sorted[0]
    ? rfc822(sorted[0].updated ?? sorted[0].date)
    : new Date().toUTCString();

  const items = sorted.map((a) => {
    const url = `${base}/blog/${esc(a.slug)}`;
    const cats = a.tags.map((t) => `      <category>${esc(t)}</category>`);
    return [
      '    <item>',
      `      <title>${esc(a.title)}</title>`,
      `      <link>${url}</link>`,
      `      <guid isPermaLink="true">${url}</guid>`,
      `      <description>${esc(a.description)}</description>`,
      `      <pubDate>${rfc822(a.date)}</pubDate>`,
      ...cats,
      '    </item>',
    ].join('\n');
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    '    <title>Блог ScanFlow</title>',
    `    <link>${base}/blog</link>`,
    '    <description>Статьи о распознавании накладных, загрузке в 1С:УНФ и автоматизации закупок.</description>',
    '    <language>ru</language>',
    `    <lastBuildDate>${lastBuild}</lastBuildDate>`,
    `    <atom:link href="${base}${RSS_PATH}" rel="self" type="application/rss+xml" />`,
    ...items,
    '  </channel>',
    '</rss>',
  ].join('\n');
}

/** Ссылка на ленту в <head>: по ней браузеры и читалки находят RSS сами. */
export function injectRssAlternateLink(html: string, siteUrl: string): string {
  if (html.includes('type="application/rss+xml"')) return html;
  const base = siteUrl.replace(/\/+$/, '');
  const tag = `<link rel="alternate" type="application/rss+xml" title="Блог ScanFlow" href="${base}${RSS_PATH}">`;
  return html.replace('</head>', `  ${tag}\n</head>`);
}
