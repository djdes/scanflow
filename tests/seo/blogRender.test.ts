import { describe, it, expect } from 'vitest';
import { renderCard, renderListingHtml, renderPreviewHtml, renderTagChips } from '../../src/seo/blogRender';
import type { Article } from '../../src/seo/articles';

const a = (overrides: Partial<Article> = {}): Article => ({
  slug: 'foo-bar', title: 'Тест статьи', description: 'Описание', tags: ['ocr'],
  date: '2026-05-01', readingMinutes: 7, ogImage: '/og/default.svg', ...overrides,
});

describe('renderCard', () => {
  it('emits an <a> linking to /blog/<slug>', () => {
    const html = renderCard(a());
    expect(html).toContain('href="/blog/foo-bar"');
  });
  it('renders title, description, reading time and pretty date', () => {
    const html = renderCard(a());
    expect(html).toContain('Тест статьи');
    expect(html).toContain('Описание');
    expect(html).toContain('7 мин');
    expect(html).toContain('1 мая 2026');
  });
  it('renders each tag with the .blog-card-tag class', () => {
    const html = renderCard(a({ tags: ['ocr', '1c-unf'] }));
    expect((html.match(/blog-card-tag/g) || []).length).toBe(2);
  });
  it('escapes HTML in title and description', () => {
    const html = renderCard(a({ title: '<script>x</script>' }));
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });
  it('marks the first card as featured when isFeatured=true', () => {
    expect(renderCard(a(), { featured: true })).toContain('blog-card--featured');
  });
  it('marks a card as full when isFull=true', () => {
    expect(renderCard(a(), { full: true })).toContain('blog-card--full');
  });
});

describe('renderListingHtml', () => {
  it('substitutes both chip and card placeholders', () => {
    const html = '<x><!-- BLOG-TAG-CHIPS-PLACEHOLDER --></x><y><!-- BLOG-CARDS-PLACEHOLDER --></y>';
    const out = renderListingHtml(html, [a()]);
    expect(out).toContain('blog-card');
    expect(out).toContain('blog-tag-chip');
    expect(out).not.toContain('PLACEHOLDER');
  });
  it('renders 6+ articles with featured(1st) + full(6th)', () => {
    const arts = Array.from({ length: 6 }, (_, i) => a({ slug: `s${i}`, date: `2026-05-0${i+1}` }));
    const out = renderListingHtml('<!-- BLOG-CARDS-PLACEHOLDER -->', arts);
    expect((out.match(/blog-card--featured/g) || []).length).toBe(1);
    expect((out.match(/blog-card--full/g) || []).length).toBe(1);
  });
});

describe('renderPreviewHtml', () => {
  it('inserts up to 3 newest cards into a doc with the placeholder', () => {
    const doc = '<div class="blog-preview-grid"><!-- BLOG-PREVIEW-PLACEHOLDER --></div>';
    const arts = Array.from({ length: 5 }, (_, i) => a({ slug: `s${i}`, date: `2026-05-0${i+1}` }));
    const out = renderPreviewHtml(doc, arts);
    expect((out.match(/blog-card/g) || []).length).toBe(3);
    expect(out).toContain('s4'); // newest
  });
  it('renders nothing (placeholder removed) when there are no articles', () => {
    const doc = '<!-- BLOG-PREVIEW-PLACEHOLDER -->';
    expect(renderPreviewHtml(doc, [])).toBe('');
  });
});

describe('renderTagChips', () => {
  it('emits an "все" chip first, then one chip per distinct tag', () => {
    const html = renderTagChips([a({ tags: ['ocr'] }), a({ slug: 'b', tags: ['ocr', 'sber'] })]);
    expect((html.match(/blog-tag-chip/g) || []).length).toBe(3);
    expect(html.indexOf('все')).toBeLessThan(html.indexOf('ocr'));
  });
});
