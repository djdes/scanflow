import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const script = readFileSync('public/js/invoices.js', 'utf8');
let invoices: any;
let app: any;
beforeEach(() => {
  app = { apiJson: vi.fn(), notify: vi.fn() };
  invoices = runInNewContext(`${script}\nInvoices;`, { App: app });
  invoices.mergeSibling = vi.fn();
  invoices.openInvoice = vi.fn();
});

describe('manual page merge from the invoice list', () => {
  it('opens the manual picker even when automatic sibling detection has no match', async () => {
    const picker = { open: vi.fn() };
    const value = runInNewContext(`${script}\nInvoices;`, { App: app, InvoiceMerge: picker });
    await value.mergePagesFromList(895);
    expect(picker.open).toHaveBeenCalledWith(895); expect(app.apiJson).not.toHaveBeenCalled();
  });
  it('offers the matching invoice returned by the server', async () => {
    app.apiJson.mockResolvedValue({ data: { id: 52, possible_siblings: [{ id: 51 }] } });
    await invoices.mergePagesFromList(52);
    expect(app.apiJson).toHaveBeenCalledWith('/invoices/52');
    expect(invoices.mergeSibling).toHaveBeenCalledWith(52, 51, undefined);
  });
  it('keeps the existing confirmation about an already sent document', async () => {
    app.apiJson.mockResolvedValue({ data: { possible_siblings: [{ id: 51, status: 'sent_to_1c' }] } });
    await invoices.mergePagesFromList(52);
    expect(invoices.mergeSibling).toHaveBeenCalledWith(52, 51, true);
  });
  it('explains when there are no matching pages', async () => {
    app.apiJson.mockResolvedValue({ data: { possible_siblings: [] } });
    await invoices.mergePagesFromList(52);
    expect(invoices.mergeSibling).not.toHaveBeenCalled();
    expect(app.notify).toHaveBeenCalledWith(expect.stringContaining('не найдено'), 'info');
  });
  it('opens all candidates for choosing instead of merging an arbitrary one', async () => {
    app.apiJson.mockResolvedValue({ data: { possible_siblings: [{ id: 51 }, { id: 50 }] } });
    await invoices.mergePagesFromList(52);
    expect(invoices.openInvoice).toHaveBeenCalledWith(52);
    expect(invoices.mergeSibling).not.toHaveBeenCalled();
  });
  it.each([{ ocr_engine: 'xml_upd' }, { file_name: 'invoice.XML' }])('does not merge a complete XML document %j', async (source) => {
    app.apiJson.mockResolvedValue({ data: { ...source, possible_siblings: [{ id: 51 }] } });
    await invoices.mergePagesFromList(52);
    expect(invoices.mergeSibling).not.toHaveBeenCalled();
    expect(app.notify).toHaveBeenCalledWith(expect.stringContaining('XML'), 'info');
  });
  it('reports lookup failures without attempting a merge', async () => {
    app.apiJson.mockRejectedValue(new Error('timeout'));
    await invoices.mergePagesFromList(52);
    expect(invoices.mergeSibling).not.toHaveBeenCalled();
    expect(app.notify).toHaveBeenCalledWith(expect.stringContaining('timeout'), 'error');
  });
});

describe('manual merge selection', () => {
  const picker = runInNewContext(readFileSync('public/js/invoice-merge.js', 'utf8') + '\nInvoiceMerge;', { App: { isXmlInvoice: (v: any) => String(v.file_name || '').endsWith('.xml') } });
  const first = { id: 893, invoice_number: '1/567558', supplier_inn: '123', invoice_date: '2026-10-19' };
  const second = { id: 895, invoice_number: null, supplier_inn: '123', invoice_date: null };
  it('allows a continuation without number/date and prefers the numbered main page', () => {
    expect(picker.compatible(second, first)).toBe(true);
    expect(picker.preferredTarget(second, first)).toEqual(first);
    expect(picker.preferredTarget({ ...second, id: 891 }, first)).toEqual(first);
  });
  it('rejects another known number, date, company, self, XML or duplicate', () => {
    for (const change of [{ invoice_number: 'OTHER' }, { invoice_date: '2026-10-20' }, { supplier_inn: '456' }, { id: 893 }, { file_name: 'a.xml' }, { duplicate_of: 5 }]) {
      expect(picker.compatible(first, { ...first, id: 895, ...change })).toBe(false);
    }
  });
});
