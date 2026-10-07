import { getDb } from '../database/db';
import { logger } from '../utils/logger';
import { getEngineFlags } from './engineFlags';

/**
 * «Всё в кг» — настройка компании (users.units_all_kg, миграция 83), а не всей
 * платформы: у каждой компании своя база 1С и свой учёт. Решение 2026-10-07:
 * основная компания ведёт всё в кг, «Я Так Ем» (zakupki) — как в своей 1С (яйца и
 * чизкейки — штуками). Флаг движка all_kg — общий выключатель поверх настройки.
 * Новая компания по умолчанию считает в единицах своей 1С.
 */
const CACHE_MS = 30_000;
const cache = new Map<number, { at: number; on: boolean }>();

export function invalidateCompanyUnits(ownerUserId?: number): void {
  if (ownerUserId == null) cache.clear();
  else cache.delete(ownerUserId);
}

/** Настройка компании как есть (без общего выключателя) — для страницы профиля. */
export async function getCompanyAllKgSetting(ownerUserId: number): Promise<boolean> {
  const hit = cache.get(ownerUserId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.on;
  let on = false;
  try {
    const row = await getDb()
      .prepare('SELECT units_all_kg FROM users WHERE id = ?')
      .get<{ units_all_kg: number | null }>(ownerUserId);
    on = Number(row?.units_all_kg ?? 0) === 1;
  } catch (err) {
    // До миграции 83 колонки нет — считаем в единицах 1С, а не падаем.
    logger.debug('companyUnits: read failed, using 1C units', { error: (err as Error).message });
  }
  cache.set(ownerUserId, { at: Date.now(), on });
  return on;
}

/** Считать строки компании «всё в кг»: общий флаг all_kg включён и компания выбрала кг. */
export async function companyAllKg(ownerUserId: number | null | undefined): Promise<boolean> {
  if (ownerUserId == null) return false;
  if (!(await getEngineFlags()).all_kg) return false;
  return getCompanyAllKgSetting(ownerUserId);
}

export async function setCompanyAllKg(ownerUserId: number, on: boolean): Promise<void> {
  await getDb().prepare('UPDATE users SET units_all_kg = ? WHERE id = ?').run(on ? 1 : 0, ownerUserId);
  invalidateCompanyUnits(ownerUserId);
}
