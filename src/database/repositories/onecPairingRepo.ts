import { randomBytes } from 'crypto';
import { getDb } from '../db';

// Короткий человеко-вводимый код: 8 символов из однозначного алфавита
// (без 0/O/1/I), формат 1C-XXXX-XXXX.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_TTL_MINUTES = 15;

function generatePairingCode(): string {
  const buf = randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
  return `1C-${s.slice(0, 4)}-${s.slice(4, 8)}`;
}

export const onecPairingRepo = {
  async create(ownerUserId: number, baseName: string): Promise<{ code: string; expiresAt: string }> {
    const db = getDb();
    // Инвалидируем прошлые неиспользованные коды этого пользователя.
    await db.prepare(
      `UPDATE onec_pairing_codes SET used_at = NOW() WHERE owner_user_id = ? AND used_at IS NULL`
    ).run(ownerUserId);

    // Генерим уникальный код (несколько попыток на случай коллизии).
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generatePairingCode();
      try {
        await db.prepare(
          `INSERT INTO onec_pairing_codes (code, owner_user_id, base_name, expires_at)
           VALUES (?, ?, ?, (NOW() + INTERVAL ${CODE_TTL_MINUTES} MINUTE))`
        ).run(code, ownerUserId, (baseName || '').trim().slice(0, 128));
        const row = await db.prepare(
          `SELECT expires_at FROM onec_pairing_codes WHERE code = ?`
        ).get<{ expires_at: string }>(code);
        return { code, expiresAt: String(row?.expires_at) };
      } catch (e) {
        if (attempt === 4) throw e; // исчерпали попытки — пробрасываем
      }
    }
    throw new Error('failed to generate a unique pairing code');
  },

  async redeem(code: string): Promise<{ ownerUserId: number; baseName: string } | null> {
    const db = getDb();
    const row = await db.prepare(
      `SELECT id, owner_user_id, base_name FROM onec_pairing_codes
        WHERE code = ? AND used_at IS NULL AND expires_at > NOW()`
    ).get<{ id: number; owner_user_id: number; base_name: string }>(code);
    if (!row) return null;
    const res = await db.prepare(
      `UPDATE onec_pairing_codes SET used_at = NOW() WHERE id = ? AND used_at IS NULL`
    ).run(row.id);
    // Гонка: если кто-то погасил код между SELECT и UPDATE — changes = 0.
    if (Number((res as { changes?: number }).changes ?? 0) === 0) return null;
    return { ownerUserId: row.owner_user_id, baseName: row.base_name };
  },
};
