import { describe, it, expect } from 'vitest';
import { renderPurpose, sanitizePurpose } from '../../src/sber/purposeTemplate';

describe('renderPurpose', () => {
  const ctx = {
    invoice_number: 'НФНФ-000085',
    invoice_date: '2026-05-06',
    total_sum: 66714.11,
    vat_sum: 11119.02,
    vat_rate: 20,
    supplier: 'ООО "Свит лайф"',
  };

  it('renders default template with VAT', () => {
    const out = renderPurpose(
      'Оплата по накладной № {invoice_number} от {invoice_date_dot}, {vat_clause}',
      ctx,
    );
    expect(out).toBe('Оплата по накладной № НФНФ-000085 от 06.05.2026, в т.ч. НДС 20% - 11119.02 руб.');
  });

  it('renders "Без НДС" when vat_sum is null', () => {
    const out = renderPurpose('{vat_clause}', { ...ctx, vat_sum: null });
    expect(out).toBe('Без НДС');
  });

  it('renders "Без НДС" when vat_sum is 0', () => {
    const out = renderPurpose('{vat_clause}', { ...ctx, vat_sum: 0 });
    expect(out).toBe('Без НДС');
  });

  it('substitutes all placeholders', () => {
    const out = renderPurpose(
      '{invoice_number}|{invoice_date_dot}|{invoice_date_iso}|{total}|{vat_amount}|{vat_rate}|{supplier}',
      ctx,
    );
    expect(out).toBe('НФНФ-000085|06.05.2026|2026-05-06|66714.11|11119.02|20|ООО "Свит лайф"');
  });

  it('truncates >210 chars with ellipsis', () => {
    const longTemplate = 'X'.repeat(220);
    const out = renderPurpose(longTemplate, ctx);
    expect(out.length).toBe(210);
    expect(out.endsWith('...')).toBe(true);
  });

  it('handles missing invoice_number gracefully', () => {
    const out = renderPurpose('№ {invoice_number}', { ...ctx, invoice_number: null });
    expect(out).toBe('№ б/н');
  });

  it('handles missing invoice_date', () => {
    const out = renderPurpose('от {invoice_date_dot}', { ...ctx, invoice_date: null });
    expect(out).toBe('от б/д');
  });
});

describe('sanitizePurpose', () => {
  it('replaces ёлочки and curly quotes with straight quotes', () => {
    expect(sanitizePurpose('ООО «Тест» “Hello”')).toBe('ООО "Тест" "Hello"');
  });

  it('replaces non-breaking space with regular space', () => {
    expect(sanitizePurpose('A B')).toBe('A B');
  });

  it('replaces em-dash and en-dash with hyphen', () => {
    expect(sanitizePurpose('A — B – C')).toBe('A - B - C');
  });
});
