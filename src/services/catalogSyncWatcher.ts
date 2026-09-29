import { logger } from '../utils/logger';
import { mappingRepo } from '../database/repositories/mappingRepo';

/**
 * Что делать, когда справочник 1С закончил обновляться.
 *
 * 1С выгружает каталог так: DELETE (очистка) → пачки по 500 позиций. Сервер не
 * знает, какая пачка последняя. До v2 после КАЖДОЙ пачки вызывался
 * removeOrphaned, и сопоставления позиций из следующих пачек удалялись
 * безвозвратно (у второй компании из 11 ручных сопоставлений уцелело одно).
 *
 * Теперь: каждая пачка лишь перезапускает таймер; через паузу считаем, что
 * выгрузка закончилась, и ПОМЕЧАЕМ сопоставления исчезнувших позиций
 * (orphaned_at), а вернувшиеся — снимаем с пометки. Ничего не удаляется.
 * Сюда же подключаются действия «после обновления каталога» (п.13 —
 * пересопоставление неотправленных накладных).
 */
const QUIET_MS = 5 * 60 * 1000;
const timers = new Map<number, NodeJS.Timeout>();
type Hook = (ownerUserId: number) => Promise<void>;
const hooks: Hook[] = [];

export function registerAfterCatalogSync(hook: Hook): void {
  hooks.push(hook);
}

export async function runAfterCatalogSync(ownerUserId: number): Promise<void> {
  try {
    const { marked, restored } = await mappingRepo.markOrphaned(ownerUserId);
    if (marked || restored) logger.info('Catalog sync settled: mappings orphan-marked', { ownerUserId, marked, restored });
  } catch (err) {
    logger.warn('Catalog sync settle: markOrphaned failed', { ownerUserId, error: (err as Error).message });
  }
  for (const hook of hooks) {
    try { await hook(ownerUserId); } catch (err) {
      logger.warn('Catalog sync settle: hook failed', { ownerUserId, error: (err as Error).message });
    }
  }
}

/** Вызывать после каждой пачки каталога; действия выполнятся после паузы QUIET_MS. */
export function onCatalogChanged(ownerUserId: number, quietMs = QUIET_MS): void {
  const prev = timers.get(ownerUserId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    timers.delete(ownerUserId);
    void runAfterCatalogSync(ownerUserId);
  }, quietMs);
  t.unref?.();
  timers.set(ownerUserId, t);
}
