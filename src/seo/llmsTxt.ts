import { Article } from './articles';

/**
 * /llms.txt — короткое описание сайта для ИИ-помощников (ChatGPT, Алиса,
 * Perplexity и т. п.) в формате llmstxt.org: заголовок, цитата-описание,
 * списки ссылок с пояснениями.
 *
 * Своего текста здесь нет: описание берётся из <meta name="description">
 * главной, вопросы и ответы — из её разметки FAQPage, статьи — из
 * articles.json. Так цифры и обещания в файле всегда те же, что на сайте
 * (правило 36 CLAUDE.md), и при правке главной он обновляется сам.
 */

interface Faq { q: string; a: string; }

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Одна строка без переводов строк: в llms.txt абзац = строка. */
function oneLine(s: string): string {
  return decodeEntities(s).replace(/\s+/g, ' ').trim();
}

export function landingDescription(landingHtml: string): string {
  const m = landingHtml.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
  return m ? oneLine(m[1]) : '';
}

/** Вопросы и ответы из JSON-LD FAQPage главной. Нет разметки или она битая — []. */
export function landingFaq(landingHtml: string): Faq[] {
  const blocks = landingHtml.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g);
  for (const b of blocks) {
    try {
      const data = JSON.parse(b[1]) as { '@type'?: string; mainEntity?: unknown };
      if (data['@type'] !== 'FAQPage' || !Array.isArray(data.mainEntity)) continue;
      const out: Faq[] = [];
      for (const item of data.mainEntity as Array<Record<string, unknown>>) {
        const q = typeof item.name === 'string' ? oneLine(item.name) : '';
        const ans = item.acceptedAnswer as { text?: unknown } | undefined;
        const a = ans && typeof ans.text === 'string' ? oneLine(ans.text) : '';
        if (q && a) out.push({ q, a });
      }
      return out;
    } catch {
      // битый JSON в одном блоке — смотрим следующий
    }
  }
  return [];
}

export function buildLlmsTxt(siteUrl: string, landingHtml: string, articles: Article[]): string {
  const base = siteUrl.replace(/\/+$/, '');
  const lines: string[] = ['# ScanFlow', ''];

  const description = landingDescription(landingHtml);
  if (description) lines.push(`> ${description}`, '');

  lines.push(
    '## Страницы',
    '',
    `- [Главная](${base}/): что умеет сервис, пример результата, вопросы и ответы`,
    `- [Блог](${base}/blog): статьи о распознавании накладных, 1С:УНФ и СберБизнесе`,
    '',
  );

  if (articles.length > 0) {
    lines.push('## Статьи', '');
    for (const a of articles) {
      lines.push(`- [${oneLine(a.title)}](${base}/blog/${a.slug}): ${oneLine(a.description)}`);
    }
    lines.push('');
  }

  const faq = landingFaq(landingHtml);
  if (faq.length > 0) {
    lines.push('## Вопросы и ответы', '');
    for (const { q, a } of faq) lines.push(`### ${q}`, '', a, '');
  }

  lines.push(
    '## Документы',
    '',
    `- [Политика обработки персональных данных](${base}/privacy)`,
    `- [Согласие на обработку персональных данных](${base}/consent)`,
    `- [Пользовательское соглашение](${base}/terms)`,
    '',
  );

  return lines.join('\n');
}
