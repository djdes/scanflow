import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { syncStateRepo } from '../../src/database/repositories/syncStateRepo';

// Флаг пер-тенантный (миграция 54), поэтому у каждого вызова есть владелец.
// Изоляцию между компаниями проверяет syncState.tenant.test.ts — здесь только
// механика одной компании.
const OWNER = 1;

describe.runIf((process.env.DB_NAME || '').includes('test'))('syncStateRepo', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  it('starts unset', async () => {
    const st = await syncStateRepo.getNomenclatureSyncState(OWNER);
    expect(st.requested).toBe(false);
    expect(st.since).toBeNull();
  });

  it('mark then get returns requested with a since', async () => {
    await syncStateRepo.markNomenclatureSyncRequested(OWNER);
    const st = await syncStateRepo.getNomenclatureSyncState(OWNER);
    expect(st.requested).toBe(true);
    expect(typeof st.since).toBe('string');
  });

  it('clear with the observed since clears the flag', async () => {
    await syncStateRepo.markNomenclatureSyncRequested(OWNER);
    const st = await syncStateRepo.getNomenclatureSyncState(OWNER);
    const res = await syncStateRepo.clearNomenclatureSync(st.since as string, OWNER);
    expect(res.cleared).toBe(true);
    expect((await syncStateRepo.getNomenclatureSyncState(OWNER)).requested).toBe(false);
  });

  it('clear with an older since does NOT clear a newer flag (race guard)', async () => {
    const older = '2000-01-01 00:00:00';
    await syncStateRepo.markNomenclatureSyncRequested(OWNER);
    const res = await syncStateRepo.clearNomenclatureSync(older, OWNER);
    expect(res.cleared).toBe(false);
    expect((await syncStateRepo.getNomenclatureSyncState(OWNER)).requested).toBe(true);
  });
});
