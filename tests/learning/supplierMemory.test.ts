import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/database/db', () => ({ getDb: vi.fn() }));
vi.mock('../../src/services/engineFlags', () => ({ getEngineFlags: vi.fn() }));

import { formatSupplierMemory, SUPPLIER_MEMORY_MAX_CHARS, type MemorySupplier } from '../../src/learning/supplierMemory';
import { buildSystemBlocks } from '../../src/ocr/claudeApiAnalyzer';

const sup = (i: number, over: Partial<MemorySupplier> = {}): MemorySupplier => ({
  inn: `77243576${String(i).padStart(2, '0')}`,
  name: `ООО «Поставщик ${i}»`,
  kpp: '772401001',
  nameVariants: [],
  innVariants: [],
  units: [],
  ...over,
});

describe('formatSupplierMemory', () => {
  it('is empty when there is nothing to say', () => {
    expect(formatSupplierMemory([])).toBe('');
  });

  it('lists requisites, variants and printed units — never conversion factors', () => {
    const text = formatSupplierMemory([sup(1, {
      nameVariants: ['Поставщик 1 ООО'],
      innVariants: ['7724357682'],
      units: [{ name: 'Батон нарезной 0,4 кг', unit: 'шт' }],
    })]);
    expect(text).toContain('ИНН 7724357601, КПП 772401001');
    expect(text).toContain('«Поставщик 1 ООО»');
    expect(text).toContain('7724357682');
    expect(text).toContain('«Батон нарезной 0,4 кг» — шт');
    expect(text).toContain('НЕ пересчитывай');
    expect(text).not.toMatch(/=\s*\d/);
  });

  it('omits KPP for individual entrepreneurs (12-digit INN)', () => {
    const text = formatSupplierMemory([sup(1, { inn: '940504779259', name: 'ИП Кнутова А.С.', kpp: '771801001' })]);
    expect(text).toContain('ИНН 940504779259');
    expect(text).not.toMatch(/940504779259, КПП/);
  });

  it('respects the length cap: trims units first, then drops suppliers', () => {
    const many = Array.from({ length: 40 }, (_, i) => sup(i, {
      units: Array.from({ length: 12 }, (_, k) => ({ name: `Товар номер ${k} с длинным названием для проверки лимита`, unit: 'кг' })),
    }));
    const text = formatSupplierMemory(many);
    expect(text.length).toBeLessThanOrEqual(SUPPLIER_MEMORY_MAX_CHARS);
    expect(text).toContain('Поставщик 0»');
    const small = formatSupplierMemory(many, 900);
    expect(small.length).toBeLessThanOrEqual(900);
    expect(small).toContain('Поставщик 0»');
  });
});

describe('buildSystemBlocks with memory', () => {
  it('appends memory as the last block and skips blank memory', () => {
    const catalog = [{ guid: 'g1', name: 'Батон', unit: 'кг' }];
    const withMem = buildSystemBlocks(catalog, 'ПАМЯТКА');
    expect(withMem).toHaveLength(3);
    expect(withMem[2]).toBe('ПАМЯТКА');
    expect(buildSystemBlocks(catalog, '  ')).toHaveLength(2);
    expect(buildSystemBlocks(undefined, 'ПАМЯТКА')).toHaveLength(2);
  });
});
