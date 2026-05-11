import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadArticles, distinctTags, relatedArticles, Article } from '../../src/seo/articles';

const tmpDirs: string[] = [];

function tmpJson(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-articles-'));
  tmpDirs.push(dir);
  const p = path.join(dir, 'articles.json');
  fs.writeFileSync(p, contents, 'utf8');
  return p;
}

afterAll(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const sample: Article = {
  slug: 'a', title: 'A', description: 'd', tags: ['ocr'], date: '2026-05-01',
  readingMinutes: 5, ogImage: '/og/default.jpg',
};

describe('loadArticles', () => {
  it('returns [] when file is missing', () => {
    expect(loadArticles('/nonexistent.json')).toEqual([]);
  });

  it('returns [] when JSON is malformed', () => {
    const p = tmpJson('{ not json');
    expect(loadArticles(p)).toEqual([]);
  });

  it('returns [] when articles is not an array', () => {
    const p = tmpJson('{"articles": "nope"}');
    expect(loadArticles(p)).toEqual([]);
  });

  it('filters out invalid entries', () => {
    const p = tmpJson(JSON.stringify({
      articles: [sample, { ...sample, slug: 'BAD SLUG WITH SPACES' }],
    }));
    expect(loadArticles(p).map((a) => a.slug)).toEqual(['a']);
  });

  it('sorts by date descending', () => {
    const p = tmpJson(JSON.stringify({
      articles: [
        { ...sample, slug: 'old', date: '2026-01-01' },
        { ...sample, slug: 'new', date: '2026-05-01' },
        { ...sample, slug: 'mid', date: '2026-03-01' },
      ],
    }));
    expect(loadArticles(p).map((a) => a.slug)).toEqual(['new', 'mid', 'old']);
  });

  it('rejects uppercase letters in slug', () => {
    const p = tmpJson(JSON.stringify({ articles: [{ ...sample, slug: 'Hello-World' }] }));
    expect(loadArticles(p)).toEqual([]);
  });

  it('rejects readingMinutes <= 0', () => {
    const p = tmpJson(JSON.stringify({ articles: [{ ...sample, readingMinutes: 0 }] }));
    expect(loadArticles(p)).toEqual([]);
  });

  it('accepts an article with empty tags array', () => {
    const p = tmpJson(JSON.stringify({ articles: [{ ...sample, tags: [] }] }));
    const out = loadArticles(p);
    expect(out).toHaveLength(1);
    expect(out[0].tags).toEqual([]);
  });

  it('preserves the optional updated field', () => {
    const p = tmpJson(JSON.stringify({ articles: [{ ...sample, updated: '2026-05-10' }] }));
    expect(loadArticles(p)[0].updated).toBe('2026-05-10');
  });
});

describe('distinctTags', () => {
  it('preserves order of first appearance', () => {
    expect(distinctTags([
      { ...sample, slug: '1', tags: ['ocr', '1c-unf'] },
      { ...sample, slug: '2', tags: ['1c-unf', 'sber'] },
      { ...sample, slug: '3', tags: ['ocr', 'sber'] },
    ])).toEqual(['ocr', '1c-unf', 'sber']);
  });
});

describe('relatedArticles', () => {
  it('returns articles sharing at least one tag, excluding source', () => {
    const all: Article[] = [
      { ...sample, slug: 'src', tags: ['ocr', 'sber'] },
      { ...sample, slug: 'a',   tags: ['ocr'] },
      { ...sample, slug: 'b',   tags: ['sber', '1c-unf'] },
      { ...sample, slug: 'c',   tags: ['multi-page'] },
    ];
    const r = relatedArticles(all, all[0], 3).map((a) => a.slug);
    expect(r).toEqual(['a', 'b']);
  });

  it('respects N', () => {
    const all: Article[] = [
      { ...sample, slug: 'src', tags: ['ocr'] },
      { ...sample, slug: '1',   tags: ['ocr'] },
      { ...sample, slug: '2',   tags: ['ocr'] },
      { ...sample, slug: '3',   tags: ['ocr'] },
    ];
    expect(relatedArticles(all, all[0], 2).length).toBe(2);
  });
});
