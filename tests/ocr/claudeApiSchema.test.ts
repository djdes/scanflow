import { describe, it, expect } from 'vitest';
import { buildSystemBlocks, buildInvoiceSchema, CatalogEntry } from '../../src/ocr/claudeApiAnalyzer';

const CATALOG: CatalogEntry[] = [
  { guid: 'g1', name: 'Молоко 1л', unit: 'шт' },
  { guid: 'g2', name: 'Сахар 50кг', unit: 'кг' },
];

describe('buildSystemBlocks', () => {
  it('returns a single instruction block (with cache_control) when no catalog', () => {
    const blocks = buildSystemBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('text');
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' });
    // Domain logic must survive the restructure.
    expect(blocks[0].text).toContain('ТОРГ-12');
    expect(blocks[0].text).toContain('ДИСЦИПЛИНА ЧТЕНИЯ ЦИФР');
    expect(blocks[0].text).toContain('vat_sum');
  });

  it('adds a second catalog block (own cache breakpoint) when catalog provided', () => {
    const blocks = buildSystemBlocks(CATALOG);
    expect(blocks).toHaveLength(2);
    expect(blocks[1].cache_control).toEqual({ type: 'ephemeral' });
    expect(blocks[1].text).toContain('СПРАВОЧНИК НОМЕНКЛАТУРЫ');
    expect(blocks[1].text).toContain('[1] Молоко 1л (шт)');
    expect(blocks[1].text).toContain('[2] Сахар 50кг (кг)');
    // Instruction block is byte-identical whether or not a catalog is present
    // (keeps the prompt-cache prefix stable across catalog on/off).
    expect(blocks[0].text).toBe(buildSystemBlocks()[0].text);
  });
});

// Structured-outputs compiler limits (both cause a 400):
//   1. union-typed params ≤ 16
//   2. too many optional (non-required) params → "Schema is too complex"
// These helpers walk the schema so a regression on either limit fails a test,
// not a prod invoice.
function walkStats(s: any): { unions: number; optionalTop: number; optionalItem: number } {
  const countUnions = (obj: any): number => {
    let n = 0;
    for (const k of Object.keys(obj.properties ?? {})) {
      const p = obj.properties[k];
      if (Array.isArray(p.type) || p.anyOf) n++;
      if (p.type === 'array' && p.items) n += countUnions(p.items);
    }
    return n;
  };
  const optional = (obj: any): number => {
    const req = new Set(obj.required ?? []);
    return Object.keys(obj.properties ?? {}).filter(k => !req.has(k)).length;
  };
  return {
    unions: countUnions(s),
    optionalTop: optional(s),
    optionalItem: optional(s.properties.items.items),
  };
}

describe('buildInvoiceSchema', () => {
  it('is a closed object; requires invoice_type + core header fields + items', () => {
    const s = buildInvoiceSchema(false) as any;
    expect(s.type).toBe('object');
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toContain('invoice_type');
    expect(s.required).toContain('items');
    expect(s.required).toContain('total_sum');
    expect(s.properties.items.items.additionalProperties).toBe(false);
  });

  it('stays within BOTH structured-output limits (≤16 unions, few optionals)', () => {
    for (const withCat of [false, true]) {
      const s = buildInvoiceSchema(withCat) as any;
      const st = walkStats(s);
      expect(st.unions).toBeLessThanOrEqual(16);
      expect(st.unions).toBeGreaterThan(0);
      // Only the rare bank fields are optional — keeps the grammar simple.
      expect(st.optionalTop).toBeLessThanOrEqual(6);
      expect(st.optionalItem).toBe(0);
    }
  });

  it('core fields are required + nullable (model must emit value or null)', () => {
    const s = buildInvoiceSchema(false) as any;
    expect(s.properties.total_sum.type).toEqual(['number', 'null']);
    expect(s.properties.supplier_inn.type).toEqual(['string', 'null']);
    expect(s.properties.items.items.properties.quantity.type).toEqual(['number', 'null']);
    for (const key of ['name', 'quantity', 'unit', 'price', 'total', 'vat_rate', 'row_no', 'pack_size']) {
      expect(s.properties.items.items.required).toContain(key);
    }
  });

  it('bank fields are optional (present only on счёт на оплату)', () => {
    const s = buildInvoiceSchema(false) as any;
    for (const key of ['supplier_bik', 'supplier_account', 'supplier_corr_account', 'supplier_address']) {
      expect(s.required).not.toContain(key);
      expect(s.properties[key].type).toBe('string');
    }
  });

  it('omits catalog_idx from items when LLM-mapper is off', () => {
    const s = buildInvoiceSchema(false) as any;
    expect(s.properties.items.items.properties.catalog_idx).toBeUndefined();
  });

  it('includes catalog_idx (required + nullable) when LLM-mapper is on', () => {
    const s = buildInvoiceSchema(true) as any;
    expect(s.properties.items.items.properties.catalog_idx.type).toEqual(['number', 'null']);
    expect(s.properties.items.items.required).toContain('catalog_idx');
  });
});
