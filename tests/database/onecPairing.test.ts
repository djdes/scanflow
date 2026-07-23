import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { onecPairingRepo } from '../../src/database/repositories/onecPairingRepo';

describe.runIf((process.env.DB_NAME || '').includes('test'))('onecPairingRepo', () => {
  let owner = 0;
  beforeEach(async () => {
    await resetDb();
    const r = await getDb().prepare(
      `INSERT INTO users (username, password_hash, api_key, role, notify_events) VALUES ('o','x','k-o','user','[]')`
    ).run();
    owner = Number(r.lastInsertRowid);
  });
  afterAll(async () => { await closeTestDb(); });

  it('create returns a short code and redeem yields the owner once', async () => {
    const { code } = await onecPairingRepo.create(owner, 'База клиента');
    expect(code).toMatch(/^1C-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    const first = await onecPairingRepo.redeem(code);
    expect(first).toEqual({ ownerUserId: owner, baseName: 'База клиента' });

    // second redeem of the same code fails (one-time)
    expect(await onecPairingRepo.redeem(code)).toBeNull();
  });

  it('redeem returns null for unknown or expired codes', async () => {
    expect(await onecPairingRepo.redeem('1C-XXXX-YYYY')).toBeNull();

    const { code } = await onecPairingRepo.create(owner, 'X');
    await getDb().prepare(
      `UPDATE onec_pairing_codes SET expires_at = (NOW() - INTERVAL 1 MINUTE) WHERE code = ?`
    ).run(code);
    expect(await onecPairingRepo.redeem(code)).toBeNull();
  });

  it('creating a new code invalidates the previous unused code for that user', async () => {
    const a = await onecPairingRepo.create(owner, 'A');
    await onecPairingRepo.create(owner, 'B');
    expect(await onecPairingRepo.redeem(a.code)).toBeNull();
  });
});
