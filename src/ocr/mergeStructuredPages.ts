import type { ParsedInvoiceData } from './types';
import { normalizeInvoiceNumber } from '../utils/invoiceNumber';

const HEADER_FIELDS = [
  'invoice_type', 'invoice_number', 'invoice_date', 'supplier', 'supplier_inn',
  'supplier_kpp', 'supplier_bik', 'supplier_account', 'supplier_corr_account', 'supplier_address',
] as const;

/**
 * Фото/PDF уже прочитаны по страницам: склеиваем JSON без повторного чтения
 * моделью, которое может переставить числа между товарами (инцидент 781).
 * null означает обычный OCR-текст: ему по-прежнему нужен текстовый анализатор.
 */
export function mergeStructuredPageText(text: string, pageCount: number): ParsedInvoiceData | null {
  if (!Number.isInteger(pageCount) || pageCount < 2) return null;
  const parts = text.split('--- СТРАНИЦА ---');
  if (parts.length !== pageCount) return null;
  const pages: ParsedInvoiceData[] = [];
  for (const part of parts) {
    let page: ParsedInvoiceData;
    try { page = JSON.parse(part.trim()); } catch { return null; }
    if (!page || !Array.isArray(page.items)
      || page.items.some(it => !it || typeof it.name !== 'string' || !it.name.trim())) return null;
    pages.push(page);
  }

  const numbers = pages.map(p => normalizeInvoiceNumber(p.invoice_number)).filter(Boolean);
  if (new Set(numbers).size > 1) throw new Error('У страниц разные номера накладных — объединение отменено');

  // Страницы могут загрузиться в обратном порядке. При сквозной нумерации
  // шапку берём с первого листа, итог — с последнего, строки сортируем по «№».
  const allItems = pages.flatMap(p => p.items);
  const nos = allItems.map(it => it.row_no);
  const numbered = nos.length > 0 && nos.every(n => Number.isInteger(n) && (n as number) > 0)
    && new Set(nos).size === nos.length;
  if (numbered) {
    const firstNo = (p: ParsedInvoiceData) => Math.min(...p.items.map(it => it.row_no as number));
    pages.sort((a, b) => firstNo(a) - firstNo(b));
  }
  const items = pages.flatMap(p => p.items);
  if (numbered) items.sort((a, b) => (a.row_no as number) - (b.row_no as number));

  const merged: ParsedInvoiceData = { items };
  for (const field of HEADER_FIELDS) {
    const value = pages.map(p => p[field]).find(v => v != null && v !== '');
    if (value != null) Object.assign(merged, { [field]: value });
  }
  for (const page of pages) {
    if (typeof page.total_sum === 'number' && Number.isFinite(page.total_sum)) merged.total_sum = page.total_sum;
    if (typeof page.vat_sum === 'number' && Number.isFinite(page.vat_sum)) merged.vat_sum = page.vat_sum;
  }
  return merged;
}
