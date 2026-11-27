import { Article } from './articles';

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Date the article last changed: `updated` when set, otherwise `date`. */
function articleLastmod(a: Article): string {
  return a.updated ?? a.date;
}

/**
 * Build a sitemap.xml document for the site. Static entries are the landing
 * and the blog index; dynamic entries are one per article.
 *
 * `lastmod` is only a real date. Google and Yandex trust it only while it is
 * "consistently and verifiably accurate": a date that is always today (the
 * previous behaviour for the landing and the blog index) teaches the crawler
 * to ignore lastmod for the whole file, including the honest article dates.
 * So: articles — updated ?? date; blog index — the newest article; landing —
 * no tag (its changes are not tracked anywhere).
 */
export function buildSitemapXml(siteUrl: string, articles: Article[]): string {
  const base = siteUrl.replace(/\/+$/, '');
  const newest = articles
    .map(articleLastmod)
    .filter((d) => ISO_DAY.test(d))
    .sort()
    .pop();
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    `  <url>`,
    `    <loc>${base}/</loc>`,
    `    <changefreq>monthly</changefreq>`,
    `    <priority>1.0</priority>`,
    `  </url>`,
    `  <url>`,
    `    <loc>${base}/blog</loc>`,
    ...(newest ? [`    <lastmod>${newest}</lastmod>`] : []),
    `    <changefreq>weekly</changefreq>`,
    `    <priority>0.8</priority>`,
    `  </url>`,
  ];
  for (const a of articles) {
    const lastmod = articleLastmod(a);
    lines.push(`  <url>`);
    lines.push(`    <loc>${base}/blog/${xmlEscape(a.slug)}</loc>`);
    lines.push(`    <lastmod>${lastmod}</lastmod>`);
    lines.push(`    <changefreq>monthly</changefreq>`);
    lines.push(`    <priority>0.7</priority>`);
    lines.push(`  </url>`);
  }
  lines.push('</urlset>');
  return lines.join('\n');
}
