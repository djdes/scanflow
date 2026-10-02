import { describe, it, expect } from 'vitest';
import { compareItems, validRegion } from '../../src/services/invoiceReview';
import type { InvoiceItem } from '../../src/database/repositories/invoiceRepo';
const item = (id: number, extra: Partial<InvoiceItem> = {}) => ({ id, invoice_id: 1, original_name: 'Молоко', onec_guid: 'milk', unit: 'шт', price: 50, quantity: 2, total: 100, vat_rate: 20, conv_factor: 1, ...extra } as InvoiceItem);
describe('supplier comparison semantics', () => {
    it('compares canonical units and refuses incompatible VAT or conversion', () => {
        expect(compareItems([item(1, { price: 60, unit: 'штук' })], [item(2)])[0]).toMatchObject({ comparable: true, price_change_pct: expect.closeTo(20) });
        for (const extra of [{ unit: 'кг' }, { vat_rate: 22 }, { vat_rate: null }, { conv_factor: 12 }, { qty_flag: 'suspect' }])
            expect(compareItems([item(1, extra)], [item(2)])[0].comparable).toBe(false);
    });
    it('does not arbitrarily match duplicate rows or incompatible catalog GUIDs', () => {
        const rows = compareItems([item(1), item(2)], [item(3), item(4)]);
        expect(rows.filter(r => r.current && r.match === 'ambiguous')).toHaveLength(2);
        expect(rows.every(r => !r.comparable)).toBe(true);
        expect(compareItems([item(1)], [item(2, { onec_guid: 'other' })])[0].previous).toBeNull();
    });
    it('reports new/missing items and uniquely matches names without GUIDs', () => {
        const rows = compareItems([item(1, { onec_guid: null }), item(2, { original_name: 'Масло', onec_guid: null })], [item(3, { onec_guid: null }), item(4, { original_name: 'Сметана', onec_guid: null })]);
        expect(rows.map(r => r.match)).toEqual(['name', 'new', 'missing']);
    });
    it('rejects invalid normalized rectangles', () => {
        const r = { filename: 'a.jpg', target_key: 'header:total_sum', x: 0, y: 0, width: 1, height: 1 };
        expect(validRegion(r)).toBe(true);
        expect(validRegion({ ...r, x: NaN })).toBe(false);
        expect(validRegion({ ...r, width: 0 })).toBe(false);
        expect(validRegion({ ...r, height: 1.1 })).toBe(false);
    });
});
