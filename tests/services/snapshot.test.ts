import { describe, it, expect } from 'vitest';
import { headerRestorePatch } from '../../src/database/repositories/snapshotRepo';

describe('headerRestorePatch — что вернуть из снимка', () => {
  const snap = { invoice_number: '17-0577995', invoice_date: '2026-09-23', total_sum: 100988.71, vat_sum: 9432.54 };

  it('возвращает только отличающиеся поля номера/даты/суммы/НДС', () => {
    const cur = { invoice_number: '17-0577995', invoice_date: '2026-09-23', total_sum: 100000, vat_sum: 9432.54 };
    expect(headerRestorePatch(cur, snap)).toEqual({ total_sum: 100988.71 });
  });

  it('копеечная разница float не считается изменением', () => {
    const cur = { ...snap, total_sum: 100988.71000000001 };
    expect(headerRestorePatch(cur, snap)).toEqual({});
  });

  it('можно ограничить набор полей', () => {
    const cur = { invoice_number: 'X', invoice_date: '2026-01-01', total_sum: 1, vat_sum: 1 };
    expect(headerRestorePatch(cur, snap, ['invoice_number'])).toEqual({ invoice_number: '17-0577995' });
  });

  it('пустое значение в снимке не затирает текущее', () => {
    const cur = { invoice_number: 'A-1', invoice_date: '2026-09-23', total_sum: 5, vat_sum: 1 };
    const empty = { invoice_number: null, invoice_date: null, total_sum: null, vat_sum: null };
    expect(headerRestorePatch(cur, empty)).toEqual({});
  });
});
