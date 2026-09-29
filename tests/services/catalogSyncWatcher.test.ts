import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/database/repositories/mappingRepo', () => ({
  mappingRepo: { markOrphaned: vi.fn(async () => ({ marked: 3, restored: 1 })), removeOrphaned: vi.fn() },
}));

import { mappingRepo } from '../../src/database/repositories/mappingRepo';
import { onCatalogChanged, registerAfterCatalogSync } from '../../src/services/catalogSyncWatcher';

describe('catalogSyncWatcher — выгрузка каталога пачками не стирает правила', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
  afterEach(() => { vi.useRealTimers(); });

  it('пачки подряд → одна пометка после паузы, никаких удалений', async () => {
    const hook = vi.fn(async () => {});
    registerAfterCatalogSync(hook);
    onCatalogChanged(7, 1000);   // пачка 1 (500 позиций)
    await vi.advanceTimersByTimeAsync(600);
    onCatalogChanged(7, 1000);   // пачка 2 (223 позиции)
    await vi.advanceTimersByTimeAsync(600);
    expect(mappingRepo.markOrphaned).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(mappingRepo.markOrphaned).toHaveBeenCalledTimes(1);
    expect(mappingRepo.markOrphaned).toHaveBeenCalledWith(7);
    expect(hook).toHaveBeenCalledWith(7);
    expect(mappingRepo.removeOrphaned).not.toHaveBeenCalled();
  });

  it('компании не мешают друг другу', async () => {
    onCatalogChanged(1, 1000);
    onCatalogChanged(3, 1000);
    await vi.advanceTimersByTimeAsync(1100);
    expect(mappingRepo.markOrphaned).toHaveBeenCalledTimes(2);
  });
});
