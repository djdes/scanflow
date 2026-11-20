import { Article } from './articles';
import { landingDescription, landingFaq } from './llmsTxt';
import { billingPlans } from '../billing/catalog';

const SITE = 'https://scanflow.ru';

export function prefersMarkdown(acceptHeader: string | undefined | null): boolean {
  if (!acceptHeader) return false;
  let mdQ = -1;
  let htmlQ = -1;

  for (const part of acceptHeader.split(',')) {
    const [rawType, ...params] = part.trim().toLowerCase().split(';');
    if (!rawType) continue;
    let q = 1;
    for (const p of params) {
      const [k, v] = p.trim().split('=');
      if (k === 'q' && v !== undefined) {
        const parsed = Number(v);
        if (!Number.isNaN(parsed)) q = Math.max(0, Math.min(1, parsed));
      }
    }
    if (q <= 0) continue;
    if (rawType === 'text/markdown' || rawType === 'text/x-markdown') {
      mdQ = Math.max(mdQ, q);
    } else if (rawType === 'text/html' || rawType === 'application/xhtml+xml') {
      htmlQ = Math.max(htmlQ, q);
    }
  }
  return mdQ > 0 && mdQ >= htmlQ;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&laquo;/gi, '«')
    .replace(/&raquo;/gi, '»')
    .replace(/&ndash;|&#8211;/gi, '–')
    .replace(/&mdash;|&#8212;/gi, '—')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

export function htmlProseToMarkdown(rawHtml: string): string {
  // Extract <article class="article-prose"> or <main> body when present
  let body = rawHtml;
  const proseStart = rawHtml.indexOf('<!-- BODY PROSE START -->');
  if (proseStart !== -1) {
    const afterStart = rawHtml.slice(proseStart + '<!-- BODY PROSE START -->'.length);
    const articleEnd = afterStart.indexOf('</article>');
    body = articleEnd !== -1 ? afterStart.slice(0, articleEnd) : afterStart;
  } else {
    const mainMatch = rawHtml.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    if (mainMatch) body = mainMatch[1];
  }

  // Strip scripts, styles, nav, and SVG noise
  body = body
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '');

  // Preserve fenced code blocks
  body = body.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_m, code: string) => {
    return `\n\`\`\`\n${decodeHtmlEntities(code.replace(/<[^>]+>/g, '')).trim()}\n\`\`\`\n`;
  });

  // Convert HTML tables to Markdown tables
  body = body.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_m, tableHtml: string) => {
    const rows: string[][] = [];
    for (const trMatch of tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells: string[] = [];
      for (const cellMatch of trMatch[1].matchAll(/<(?:th|td)[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)) {
        const txt = decodeHtmlEntities(cellMatch[1].replace(/<[^>]+>/g, ' '))
          .replace(/\s+/g, ' ')
          .replace(/\|/g, '\\|')
          .trim();
        cells.push(txt);
      }
      if (cells.length > 0) rows.push(cells);
    }
    if (rows.length === 0) return '';
    const cols = Math.max(...rows.map((r) => r.length));
    const pad = (r: string[]) => Array.from({ length: cols }, (_, i) => r[i] ?? '');
    const header = `| ${pad(rows[0]).join(' | ')} |`;
    const sep = `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`;
    const rest = rows.slice(1).map((r) => `| ${pad(r).join(' | ')} |`);
    return `\n${[header, sep, ...rest].join('\n')}\n`;
  });

  // Headings, inline formatting, links, lists, paragraphs
  body = body
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_m, t: string) => `\n# ${decodeHtmlEntities(t.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()}\n`)
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_m, t: string) => `\n## ${decodeHtmlEntities(t.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()}\n`)
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_m, t: string) => `\n### ${decodeHtmlEntities(t.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()}\n`)
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (_m, t: string) => `\n#### ${decodeHtmlEntities(t.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()}\n`)
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, t: string) => `\`${decodeHtmlEntities(t.replace(/<[^>]+>/g, '')).trim()}\``)
    .replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, (_m, t: string) => `**${decodeHtmlEntities(t.replace(/<[^>]+>/g, '')).trim()}**`)
    .replace(/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, (_m, t: string) => `*${decodeHtmlEntities(t.replace(/<[^>]+>/g, '')).trim()}*`)
    .replace(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const cleanLabel = decodeHtmlEntities(label.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
      const absHref = href.startsWith('/') ? `${SITE}${href}` : href;
      return cleanLabel ? `[${cleanLabel}](${absHref})` : absHref;
    })
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, t: string) => `- ${decodeHtmlEntities(t.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()}\n`)
    .replace(/<\/?(?:ul|ol|blockquote|section|div|article|header|footer)[^>]*>/gi, '\n')
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, '');

  return decodeHtmlEntities(body)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function buildLandingMarkdown(landingHtml: string, articles: Article[]): string {
  const desc = landingDescription(landingHtml);
  const faq = landingFaq(landingHtml);

  const lines: string[] = [
    '# ScanFlow — распознавание накладных по фото для 1С:УНФ и СберБизнеса',
    '',
    ...(desc ? [`> ${desc}`, ''] : []),
    `Канонический URL: ${SITE}/`,
    '',
    '## Как работает ScanFlow',
    '- **Фото или скан документа:** загрузите фото ТОРГ-12, УПД, счёта или XML ФНС из Telegram, мобильного приложения `/m/`, почты или веб-кабинета (медианное время распознавания ~30 с).',
    '- **Проверки точности:** сверка `количество × цена ≈ сумма` по каждой строке, контроль сквозной нумерации многостраничных накладных, пересчёт упаковок и веса.',
    '- **Интеграция с 1С:УНФ:** сопоставление товаров с вашей номенклатурой 1С (с памятью выбора и автозаполнением контрагента по ИНН через DaData), готовый документ `ПриходнаяНакладная`.',
    '- **Черновик платёжки в СберБизнесе:** отправка платёжного поручения в черновики СберБизнес API для подписи руководителем.',
    '',
    '## Тарифы (во время открытой беты полный доступ бесплатный)',
    '',
    '| Тариф | Стоимость в месяц | Страниц в месяц | Возможности |',
    '|---|---|---|---|',
    ...billingPlans.map((p) => {
      const rub = p.monthlyPriceKopecks === 0 ? '0 ₽' : `${Math.round(p.monthlyPriceKopecks / 100)} ₽`;
      return `| **${p.name}** | ${rub} | до ${p.pagesPerMonth} | ${p.features.join('; ')} |`;
    }),
    '',
  ];

  if (articles.length > 0) {
    lines.push('## Технические разборы в блоге', '');
    for (const a of articles) {
      lines.push(`- [${a.title}](${SITE}/blog/${a.slug}) (${a.date}, ${a.readingMinutes} мин): ${a.description}`);
    }
    lines.push('');
  }

  if (faq.length > 0) {
    lines.push('## Частые вопросы', '');
    for (const item of faq) {
      lines.push(`### ${item.q}`, '', item.a, '');
    }
  }

  lines.push(
    '## Правовые документы и контакты',
    `- Email поддержки: hi@scanflow.ru`,
    `- [Политика обработки персональных данных](${SITE}/privacy)`,
    `- [Согласие на обработку персональных данных](${SITE}/consent)`,
    `- [Пользовательское соглашение](${SITE}/terms)`,
    '',
  );

  return `${lines.join('\n').trim()}\n`;
}

