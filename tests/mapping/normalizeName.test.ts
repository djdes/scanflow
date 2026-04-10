import { describe, it, expect } from 'vitest';
import { normalizeName } from '../../src/mapping/nomenclatureMapper';

describe('normalizeName', () => {
  it('removes parenthesized content', () => {
    expect(normalizeName('Томат (помидоры)')).toBe('Томат');
    expect(normalizeName('Капуста морская(3кг)')).toBe('Капуста морская');
    expect(normalizeName('Мука (50кг)')).toBe('Мука');
  });

  it('removes inline weight patterns', () => {
    expect(normalizeName('Мука 50кг')).toBe('Мука');
    expect(normalizeName('Батон Нарезной 0,4 кг')).toBe('Батон Нарезной');
    expect(normalizeName('Кальмар 5кг')).toBe('Кальмар');
  });

  it('removes count patterns', () => {
    expect(normalizeName('Яйцо Куриное 360шт')).toBe('Яйцо Куриное');
  });

  it('removes volume patterns', () => {
    expect(normalizeName('Вода питьевая 500 мл')).toBe('Вода питьевая');
    expect(normalizeName('Сок апельсиновый 1л')).toBe('Сок апельсиновый');
  });

  it('collapses whitespace', () => {
    expect(normalizeName('Картофель    сырой')).toBe('Картофель сырой');
    expect(normalizeName('  Морковь  ')).toBe('Морковь');
  });

  it('handles empty input', () => {
    expect(normalizeName('')).toBe('');
  });

  it('preserves core product name', () => {
    // After stripping all weight/volume, the main identifier survives
    expect(normalizeName('Картофель сырой')).toBe('Картофель сырой');
    expect(normalizeName('Лук репчатый')).toBe('Лук репчатый');
  });
});
