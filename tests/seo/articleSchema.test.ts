import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { buildArticleJsonLd, injectArticleJsonLd } from '../../src/seo/articleSchema';
import { loadArticles, type Article } from '../../src/seo/articles';

const SITE = 'https://scanflow.ru';
const article: Article = {
  slug: 'foo-bar', title: 'Заголовок статьи', description: 'Описание статьи',
  tags: ['ocr', '1c-unf'], date: '2026-05-11', updated: '2026-10-26',
  readingMinutes: 7, ogImage: '/og/default.png',
};

function ldBlocks(html: string): Array<Record<string, any>> {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((m) => JSON.parse(m[1]));
}

describe('buildArticleJsonLd', () => {
  it('BlogPosting повторяет данные статьи и даёт абсолютные адреса', () => {
    const [post] = buildArticleJsonLd(SITE + '/', article) as Array<Record<string, any>>;
    expect(post['@type']).toBe('BlogPosting');
    expect(post.headline).toBe(article.title);
    expect(post.description).toBe(article.description);
    expect(post.url).toBe('https://scanflow.ru/blog/foo-bar');
    expect(post.mainEntityOfPage['@id']).toBe(post.url);
    expect(post.image).toBe('https://scanflow.ru/og/default.png');
    expect(post.datePublished).toBe('2026-05-11');
    expect(post.dateModified).toBe('2026-10-26');
    expect(post.timeRequired).toBe('PT7M');
    expect(post.publisher.logo.url).toBe('https://scanflow.ru/icon-512.png');
  });

  it('без updated дата изменения равна дате публикации', () => {
    const [post] = buildArticleJsonLd(SITE, { ...article, updated: undefined }) as Array<Record<string, any>>;
    expect(post.dateModified).toBe('2026-05-11');
  });

  it('хлебные крошки: Главная → Блог → статья', () => {
    const [, crumbs] = buildArticleJsonLd(SITE, article) as Array<Record<string, any>>;
    expect(crumbs['@type']).toBe('BreadcrumbList');
    expect(crumbs.itemListElement.map((i: any) => [i.position, i.item])).toEqual([
      [1, 'https://scanflow.ru/'],
      [2, 'https://scanflow.ru/blog'],
      [3, 'https://scanflow.ru/blog/foo-bar'],
    ]);
  });
});

describe('injectArticleJsonLd', () => {
  const page = '<html><head><title>t</title></head><body>текст</body></html>';

  it('вставляет два блока перед </head>', () => {
    const html = injectArticleJsonLd(page, SITE, article);
    expect(html.indexOf('application/ld+json')).toBeLessThan(html.indexOf('</head>'));
    expect(ldBlocks(html).map((b) => b['@type'])).toEqual(['BlogPosting', 'BreadcrumbList']);
    expect(html.endsWith('<body>текст</body></html>')).toBe(true);
  });

  it('текст с </script> не закрывает тег разметки', () => {
    const html = injectArticleJsonLd(page, SITE, { ...article, title: 'a</script><script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert(1)');
    expect(ldBlocks(html)[0].headline).toBe('a</script><script>alert(1)</script>');
  });

  it('не меняет страницу без статьи в articles.json, без </head> и со своей разметкой', () => {
    expect(injectArticleJsonLd(page, SITE, undefined)).toBe(page);
    expect(injectArticleJsonLd('<body>x</body>', SITE, article)).toBe('<body>x</body>');
    const own = '<head><script type="application/ld+json">{"@type": "BlogPosting"}</script></head>';
    expect(injectArticleJsonLd(own, SITE, article)).toBe(own);
  });
});

describe('статьи блога в репозитории', () => {
  const dir = path.resolve(__dirname, '../../public/blog');
  const articles = loadArticles(path.join(dir, 'articles.json'));

  it('у каждой статьи есть файл, а разметка совпадает с canonical страницы', () => {
    expect(articles.length).toBeGreaterThan(0);
    for (const a of articles) {
      const raw = fs.readFileSync(path.join(dir, `${a.slug}.html`), 'utf8');
      const html = injectArticleJsonLd(raw, SITE, a);
      const post = ldBlocks(html).find((b) => b['@type'] === 'BlogPosting');
      expect(post, a.slug).toBeDefined();
      const canonical = raw.match(/<link rel="canonical" href="([^"]+)"/);
      expect(canonical?.[1], a.slug).toBe(post!.url);
    }
  });
});
