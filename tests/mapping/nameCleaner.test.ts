import { describe, it, expect } from 'vitest';
import { cleanItemName } from '../../src/mapping/nameCleaner';

describe('cleanItemName', () => {
  it('strips trailing weight range + caliber code', () => {
    expect(cleanItemName('Ветчина с бедром индейки вареная 3-4кг d120'))
      .toBe('Ветчина с бедром индейки вареная');
  });

  it('strips caliber with Cyrillic д and a space', () => {
    expect(cleanItemName('Колбаса д 80')).toBe('Колбаса');
    expect(cleanItemName('Колбаса д80')).toBe('Колбаса');
  });

  it('strips mid-name weight and trailing packaging word', () => {
    expect(cleanItemName('Сельдь филе Классическая в масле 3 кг ведро'))
      .toBe('Сельдь филе Классическая в масле');
  });

  it('strips trailing packaging word but preserves percent (fat content)', () => {
    expect(cleanItemName('Молоко 3,2% пакет')).toBe('Молоко 3,2%');
    expect(cleanItemName('Сметана 20%')).toBe('Сметана 20%');
  });

  it('strips weight/volume/count units', () => {
    expect(cleanItemName('Мука 50кг')).toBe('Мука');
    expect(cleanItemName('Вода питьевая 500 мл')).toBe('Вода питьевая');
    expect(cleanItemName('Яйцо Куриное 10шт')).toBe('Яйцо Куриное');
  });

  it('is idempotent', () => {
    const once = cleanItemName('Ветчина вареная 3-4кг d120');
    expect(cleanItemName(once)).toBe(once);
  });

  it('falls back to raw when cleaning would empty the name', () => {
    expect(cleanItemName('3 кг')).toBe('3 кг');
    expect(cleanItemName('')).toBe('');
  });

  it('leaves a clean name untouched', () => {
    expect(cleanItemName('Лук репчатый')).toBe('Лук репчатый');
  });

  it('strips parenthesised packaging — brackets must not enter the 1C name', () => {
    expect(cleanItemName('Лист винограда (ведро)')).toBe('Лист винограда');
  });

  it('strips a mid-name parenthetical group', () => {
    expect(cleanItemName('Сыр (вес) Российский')).toBe('Сыр Российский');
  });

  it('parens cleanup stays idempotent', () => {
    const once = cleanItemName('Лист винограда (ведро)');
    expect(cleanItemName(once)).toBe(once);
  });

  it('falls back to raw when the only content is in parens', () => {
    expect(cleanItemName('(ведро)')).toBe('(ведро)');
  });
});