export function buildBlogIndexMarkdown(articles: Article[]): string {
  const lines: string[] = [
    '# Блог ScanFlow — OCR накладных, 1С:УНФ, СберБизнес и контрагенты',
    '',
    '> Технические разборы, гайды по интеграции с 1С:УНФ и СберБизнесом, разборы реальных OCR-ошибок на ТОРГ-12 и приёмы автоматизации учёта.',
    '',
    `Канонический URL: ${SITE}/blog`,
    '',
    '## Все статьи',
    '',
    ...articles.map(
      (a) => `- **[${a.title}](${SITE}/blog/${a.slug})** (${a.date}${a.updated ? `, обновлено ${a.updated}` : ''}, ${a.readingMinutes} мин) — ${a.description} ([Markdown](${SITE}/blog/${a.slug}.md))`
    ),
    '',
  ];
  return `${lines.join('\n').trim()}\n`;
}

export function buildArticleMarkdown(article: Article, rawHtml: string): string {
  const prose = htmlProseToMarkdown(rawHtml);
  const lines: string[] = [
    `# ${article.title}`,
    '',
    `> ${article.description}`,
    '',
    `- **Канонический URL:** ${SITE}/blog/${article.slug}`,
    `- **Дата публикации:** ${article.date}`,
    ...(article.updated ? [`- **Обновлено:** ${article.updated}`] : []),
    `- **Время чтения:** ${article.readingMinutes} мин`,
    `- **Темы:** ${article.tags.join(', ')}`,
    '',
    prose,
    '',
  ];
  return `${lines.join('\n').trim()}\n`;
}

export function buildLegalMarkdown(slug: string, renderedHtml: string): string {
  const prose = htmlProseToMarkdown(renderedHtml);
  return `${prose}\n\nКанонический URL: ${SITE}/${slug}\n`;
}

export function buildLlmsFullTxt(
  llmsSummary: string,
  landingMd: string,
  articlesMd: Array<{ slug: string; markdown: string }>
): string {
  const parts: string[] = [
    llmsSummary.trim(),
    '---',
    landingMd.trim(),
  ];
  for (const item of articlesMd) {
    parts.push('---', item.markdown.trim());
  }
  return `${parts.join('\n\n')}\n`;
}

export function injectMarkdownAlternateLink(html: string, mdHref: string): string {
  const tag = `<link rel="alternate" type="text/markdown" href="${mdHref}">`;
  if (html.includes('type="text/markdown"')) return html;
  const canonicalRe = /(<link\s+rel="canonical"\s+href="[^"]*"\s*\/?>)/i;
  if (canonicalRe.test(html)) {
    return html.replace(canonicalRe, `$1\n  ${tag}`);
  }
  return html.replace('</head>', `  ${tag}\n</head>`);
}

export function ensureMainContentId(html: string): string {
  if (html.includes('id="main-content"')) return html;
  return html.replace(/<main(\s|>)/i, '<main id="main-content"$1');
}
