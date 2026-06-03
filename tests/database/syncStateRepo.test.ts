import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { syncStateRepo } from '../../src/database/repositories/syncStateRepo';

describe.runIf((process.env.DB_NAME || '').includes('test'))('syncStateRepo', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  it('starts unset', async () => {
    const st = await syncStateRepo.getNomenclatureSyncState();
    expect(st.requested).toBe(false);
    expect(st.since).toBeNull();
  });

  it('mark then get returns requested with a since', async () => {
    await syncStateRepo.markNomenclatureSyncRequested();
    const st = await syncStateRepo.getNomenclatureSyncState();
    expect(st.requested).toBe(true);
    expect(typeof st.since).toBe('string');
  });

  it('clear with the observed since clears the flag', async () => {
    await syncStateRepo.markNomenclatureSyncRequested();
    const st = await syncStateRepo.getNomenclatureSyncState();
    const res = await syncStateRepo.clearNomenclatureSync(st.since as string);
    expect(res.cleared).toBe(true);
    expect((await syncStateRepo.getNomenclatureSyncState()).requested).toBe(false);
  });

  it('clear with an older since does NOT clear a newer flag (race guard)', async () => {
    const older = '2000-01-01 00:00:00';
    await syncStateRepo.markNomenclatureSyncRequested();
    const res = await syncStateRepo.clearNomenclatureSync(older);
    expect(res.cleared).toBe(false);
    expect((await syncStateRepo.getNomenclatureSyncState()).requested).toBe(true);
  });
});
