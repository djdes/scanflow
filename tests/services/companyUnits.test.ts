import { describe, it, expect, vi, beforeEach } from 'vitest';

const flags = { all_kg: true };
vi.mock('../../src/services/engineFlags', () => ({ getEngineFlags: vi.fn(async () => ({ ...flags })) }));
const rows = new Map<number, number>();
const run = vi.fn(async (on: number, id: number) => { rows.set(id, on); });
const get = vi.fn(async (id: number) => (rows.has(id) ? { units_all_kg: rows.get(id) } : undefined));
vi.mock('../../src/database/db', () => ({
  getDb: () => ({ prepare: (sql: string) => (sql.startsWith('UPDATE') ? { run } : { get }) }),
}));

import { companyAllKg, getCompanyAllKgSetting, setCompanyAllKg, invalidateCompanyUnits } from '../../src/services/companyUnits';

describe('companyAllKg — «всё в кг» как настройка компании', () => {
  beforeEach(() => { rows.clear(); flags.all_kg = true; invalidateCompanyUnits(); vi.clearAllMocks(); });

  it('по умолчанию компания считает в единицах своей 1С', async () => {
    rows.set(3, 0);
    expect(await companyAllKg(3)).toBe(false);
    expect(await companyAllKg(99)).toBe(false); // нет строки — тоже единицы 1С
    expect(await companyAllKg(null)).toBe(false);
  });

  it('компания включила — кг; общий выключатель сильнее настройки', async () => {
    rows.set(1, 1);
    expect(await companyAllKg(1)).toBe(true);
    flags.all_kg = false;
    expect(await companyAllKg(1)).toBe(false);
    expect(await getCompanyAllKgSetting(1)).toBe(true); // сама настройка не стёрта
  });

  it('смена настройки видна сразу, без ожидания кэша', async () => {
    rows.set(3, 0);
    expect(await companyAllKg(3)).toBe(false);
    await setCompanyAllKg(3, true);
    expect(run).toHaveBeenCalledWith(1, 3);
    expect(await companyAllKg(3)).toBe(true);
  });
});
