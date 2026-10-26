import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { LEGAL_PAGES, legalOperator, renderLegalPage, renderOperatorBlock } from '../../src/legal/documents';

const template = (slug: string) =>
  fs.readFileSync(path.join(process.cwd(), 'public', 'legal', `${slug}.html`), 'utf8');

const OPERATOR = legalOperator({
  LEGAL_OPERATOR_NAME: 'ИП Тестов Тест Тестович',
  LEGAL_OPERATOR_INN: '500100732259',
  LEGAL_OPERATOR_OGRN: '304500116000157',
  LEGAL_OPERATOR_ADDRESS: 'г. Москва',
} as NodeJS.ProcessEnv);

describe('legal documents', () => {
  it.each(LEGAL_PAGES)('%s: every LEGAL mark is substituted', (slug) => {
    const html = renderLegalPage(template(slug), OPERATOR);
    expect(html).not.toContain('<!--LEGAL:');
    expect(html).toContain('ИП Тестов Тест Тестович');
    expect(html).toContain('mailto:hi@scanflow.ru');
  });

  it.each(LEGAL_PAGES)('%s: links to the other two documents and has a canonical URL', (slug) => {
    const html = template(slug);
    for (const other of LEGAL_PAGES) expect(html).toContain(`href="/${other}"`);
    expect(html).toContain(`<link rel="canonical" href="https://scanflow.ru/${slug}">`);
  });

  it('without operator details says so instead of inventing them', () => {
    const op = legalOperator({} as NodeJS.ProcessEnv);
    const html = renderLegalPage(template('privacy'), op);
    expect(html).not.toContain('<!--LEGAL:');
    expect(html).toContain('владелец сервиса ScanFlow');
    expect(html).toContain('реквизиты оператора сообщим по запросу');
  });

  it('labels a 15-digit registration number as ОГРНИП and a 13-digit one as ОГРН', () => {
    expect(renderOperatorBlock(OPERATOR)).toContain('<dt>ОГРНИП</dt><dd>304500116000157</dd>');
    const company = legalOperator({ LEGAL_OPERATOR_NAME: 'ООО «Пример»', LEGAL_OPERATOR_OGRN: '1027700132195' } as NodeJS.ProcessEnv);
    expect(renderOperatorBlock(company)).toContain('<dt>ОГРН</dt><dd>1027700132195</dd>');
  });

  it('escapes operator details from env', () => {
    const op = legalOperator({ LEGAL_OPERATOR_NAME: 'ООО «A&B» <script>', LEGAL_CONTACT_EMAIL: 'x"@y.ru' } as NodeJS.ProcessEnv);
    const html = renderLegalPage(template('terms'), op);
    expect(html).not.toContain('«A&B» <script>');
    expect(html).toContain('ООО «A&amp;B» &lt;script&gt;');
    expect(html).toContain('mailto:x&quot;@y.ru');
  });
});
