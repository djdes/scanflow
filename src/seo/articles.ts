import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

export interface Article {
  slug: string;
  title: string;
  description: string;
  tags: string[];
  date: string;             // ISO YYYY-MM-DD
  readingMinutes: number;
  ogImage: string;          // path relative to site root, e.g. "/og/default.jpg"
  updated?: string;
}

export interface ArticlesIndex {
  articles: Article[];
}

const ARTICLES_JSON = path.resolve(process.cwd(), 'public/blog/articles.json');

/**
 * Load and validate articles.json. Returns a sorted-by-date (descending) array.
 * On any error returns []. Never throws — a missing or malformed file should
 * gracefully degrade to "no articles", not crash the server.
 */
export function loadArticles(filePath: string = ARTICLES_JSON): Article[] {
  try {
    if (!fs.existsSync(filePath)) {
      logger.warn('articles.json missing — blog will render empty', { filePath });
      return [];
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw) as Partial<ArticlesIndex>;
    if (!data || !Array.isArray(data.articles)) return [];
    const valid = data.articles.filter(isValid);
    const dropped = data.articles.length - valid.length;
    if (dropped > 0) {
      logger.warn('articles.json: dropped invalid entries', { dropped, total: data.articles.length });
    }
    return [...valid].sort((a, b) => b.date.localeCompare(a.date));
  } catch (err) {
    logger.error('Failed to load articles.json', { error: (err as Error).message });
    return [];
  }
}

function isValid(a: unknown): a is Article {
  if (!a || typeof a !== 'object') return false;
  const x = a as Record<string, unknown>;
  return (
    typeof x.slug === 'string' && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(x.slug) &&
    typeof x.title === 'string' && x.title.length > 0 &&
    typeof x.description === 'string' && x.description.length > 0 &&
    Array.isArray(x.tags) && x.tags.every((t) => typeof t === 'string') &&
    typeof x.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.date) &&
    typeof x.readingMinutes === 'number' && x.readingMinutes > 0 &&
    typeof x.ogImage === 'string'
  );
}

/**
 * Return all distinct tag slugs across articles, preserving the order of
 * first appearance (so the tag chips render in a stable order).
 */
export function distinctTags(articles: Article[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of articles) for (const t of a.tags) if (!seen.has(t)) { seen.add(t); out.push(t); }
  return out;
}

/**
 * Pick up to N articles that share at least one tag with the source, excluding the source itself.
 * Used for the "Related" section at the end of each article.
 */
export function relatedArticles(all: Article[], source: Article, n = 3): Article[] {
  const tagSet = new Set(source.tags);
  return all
    .filter((a) => a.slug !== source.slug && a.tags.some((t) => tagSet.has(t)))
    .slice(0, n);
}
