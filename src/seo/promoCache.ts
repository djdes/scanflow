import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { loadArticles, Article } from './articles';
import { buildSitemapXml } from './sitemap';
import { buildRssXml, injectRssAlternateLink } from './rss';
import { renderListingHtml, renderPreviewHtml } from './blogRender';
import { LEGAL_PAGES, LegalPage, legalOperator, renderLegalPage } from '../legal/documents';
import { applyHeroVariants, injectSiteConfig, siteConfig } from './siteConfig';
import { injectArticleJsonLd } from './articleSchema';
import { buildLlmsTxt } from './llmsTxt';
import {
  buildArticleMarkdown,
  buildBlogIndexMarkdown,
  buildLandingMarkdown,
  buildLegalMarkdown,
  buildLlmsFullTxt,
  ensureMainContentId,
  injectMarkdownAlternateLink,
} from './promoMarkdown';

const SITE = 'https://scanflow.ru';
const DATASET_NAME = 'promo-bundle';
/**
 * Версия формата снимка: входит в подпись. Меняйте при любой правке сборки
 * (новое поле, новая вставка в <head>), иначе снимок, собранный прежним кодом
 * при тех же файлах public/, отдавался бы и дальше.
 */
const BUNDLE_FORMAT = 2;

export interface ScanflowPromoBundle {
  landingHtml: string;
  landingMarkdown: string;
  blogIndexHtml: string;
  blogIndexMarkdown: string;
  articlesBySlug: Record<string, {
    article: Article;
    html: string;
    markdown: string;
  }>;
  legalBySlug: Record<LegalPage, {
    html: string;
    markdown: string;
  }>;
  sitemapXml: string;
  rssXml: string;
  llmsTxt: string;
  llmsFullTxt: string;
}

export interface PromoSnapshotEnvelope<T> {
  version: 1;
  dataset: string;
  generatedAt: string;
  sourceSignature: string;
  data: T;
}

/**
 * Каталог файловых JSON-снапшотов ScanFlow:
 * 1) PROMO_CACHE_DIR (для тестов и ручного переопределения)
 * 2) data/promo-cache (каталог data/ исключён из rsync --delete в deploy.yml и из git)
 */
export function resolvePromoCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = (env.PROMO_CACHE_DIR || '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(process.cwd(), 'data', 'promo-cache');
}

export function resolvePromoBundlePath(cacheDir?: string): string {
  const root = path.resolve(cacheDir || resolvePromoCacheDir());
  const target = path.resolve(root, `${DATASET_NAME}.json`);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (!target.startsWith(prefix)) {
    throw new Error('Snapshot path escaped promo cache directory');
  }
  return target;
}

function statStamp(filePath: string): string {
  try {
    const st = fs.statSync(filePath);
    return `${st.size}:${Math.trunc(st.mtimeMs)}`;
  } catch {
    return 'missing';
  }
}

export function computePromoSourceSignature(
  publicDir: string = path.resolve(process.cwd(), 'public'),
  env: NodeJS.ProcessEnv = process.env
): string {
  const h = crypto.createHash('sha256');
  h.update(`format:${BUNDLE_FORMAT}`);
  h.update(JSON.stringify(siteConfig(env)));
  h.update(JSON.stringify(legalOperator(env)));
  h.update(statStamp(path.join(publicDir, 'index.html')));
  h.update(statStamp(path.join(publicDir, 'blog', 'articles.json')));
  h.update(statStamp(path.join(publicDir, 'blog', 'index.html')));

  try {
    const blogFiles = fs.readdirSync(path.join(publicDir, 'blog'))
      .filter((f) => f.endsWith('.html'))
      .sort();
    for (const f of blogFiles) {
      h.update(f + ':' + statStamp(path.join(publicDir, 'blog', f)));
    }
  } catch {
    // ignore missing blog dir
  }

  for (const slug of LEGAL_PAGES) {
    h.update(slug + ':' + statStamp(path.join(publicDir, 'legal', `${slug}.html`)));
  }

  return h.digest('hex').slice(0, 24);
}

