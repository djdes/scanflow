import { describe, it, expect } from 'vitest';
import {
  ATTR_COLUMNS,
  ATTR_KEYS,
  ATTR_LABELS,
  ATTR_FIELD_TO_KEY,
  isAttrKey,
  uncheckedAttrs,
  type Invoice,
} from '../../src/database/repositories/invoiceRepo';

// Чистые хелперы чек-листа «сверено с фото». Без БД — поэтому выполняются и
// локально, и в CI (DB-backed тесты там пропускаются).
// См. docs/superpowers/specs/2026-08-03-attribute-verification-before-sber-design.md

function invoiceWith(checked: Partial<Record<string, number>>): Invoice {
  return {
    attr_checked_number: 0,
    attr_checked_date: 0,
    attr_checked_supplier: 0,
    attr_checked_total: 0,
    attr_checked_vat: 0,
    attr_checked_vat_rate: 0,
    ...checked,
  } as unknown as Invoice;
}

const ALL_CHECKED = {
  attr_checked_number: 1, attr_checked_date: 1, attr_checked_supplier: 1,
  attr_checked_total: 1, attr_checked_vat: 1, attr_checked_vat_rate: 1,
};

describe('чек-лист сверенных реквизитов', () => {
  it('покрывает ровно шесть согласованных атрибутов', () => {
    expect(ATTR_KEYS).toEqual(['number', 'date', 'supplier', 'total', 'vat', 'vat_rate']);
  });

  it('ставка НДС — отдельный пункт от суммы НДС', () => {
    // Сумма НДС может сойтись с документом при неверной ставке, поэтому одна
    // отметка на двоих скрыла бы реальную ошибку.
    expect(ATTR_COLUMNS.vat).not.toBe(ATTR_COLUMNS.vat_rate);
    const sumOnly = invoiceWith({ ...ALL_CHECKED, attr_checked_vat_rate: 0 });
    expect(uncheckedAttrs(sumOnly)).toEqual(['vat_rate']);
  });

  it('у каждого ключа есть колонка и подпись', () => {
    for (const k of ATTR_KEYS) {
      expect(ATTR_COLUMNS[k]).toBe(`attr_checked_${k}`);
      expect(ATTR_LABELS[k]).toBeTruthy();
    }
  });

  describe('isAttrKey — белый список для имени колонки', () => {
    it('пропускает валидные ключи', () => {
      for (const k of ATTR_KEYS) expect(isAttrKey(k)).toBe(true);
    });

    it('отсекает всё остальное, включая попытки инъекции', () => {
      // Ключ приходит с фронта и подставляется в имя колонки — сюда не должно
      // просачиваться ничего, кроме пяти известных значений (правило 18).
      for (const bad of [
        'all', 'attr_checked_total', 'total; DROP TABLE invoices', 'total OR 1=1',
        '', null, undefined, 42, {}, ['total'],
      ]) {
        expect(isAttrKey(bad)).toBe(false);
      }
    });

    it('не путает унаследованные свойства объекта с ключами', () => {
      // hasOwnProperty, а не `in`: иначе 'toString'/'constructor' прошли бы.
      expect(isAttrKey('toString')).toBe(false);
      expect(isAttrKey('constructor')).toBe(false);
    });
  });

  describe('uncheckedAttrs — что мешает отправить платёж', () => {
    it('на пустом чек-листе возвращает все пять', () => {
      expect(uncheckedAttrs(invoiceWith({}))).toEqual(ATTR_KEYS);
    });

    it('на полном — пусто, значит платить можно', () => {
      expect(uncheckedAttrs(invoiceWith(ALL_CHECKED))).toEqual([]);
    });

    it('одной непроставленной галочки достаточно, чтобы запретить', () => {
      const almost = invoiceWith({ ...ALL_CHECKED, attr_checked_vat: 0 });
      expect(uncheckedAttrs(almost)).toEqual(['vat']);
    });

    it('сохраняет порядок полей — текст ошибки читается как шапка накладной', () => {
      const partial = invoiceWith({ attr_checked_supplier: 1 });
      expect(uncheckedAttrs(partial)).toEqual(['number', 'date', 'total', 'vat', 'vat_rate']);
    });
  });

  describe('ATTR_FIELD_TO_KEY — сброс отметки при правке поля', () => {
    it('связывает каждое поле шапки со своей галочкой', () => {
      expect(ATTR_FIELD_TO_KEY.invoice_number).toBe('number');
      expect(ATTR_FIELD_TO_KEY.invoice_date).toBe('date');
      expect(ATTR_FIELD_TO_KEY.supplier).toBe('supplier');
      expect(ATTR_FIELD_TO_KEY.total_sum).toBe('total');
      expect(ATTR_FIELD_TO_KEY.vat_sum).toBe('vat');
    });

    it('поля вне набора чек-лист не трогают', () => {
      // Правка ИНН/счёта/КПП не должна сбрасывать сверку номера или суммы.
      for (const f of ['supplier_inn', 'supplier_kpp', 'supplier_account', 'invoice_type', 'status']) {
        expect(ATTR_FIELD_TO_KEY[f]).toBeUndefined();
      }
    });

    it('ставка НДС не привязана к полю шапки — она живёт в позициях', () => {
      // Поэтому её отметку сбрасывает только перераспознавание, а не PATCH.
      expect(Object.values(ATTR_FIELD_TO_KEY)).not.toContain('vat_rate');
      expect(Object.keys(ATTR_FIELD_TO_KEY)).toHaveLength(ATTR_KEYS.length - 1);
    });
  });
});
