import { isXmlInvoice } from '../xml';

export interface InvoiceCompleteness {
  /** Сквозная нумерация прочитана у всех позиций; это не гарантия наличия последнего листа. */
  checked: boolean;
  first_row: number | null;
  last_row: number | null;
  missing_ranges: Array<{ from: number; to: number }>;
  message: string | null;
  /** Человек сверил бумагу и подтвердил, что страниц больше нет (invoices.pages_confirmed). */
  confirmed?: boolean;
}

/** Проверяем весь документ после склейки, а не отдельную страницу продолжения. */
export function invoiceCompleteness(invoice: {
  ocr_engine?: string | null;
  file_name?: string | null;
  pages_confirmed?: number | boolean | null;
  items: ReadonlyArray<{ row_no?: number | null }>;
}): InvoiceCompleteness {
  const unknown: InvoiceCompleteness = {
    checked: false, first_row: null, last_row: null, missing_ranges: [], message: null,
  };
  if (isXmlInvoice(invoice) || !invoice.items.length) return unknown;
  const numbers = invoice.items.map(item => item.row_no);
  // Отсутствующий/непрочитанный номер мог заполнить любой разрыв. Не выдаём
  // отсутствие нумерации за отсутствие страницы и не придумываем номера.
  if (!numbers.every(n => Number.isSafeInteger(n) && (n as number) > 0)) return unknown;
  const sorted = [...new Set(numbers as number[])].sort((a, b) => a - b);
  const missing: InvoiceCompleteness['missing_ranges'] = [];
  let previous = 0;
  for (const n of sorted) {
    if (n > previous + 1) missing.push({ from: previous + 1, to: n - 1 });
    previous = n;
  }
  const ranges = missing.slice(0, 8).map(r => r.from === r.to ? String(r.from) : `${r.from}–${r.to}`).join(', ');
  const suffix = missing.length > 8 ? ` и ещё ${missing.length - 8} диапазон(а)` : '';
  const message = missing.length
    ? `Накладная, возможно, снята не полностью: не найдены позиции ${ranges}${suffix}. Добавьте фото недостающих страниц или проверьте нумерацию по оригиналу.`
    : null;
  // Подтверждение человека снимает предупреждение, но разрывы остаются в ответе.
  if (Number(invoice.pages_confirmed) === 1 || invoice.pages_confirmed === true) {
    return { checked: true, first_row: sorted[0], last_row: sorted[sorted.length - 1], missing_ranges: missing, message: null, confirmed: true };
  }
  return { checked: true, first_row: sorted[0], last_row: sorted[sorted.length - 1], missing_ranges: missing, message };
}

/** Та же проверка для списков и выдачи в 1С. table — только внутренний SQL-псевдоним. */
export function incompleteInvoiceSql(table: 'invoices' | 'i' = 'invoices'): string {
  return `(COALESCE(${table}.pages_confirmed, 0) = 0
    AND LEFT(COALESCE(${table}.ocr_engine, ''), 4) <> 'xml_'
    AND LOWER(COALESCE(${table}.file_name, '')) NOT REGEXP '[.]xml([[:space:]]*,|[[:space:]]*$)'
    AND EXISTS (
      SELECT 1 FROM invoice_items completeness_items
      WHERE completeness_items.invoice_id = ${table}.id
      GROUP BY completeness_items.invoice_id
      HAVING COUNT(completeness_items.row_no) = COUNT(*) AND MIN(completeness_items.row_no) > 0
        AND (MIN(completeness_items.row_no) > 1
          OR MAX(completeness_items.row_no) - MIN(completeness_items.row_no) + 1 > COUNT(DISTINCT completeness_items.row_no))
    ))`;
}