export function buildPromoBundleFromDiskSources(
  publicDir: string = path.resolve(process.cwd(), 'public'),
  env: NodeJS.ProcessEnv = process.env
): ScanflowPromoBundle {
  const cfg = siteConfig(env);
  const operator = legalOperator(env);
  const articles = loadArticles(path.join(publicDir, 'blog', 'articles.json'));

  const rawLanding = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const withPreview = renderPreviewHtml(rawLanding, articles) || rawLanding;
  const landingHtml = injectMarkdownAlternateLink(
    ensureMainContentId(applyHeroVariants(injectSiteConfig(withPreview, cfg), cfg)),
    `${SITE}/index.md`
  );
  const landingMarkdown = buildLandingMarkdown(rawLanding, articles);

  const rawBlogListing = fs.readFileSync(path.join(publicDir, 'blog', 'index.html'), 'utf8');
  const blogIndexHtml = injectMarkdownAlternateLink(
    injectRssAlternateLink(
      ensureMainContentId(injectSiteConfig(renderListingHtml(rawBlogListing, articles), cfg)),
      SITE
    ),
    `${SITE}/blog.md`
  );
  const blogIndexMarkdown = buildBlogIndexMarkdown(articles);

  const articlesBySlug: ScanflowPromoBundle['articlesBySlug'] = {};
  const articlesMdOrdered: Array<{ slug: string; markdown: string }> = [];

  for (const article of articles) {
    const file = path.join(publicDir, 'blog', `${article.slug}.html`);
    if (!fs.existsSync(file)) continue;
    const rawArticleHtml = fs.readFileSync(file, 'utf8');
    const renderedArticleHtml = injectMarkdownAlternateLink(
      injectRssAlternateLink(
        ensureMainContentId(
          injectSiteConfig(injectArticleJsonLd(rawArticleHtml, SITE, article), cfg)
        ),
        SITE
      ),
      `${SITE}/blog/${article.slug}.md`
    );
    const articleMd = buildArticleMarkdown(article, rawArticleHtml);
    articlesBySlug[article.slug] = {
      article,
      html: renderedArticleHtml,
      markdown: articleMd,
    };
    articlesMdOrdered.push({ slug: article.slug, markdown: articleMd });
  }

  // Также подхватываем html-файлы блога на диске, если статья есть на диске без записи в articles.json
  try {
    const diskHtmlFiles = fs.readdirSync(path.join(publicDir, 'blog'))
      .filter((f) => f.endsWith('.html') && f !== 'index.html');
    for (const f of diskHtmlFiles) {
      const slug = f.slice(0, -'.html'.length);
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || articlesBySlug[slug]) continue;
      const rawHtml = fs.readFileSync(path.join(publicDir, 'blog', f), 'utf8');
      const fallbackArticle: Article = {
        slug,
        title: slug,
        description: '',
        tags: [],
        date: '2026-01-01',
        readingMinutes: 5,
        ogImage: '/og/default.png',
      };
      const renderedHtml = injectMarkdownAlternateLink(
        ensureMainContentId(injectSiteConfig(injectArticleJsonLd(rawHtml, SITE, undefined), cfg)),
        `${SITE}/blog/${slug}.md`
      );
      articlesBySlug[slug] = {
        article: fallbackArticle,
        html: renderedHtml,
        markdown: buildArticleMarkdown(fallbackArticle, rawHtml),
      };
    }
  } catch {
    // ignore
  }

  const legalBySlug = {} as ScanflowPromoBundle['legalBySlug'];
  for (const slug of LEGAL_PAGES) {
    const rawLegal = fs.readFileSync(path.join(publicDir, 'legal', `${slug}.html`), 'utf8');
    const renderedLegal = injectMarkdownAlternateLink(
      ensureMainContentId(injectSiteConfig(renderLegalPage(rawLegal, operator), cfg)),
      `${SITE}/${slug}.md`
    );
    legalBySlug[slug] = {
      html: renderedLegal,
      markdown: buildLegalMarkdown(slug, renderedLegal),
    };
  }

  const sitemapXml = buildSitemapXml(SITE, articles);
  const rssXml = buildRssXml(SITE, articles);
  const llmsTxt = buildLlmsTxt(SITE, rawLanding, articles);
  const llmsFullTxt = buildLlmsFullTxt(llmsTxt, landingMarkdown, articlesMdOrdered);

  return {
    landingHtml,
    landingMarkdown,
    blogIndexHtml,
    blogIndexMarkdown,
    articlesBySlug,
    legalBySlug,
    sitemapXml,
    rssXml,
    llmsTxt,
    llmsFullTxt,
  };
}

export function readPromoEnvelopeSync(
  cacheDir?: string
): PromoSnapshotEnvelope<ScanflowPromoBundle> | null {
  const filePath = resolvePromoBundlePath(cacheDir);
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as PromoSnapshotEnvelope<ScanflowPromoBundle>;
    if (
      !parsed ||
      parsed.version !== 1 ||
      parsed.dataset !== DATASET_NAME ||
      !parsed.data
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writePromoBundleAtomicSync(
  data: ScanflowPromoBundle,
  sourceSignature: string,
  cacheDir?: string
): PromoSnapshotEnvelope<ScanflowPromoBundle> {
  const filePath = resolvePromoBundlePath(cacheDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const envelope: PromoSnapshotEnvelope<ScanflowPromoBundle> = {
    version: 1,
    dataset: DATASET_NAME,
    generatedAt: new Date().toISOString(),
    sourceSignature,
    data,
  };
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(envelope, null, 2) + '\n', 'utf8');
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
  return envelope;
}

/**
 * Читает прогретый JSON-снапшот промо-страниц с диска (0 обращений к БД, 0 удержания HTML в RAM процесса).
 * Автоматически пересобирает снапшот атомарно через tmp + rename, если изменились исходные шаблоны/статьи/env.
 */
export function readOrBuildPromoBundle(
  publicDir: string = path.resolve(process.cwd(), 'public'),
  cacheDir?: string,
  env: NodeJS.ProcessEnv = process.env
): ScanflowPromoBundle {
  const existing = readPromoEnvelopeSync(cacheDir);
  if (existing && env.PROMO_CACHE_LOCKED === '1') {
    return existing.data;
  }
  const currentSig = computePromoSourceSignature(publicDir, env);
  if (existing && existing.sourceSignature === currentSig) {
    return existing.data;
  }
  const fresh = buildPromoBundleFromDiskSources(publicDir, env);
  try {
    writePromoBundleAtomicSync(fresh, currentSig, cacheDir);
  } catch {
    // Если диск только для чтения в песочнице — безопасно отдаём свежую сборку
  }
  return fresh;
}

export function refreshPromoBundle(
  publicDir: string = path.resolve(process.cwd(), 'public'),
  cacheDir?: string,
  env: NodeJS.ProcessEnv = process.env
): PromoSnapshotEnvelope<ScanflowPromoBundle> {
  const sig = computePromoSourceSignature(publicDir, env);
  const fresh = buildPromoBundleFromDiskSources(publicDir, env);
  return writePromoBundleAtomicSync(fresh, sig, cacheDir);
}
