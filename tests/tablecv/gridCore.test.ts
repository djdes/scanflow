import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const grid = require('../../public/js/tablecv/gridCore.js');

describe('clusterCoords', () => {
  it('groups near values and returns cluster means sorted', () => {
    expect(grid.clusterCoords([10, 12, 11, 50, 51], 5)).toEqual([11, 50]);
  });
  it('keeps far-apart values separate', () => {
    expect(grid.clusterCoords([0, 100, 200], 5)).toEqual([0, 100, 200]);
  });
  it('handles empty input', () => {
    expect(grid.clusterCoords([], 5)).toEqual([]);
  });
});

describe('mergeCells', () => {
  const allV = (R: number, C: number) =>
    Array.from({ length: R }, () => Array.from({ length: C }, () => true));
  const allH = (R: number, C: number) =>
    Array.from({ length: R }, () => Array.from({ length: C }, () => true));

  it('full borders → every base cell is its own region', () => {
    const regions = grid.mergeCells(2, 2, allV(2, 2), allH(2, 2));
    expect(regions).toHaveLength(4);
  });

  it('missing vertical border merges two cells horizontally', () => {
    const v = allV(2, 2);
    v[1][1] = false; // no border between (1,0) and (1,1)
    const regions = grid.mergeCells(2, 2, v, allH(2, 2));
    expect(regions).toHaveLength(3);
    expect(regions).toContainEqual({ r0: 1, c0: 0, r1: 1, c1: 1 });
  });

  it('missing horizontal border merges two cells vertically', () => {
    const h = allH(2, 2);
    h[1][0] = false; // no border between (0,0) and (1,0)
    const regions = grid.mergeCells(2, 2, allV(2, 2), h);
    expect(regions).toHaveLength(3);
    expect(regions).toContainEqual({ r0: 0, c0: 0, r1: 1, c1: 0 });
  });
});

describe('regionsToCells', () => {
  it('maps a region to a pixel cell with spans', () => {
    const xs = [0, 100, 300];
    const ys = [0, 50, 90];
    const cells = grid.regionsToCells([{ r0: 1, c0: 0, r1: 1, c1: 1 }], xs, ys);
    expect(cells).toEqual([
      { row: 1, col: 0, rowSpan: 1, colSpan: 2, x: 0, y: 50, w: 300, h: 40, text: '' },
    ]);
  });
});
