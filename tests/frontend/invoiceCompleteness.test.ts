import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { invoiceCompleteness } from '../../src/ocr/invoiceCompleteness';

const script = readFileSync('public/js/invoices.js', 'utf8');
const html = { innerHTML: '' };
const invoices = runInNewContext(`${script}\nInvoices;`, {
  document: { getElementById: () => html },
  App: { esc: (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') },
});

// Предупреждение под шапкой карточки (#ic-completeness), видно с любой вкладки.
describe('invoice completeness warning in the card', () => {
  it('shows missing positions and Add pages', () => {
    const completeness = invoiceCompleteness({ items: [{ row_no: 21 }, { row_no: 22 }] });
    invoices._renderCompleteness({ id: 42, completeness });
    expect(html.innerHTML).toContain('1–20');
    expect(html.innerHTML).toContain('Добавить страницы');
    expect(html.innerHTML).toContain('Invoices.addPages(42, event)');
  });

  it('clears the warning when the missing page has been added', () => {
    invoices._renderCompleteness({ id: 42, completeness: { message: 'Не найдены позиции 1–20' } });
    const completeness = invoiceCompleteness({ items: [1, 2, 3].map(row_no => ({ row_no })) });
    invoices._renderCompleteness({ id: 42, completeness });
    expect(html.innerHTML).toBe('');
  });
});
