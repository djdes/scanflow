import { Article, distinctTags } from './articles';

const TAG_LABELS: Record<string, string> = {
  'ocr': 'OCR',
  '1c-unf': '1С:УНФ',
  'sber': 'Сбер',
  'torg-12': 'ТОРГ-12',
  'suppliers': 'Контрагенты',
  'multi-page': 'Многостраничные',
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDateRu(iso: string): string {
  const months = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${months[m - 1]} ${y}`;
}

interface CardOpts { featured?: boolean; full?: boolean; }

/**
 * Render a single blog card anchor.
 *
 * Class names match the existing CSS in public/css/article.css: `.blog-card`,
 * `.blog-card--featured`, `.blog-card--full`, `.blog-card-tags`, `.blog-card-tag`,
 * `.blog-card-desc`, `.blog-card-meta`. The reading-minutes number is wrapped
 * in <b> to pick up the `.blog-card-meta b` rule (bold, --text colour).
 */
export function renderCard(article: Article, opts: CardOpts = {}): string {
  const classes = ['blog-card'];
  if (opts.featured) classes.push('blog-card--featured');
  if (opts.full) classes.push('blog-card--full');
  const tagChips = article.tags
    .map((t) => `<span class="blog-card-tag" data-tag="${escapeHtml(t)}">${escapeHtml(TAG_LABELS[t] ?? t)}</span>`)
    .join('');
  return [
    `<a class="${classes.join(' ')}" href="/blog/${escapeHtml(article.slug)}">`,
    `  <div class="blog-card-tags">${tagChips}</div>`,
    `  <h3>${escapeHtml(article.title)}</h3>`,
    `  <p class="blog-card-desc">${escapeHtml(article.description)}</p>`,
    `  <div class="blog-card-meta"><b>${article.readingMinutes}</b> мин · ${escapeHtml(formatDateRu(article.date))}</div>`,
    `</a>`,
  ].join('\n');
}

export function renderTagChips(articles: Article[]): string {
  const tags = distinctTags(articles);
  const chips: string[] = [
    `<button type="button" class="blog-tag-chip" data-tag="all" aria-pressed="true">все</button>`,
  ];
  for (const t of tags) {
    chips.push(
      `<button type="button" class="blog-tag-chip" data-tag="${escapeHtml(t)}" aria-pressed="false">${escapeHtml(TAG_LABELS[t] ?? t)}</button>`,
    );
  }
  return chips.join('\n');
}

/**
 * Inject the chip and card markup into the listing HTML. The HTML must contain
 * the two comment placeholders. Cards: index 0 = featured, index 5 = full, rest regular.
 */
export function renderListingHtml(rawHtml: string, articles: Article[]): string {
  const cards = articles.map((a, i) => renderCard(a, {
    featured: i === 0,
    full: i === 5,
  })).join('\n');
  return rawHtml
    .replace('<!-- BLOG-CARDS-PLACEHOLDER -->', cards)
    .replace('<!-- BLOG-TAG-CHIPS-PLACEHOLDER -->', renderTagChips(articles));
}

/**
 * Inject the three newest articles into the landing's blog-preview section.
 * Returns empty string when no articles — the calling code uses this to remove
 * the section if there's nothing to show.
 */
export function renderPreviewHtml(rawHtml: string, articles: Article[]): string {
  if (articles.length === 0) return '';
  // Sort by date desc so the "newest 3" semantics is honoured even if the
  // caller passes an unsorted slice. loadArticles() already sorts, this is
  // defence-in-depth for ad-hoc callers and tests.
  const newest = [...articles].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3);
  const cards = newest.map((a) => renderCard(a)).join('\n');
  return rawHtml.replace('<!-- BLOG-PREVIEW-PLACEHOLDER -->', cards);
}
