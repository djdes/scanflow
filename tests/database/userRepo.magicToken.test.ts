import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { userRepo } from '../../src/database/repositories/userRepo';

describe.runIf((process.env.DB_NAME || '').includes('test'))('magic-token lifecycle', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  async function createUser(): Promise<number> {
    const result = await getDb().prepare(
      `INSERT INTO users (username, password_hash, api_key, role, notify_events)
       VALUES ('magic_user', 'x', 'magic_key', 'user', '[]')`
    ).run();
    return Number(result.lastInsertRowid);
  }

  it('consumes a valid token exactly once and records the login', async () => {
    const id = await createUser();
    const token = '0123456789abcdef0123456789abcdef';
    await userRepo.setMagicToken(id, token, new Date(Date.now() + 60_000));

    expect((await userRepo.consumeMagicToken(token))?.id).toBe(id);
    expect(await userRepo.consumeMagicToken(token)).toBeUndefined();

    const row = await getDb().prepare(
      'SELECT magic_token, magic_token_expires_at, last_login_at FROM users WHERE id = ?'
    ).get<{ magic_token: string | null; magic_token_expires_at: string | null; last_login_at: string | null }>(id);
    expect(row?.magic_token).toBeNull();
    expect(row?.magic_token_expires_at).toBeNull();
    expect(row?.last_login_at).not.toBeNull();
  });

  it('rejects an expired token without consuming a different value', async () => {
    const id = await createUser();
    const token = 'fedcba9876543210fedcba9876543210';
    await userRepo.setMagicToken(id, token, new Date(Date.now() - 60_000));

    expect(await userRepo.consumeMagicToken(token)).toBeUndefined();
    const row = await getDb().prepare('SELECT magic_token FROM users WHERE id = ?')
      .get<{ magic_token: string | null }>(id);
    expect(row?.magic_token).toBe(token);
  });
});
