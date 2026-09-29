import { getDb } from '../database/db';
import { logger } from '../utils/logger';

/**
 * Переключатели движков пакета v2 (единицы, сопоставление, самообучение).
 *
 * Выключенный флаг = прежнее поведение кода: старые функции сохранены и
 * вызываются как раньше. Это главный рычаг отката без деплоя — админ
 * выключает движок в «Настройки → Движки v2», и следующая накладная идёт
 * старым путём. Хранится в analyzer_config.engine_flags (JSON в TEXT).
 */
export type EngineFlag = 'units_v2' | 'price_guard' | 'mapping_v2' | 'ocr_memory' | 'batch_notify' | 'learning';

export const ENGINE_FLAGS: EngineFlag[] = ['units_v2', 'price_guard', 'mapping_v2', 'ocr_memory', 'batch_notify', 'learning'];

export const ENGINE_FLAG_DEFAULTS: Record<EngineFlag, boolean> = {
  units_v2: true,
  price_guard: true,
  mapping_v2: true,
  ocr_memory: true,
  batch_notify: true,
  learning: true,
};

export const ENGINE_FLAG_INFO: Record<EngineFlag, { title: string; hint: string }> = {
  units_v2: {
    title: 'Пересчёт единиц v2',
    hint: 'Количество в единицах 1С считается от значений «как в накладной»: вес из названия, упаковки «240г×24», «100шт/упак», правила поставщика. Выключено — прежний пересчёт.',
  },
  price_guard: {
    title: 'Проверка цены за единицу',
    hint: 'Строка, цена которой отличается от обычной в 3 раза и больше, помечается красным и не уходит автопилотом.',
  },
  mapping_v2: {
    title: 'Сопоставление v2',
    hint: 'Подтверждённые правила важнее выбора ИИ, «не это» запоминается, размеры/объёмы/жирность должны совпадать.',
  },
  ocr_memory: {
    title: 'Памятка поставщиков для распознавания',
    hint: 'В запрос к Claude добавляются выученные особенности поставщиков (единицы, упаковки).',
  },
  batch_notify: {
    title: 'Сводка при пакетной загрузке',
    hint: 'При загрузке пачки фото уведомления приходят одной сводкой, а не десятками сообщений.',
  },
  learning: {
    title: 'Ночной разбор правок',
    hint: 'Раз в сутки правки и аномалии разбираются и превращаются в предложения правил (применяются только после вашего подтверждения).',
  },
};

export type EngineFlags = Record<EngineFlag, boolean>;

/** Разбор сохранённого JSON: неизвестные ключи и не-boolean значения игнорируются. */
export function parseEngineFlags(raw: string | null | undefined): EngineFlags {
  const out: EngineFlags = { ...ENGINE_FLAG_DEFAULTS };
  if (!raw) return out;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return out; }
  if (!parsed || typeof parsed !== 'object') return out;
  for (const k of ENGINE_FLAGS) {
    const v = (parsed as Record<string, unknown>)[k];
    if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

const CACHE_MS = 30_000;
let cache: { at: number; flags: EngineFlags } | null = null;

export function invalidateEngineFlags(): void {
  cache = null;
}

export async function getEngineFlags(): Promise<EngineFlags> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.flags;
  let flags: EngineFlags;
  try {
    const row = await getDb()
      .prepare('SELECT engine_flags FROM analyzer_config WHERE id = 1')
      .get<{ engine_flags: string | null }>();
    flags = parseEngineFlags(row?.engine_flags ?? null);
  } catch (err) {
    // До миграции 62 колонки нет — работаем с дефолтами, а не падаем.
    logger.debug('engineFlags: read failed, using defaults', { error: (err as Error).message });
    flags = { ...ENGINE_FLAG_DEFAULTS };
  }
  cache = { at: Date.now(), flags };
  return flags;
}

export async function isEngineOn(flag: EngineFlag): Promise<boolean> {
  return (await getEngineFlags())[flag];
}

/** Сохранить изменения (только известные ключи, только boolean). Возвращает итог. */
export async function setEngineFlags(patch: Partial<Record<string, unknown>>): Promise<EngineFlags> {
  invalidateEngineFlags();
  const next = { ...(await getEngineFlags()) };
  for (const k of ENGINE_FLAGS) {
    const v = patch[k];
    if (typeof v === 'boolean') next[k] = v;
  }
  await getDb()
    .prepare('UPDATE analyzer_config SET engine_flags = ? WHERE id = 1')
    .run(JSON.stringify(next));
  invalidateEngineFlags();
  return next;
}
