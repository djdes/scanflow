import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { buildLlmsTxt, landingDescription, landingFaq } from '../../src/seo/llmsTxt';
import type { Article } from '../../src/seo/articles';

const SITE = 'https://scanflow.ru';
const landing = fs.readFileSync(path.resolve(__dirname, '../../public/index.html'), 'utf8');
const article: Article = {
  slug: 'foo', title: 'Статья &amp; заголовок', description: 'Описание\nв две строки',
  tags: ['ocr'], date: '2026-05-11', readingMinutes: 5, ogImage: '/og/default.png',
};

describe('llms.txt', () => {
  it('описание и вопросы берутся с главной', () => {
    expect(landingDescription(landing).length).toBeGreaterThan(40);
    const faq = landingFaq(landing);
    expect(faq.length).toBeGreaterThan(3);
    const txt = buildLlmsTxt(SITE, landing, []);
    expect(txt.startsWith('# ScanFlow\n\n> ')).toBe(true);
    expect(txt).toContain(`> ${landingDescription(landing)}`);
    for (const { q, a } of faq) {
      expect(txt).toContain(`### ${q}`);
      expect(txt).toContain(a);
    }
    expect(txt).not.toContain('## Статьи');
  });

  it('статьи — ссылками в одну строку', () => {
    const txt = buildLlmsTxt(SITE + '/', landing, [article]);
    expect(txt).toContain('- [Статья & заголовок](https://scanflow.ru/blog/foo): Описание в две строки');
  });

  it('главная без описания и разметки — файл всё равно собирается', () => {
    const txt = buildLlmsTxt(SITE, '<html><head></head></html>', []);
    expect(txt.startsWith('# ScanFlow\n\n## Страницы')).toBe(true);
    expect(txt).not.toContain('## Вопросы и ответы');
    expect(landingFaq('<script type="application/ld+json">{битый</script>')).toEqual([]);
  });

  it('ссылки ведут только на свой сайт', () => {
    const txt = buildLlmsTxt(SITE, landing, [article]);
    for (const m of txt.matchAll(/\]\((https?:\/\/[^)]+)\)/g)) expect(m[1].startsWith(SITE + '/')).toBe(true);
  });
});
