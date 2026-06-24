// tests/tablecv/ocrClean.test.ts
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const oc = require('../../public/js/tablecv/ocrClean.js');

describe('cleanCellText', () => {
  it('drops low-confidence text', () => {
    expect(oc.cleanCellText('меш.', 20, { minConf: 45 })).toBe('');
  });
  it('drops pure punctuation/noise', () => {
    expect(oc.cleanCellText('—', 90)).toBe('');
    expect(oc.cleanCellText('EEE', 90)).toBe('EEE'); // has letters → kept
  });
  it('collapses whitespace and keeps good text', () => {
    expect(oc.cleanCellText('2 047,21', 80)).toBe('2 047,21');
    expect(oc.cleanCellText('  a\n b ', 80)).toBe('a b');
  });
});

describe('normalizeNumeric', () => {
  it('strips leading junk from a numeric cell', () => {
    expect(oc.normalizeNumeric('© 961,21')).toBe('961,21');
  });
  it('fixes O/l confusions in numeric context', () => {
    expect(oc.normalizeNumeric('1O,l55')).toBe('10,155');
  });
  it('normalises dot decimal separator to comma', () => {
    expect(oc.normalizeNumeric('961.21')).toBe('961,21');
  });
  it('leaves non-numeric text alone', () => {
    expect(oc.normalizeNumeric('Полотенца бумажные')).toBe('Полотенца бумажные');
  });
});

describe('isLikelyNumericColumn', () => {
  it('detects a numeric column', () => {
    expect(oc.isLikelyNumericColumn(['2 047,21', '450,39', '', '124,399'])).toBe(true);
  });
  it('rejects a text column', () => {
    expect(oc.isLikelyNumericColumn(['наименование', 'структура', 'код'])).toBe(false);
  });
});
