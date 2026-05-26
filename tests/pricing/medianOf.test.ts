import { describe, it, expect } from 'vitest';
import { medianOf } from '../../src/pricing/medianOf';

describe('medianOf', () => {
  it('returns null for empty array', () => {
    expect(medianOf([])).toBeNull();
  });

  it('returns the single value for length 1', () => {
    expect(medianOf([42])).toBe(42);
  });

  it('returns middle value for odd-length sorted input', () => {
    // sorted: [1, 3, 5] → median = 3
    expect(medianOf([1, 5, 3])).toBe(3);
  });

  it('returns average of two middle values for even length', () => {
    // sorted: [1, 2, 3, 4] → median = (2+3)/2 = 2.5
    expect(medianOf([4, 1, 3, 2])).toBe(2.5);
  });

  it('handles decimal prices', () => {
    expect(medianOf([10.5, 20.0, 15.25])).toBe(15.25);
  });

  it('does not mutate input', () => {
    const input = [3, 1, 2];
    medianOf(input);
    expect(input).toEqual([3, 1, 2]);
  });
});
