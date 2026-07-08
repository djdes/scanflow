import { describe, it, expect } from 'vitest';
import { parseNumber } from '../../src/parser/invoiceParser';

describe('parseNumber', () => {
  it('parses plain integers and decimals', () => {
    expect(parseNumber('123')).toBe(123);
    expect(parseNumber('1234.5')).toBe(1234.5);
    expect(parseNumber('1234,5')).toBe(1234.5);
  });

  it('handles space thousands separators (Russian format)', () => {
    expect(parseNumber('1 234,56')).toBe(1234.56);
    expect(parseNumber('12 345 678,90')).toBe(12345678.9);
  });

  it('handles multiple separators — last one is decimal', () => {
    expect(parseNumber('1,234,56')).toBe(1234.56);
    expect(parseNumber('1.234,56')).toBe(1234.56);
    expect(parseNumber('1.234.567,89')).toBe(1234567.89);
    expect(parseNumber('1,234,567.89')).toBe(1234567.89);
  });

  it('keeps a lone dot as decimal (no regression for "1.234")', () => {
    expect(parseNumber('1.234')).toBe(1.234);
  });

  it('returns undefined for empty / non-numeric', () => {
    expect(parseNumber('')).toBeUndefined();
    expect(parseNumber('abc')).toBeUndefined();
  });
});
