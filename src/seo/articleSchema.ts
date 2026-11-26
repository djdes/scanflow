import { Article } from './articles';

/**
 * Разметка schema.org для статьи блога: BlogPosting и BreadcrumbList.
 *
 * Данные берутся из public/blog/articles.json — того же источника, что список
 * статей и sitemap, поэтому разметка не расходится с ними. Сервер вставляет её
 * в <head> статьи при отдаче (/blog/:slug); в самих HTML-файлах её нет, и при
 * новой статье ничего дописывать руками не нужно.
 *
 * В разметке только то, что есть на странице: заголовок, описание, даты,
 * картинка. Оценок, отзывов и автора-человека нет — их нет и в статье.
 */

const SITE_NAME = 'ScanFlow';

function absolute(base: string, p: string): string {
  if (/^https?:\/\//i.test(p)) return p;
  return `${base}${p.startsWith('/') ? '' : '/'}${p}`;
}

export function buildArticleJsonLd(siteUrl: string, article: Article): object[] {
  const base = siteUrl.replace(/\/+$/, '');
  const url = `${base}/blog/${article.slug}`;
  const org = {
    '@type': 'Organization',
    name: SITE_NAME,
    url: `${base}/`,
    logo: { '@type': 'ImageObject', url: `${base}/icon-512.png` },
  };
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: article.title,
      description: article.description,
      url,
      mainEntityOfPage: { '@type': 'WebPage', '@id': url },
      image: absolute(base, article.ogImage || '/og/default.png'),
      datePublished: article.date,
      dateModified: article.updated ?? article.date,
      inLanguage: 'ru',
      keywords: article.tags.join(', '),
      timeRequired: `PT${article.readingMinutes}M`,
      author: org,
      publisher: org,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Главная', item: `${base}/` },
        { '@type': 'ListItem', position: 2, name: 'Блог', item: `${base}/blog` },
        { '@type': 'ListItem', position: 3, name: article.title, item: url },
      ],
    },
  ];
}

/**
 * JSON внутри <script>: «<» экранируется, чтобы текст из articles.json
 * («</script>», «<!--») не мог закрыть тег или открыть комментарий.
 */
function scriptJson(data: object): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Вставляет разметку статьи перед </head>. Если в файле уже есть свой
 * BlogPosting (кто-то добавил руками) или нет </head> — HTML не меняется.
 */
export function injectArticleJsonLd(html: string, siteUrl: string, article: Article | undefined): string {
  if (!article) return html;
  if (/"@type"\s*:\s*"BlogPosting"/.test(html)) return html;
  const idx = html.search(/<\/head>/i);
  if (idx === -1) return html;
  const scripts = buildArticleJsonLd(siteUrl, article)
    .map((d) => `  <script type="application/ld+json">${scriptJson(d)}</script>\n`)
    .join('');
  return html.slice(0, idx) + scripts + html.slice(idx);
}
