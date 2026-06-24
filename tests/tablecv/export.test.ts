import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const xp = require('../../public/js/tablecv/export.js');

const cells = [
  { row: 0, col: 0, rowSpan: 1, colSpan: 1, x: 0, y: 0, w: 10, h: 10, text: 'A' },
  { row: 0, col: 1, rowSpan: 1, colSpan: 2, x: 10, y: 0, w: 20, h: 10, text: 'B&C' },
];

describe('cellsToJSON', () => {
  it('wraps cells and meta', () => {
    const s = xp.cellsToJSON(cells, { rows: 1 });
    const o = JSON.parse(s);
    expect(o.meta).toEqual({ rows: 1 });
    expect(o.cells).toHaveLength(2);
  });
});

describe('cellsToHTMLTable', () => {
  it('emits colspan only when > 1 and escapes text', () => {
    const html = xp.cellsToHTMLTable(cells);
    expect(html).toContain('<td>A</td>');
    expect(html).toContain('colspan="2"');
    expect(html).toContain('B&amp;C');
    expect(html).not.toContain('rowspan=');
  });
});
