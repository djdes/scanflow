import { describe, it, expect } from 'vitest';
import { isValidInn } from '../../src/utils/inn';

describe('isValidInn — контрольная сумма ИНН', () => {
  it('10-значные настоящие ИНН проходят', () => {
    expect(isValidInn('5258068806')).toBe(true);
    expect(isValidInn('5258005002')).toBe(true);
    expect(isValidInn('7724357632')).toBe(true); // «Вкусный мир ТК» — верная карточка
  });

  it('10-значные с перепутанной цифрой — не проходят', () => {
    expect(isValidInn('5258006806')).toBe(false);
    expect(isValidInn('7724357832')).toBe(false); // OCR: 6 → 8, карточка-двойник
  });

  it('12-значные (ИП): проверяются обе контрольные цифры', () => {
    expect(isValidInn('940504779259')).toBe(true);
    expect(isValidInn('610807803859')).toBe(true);
    expect(isValidInn('940504779258')).toBe(false); // сломана вторая контрольная
    expect(isValidInn('940504779269')).toBe(false); // сломана первая контрольная
  });

  it('неверная длина, буквы и пустые значения — false', () => {
    expect(isValidInn('772435763')).toBe(false);
    expect(isValidInn('77243576321')).toBe(false);
    expect(isValidInn('77243576З2')).toBe(false); // кириллическая «З» вместо 3
    expect(isValidInn('')).toBe(false);
    expect(isValidInn(null)).toBe(false);
    expect(isValidInn(undefined)).toBe(false);
  });

  it('пробелы по краям не мешают', () => {
    expect(isValidInn(' 7724357632 ')).toBe(true);
  });
});
