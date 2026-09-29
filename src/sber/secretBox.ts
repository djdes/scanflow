import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Шифрование секретов Сбера в БД (AES-256-GCM). Ключ выводится из JWT_SECRET
 * (он и так обязателен и не хранится в базе), поэтому дамп базы без .env
 * секрет не раскрывает. Формат: `v1:<base64(iv[12] | tag[16] | ciphertext)>`.
 */
function key(): Buffer {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) throw new Error('JWT_SECRET must be set and at least 32 characters');
  return createHash('sha256').update(`${s}:sber-app-secret`).digest();
}

export function sealSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')}`;
}

export function openSecret(sealed: string): string {
  if (!sealed.startsWith('v1:')) throw new Error('unsupported secret format');
  const raw = Buffer.from(sealed.slice(3), 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}
