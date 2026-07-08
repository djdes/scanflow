import { describe, it, expect } from 'vitest';
import { isValidInn } from '../../src/utils/inn';

describe('isValidInn', () => {
  it('accepts a valid 10-digit ИНН', () => {
    expect(isValidInn('7830002293')).toBe(true);
  });

  it('accepts a valid 12-digit ИНН', () => {
    expect(isValidInn('500100732259')).toBe(true);
  });

  it('rejects a 10-digit number with a wrong control digit', () => {
    expect(isValidInn('7830002290')).toBe(false);
  });

  it('rejects a 12-digit number with a wrong control digit', () => {
    expect(isValidInn('500100732250')).toBe(false);
  });

  it('rejects wrong lengths', () => {
    expect(isValidInn('123')).toBe(false);
    expect(isValidInn('12345678901')).toBe(false); // 11 digits
  });

  it('rejects non-digit / empty input', () => {
    expect(isValidInn('')).toBe(false);
    expect(isValidInn(null)).toBe(false);
    expect(isValidInn(undefined)).toBe(false);
    expect(isValidInn('78300O2293')).toBe(false); // letter O
  });
});
