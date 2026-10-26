import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Разметка FAQPage в <script type="application/ld+json"> должна повторять
// видимые вопросы и ответы на главной: поисковики штрафуют за расхождение,
// а при правке текста одного блока второй легко забыть.

const html = fs.readFileSync(path.resolve(__dirname, '../../public/index.html'), 'utf8');

function plain(fragment: string): string {
  return fragment
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function visibleFaq(): Array<{ q: string; a: string }> {
  const section = html.match(/<section class="faq"[\s\S]*?<\/section>/);
  expect(section).not.toBeNull();
  return [...section![0].matchAll(/<article class="qa"[^>]*>\s*<h3>([\s\S]*?)<\/h3>\s*<p>([\s\S]*?)<\/p>/g)]
    .map((m) => ({ q: plain(m[1]), a: plain(m[2]) }));
}

function structuredFaq(): Array<{ q: string; a: string }> {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((m) => JSON.parse(m[1]));
  const faq = blocks.find((b) => b['@type'] === 'FAQPage');
  expect(faq).toBeDefined();
  return faq.mainEntity.map((e: { name: string; acceptedAnswer: { text: string } }) => ({
    q: e.name.replace(/\s+/g, ' ').trim(),
    a: e.acceptedAnswer.text.replace(/\s+/g, ' ').trim(),
  }));
}

describe('landing FAQ', () => {
  it('has 6–12 questions on the page', () => {
    const items = visibleFaq();
    expect(items.length).toBeGreaterThanOrEqual(6);
    expect(items.length).toBeLessThanOrEqual(12);
  });

  it('FAQPage JSON-LD matches the visible questions and answers', () => {
    expect(structuredFaq()).toEqual(visibleFaq());
  });
});
