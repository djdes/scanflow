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
