import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Шифрование секретов в БД (AES-256-GCM): client_secret Сбера, OAuth-токены ChatGPT.
 * Ключ выводится из JWT_SECRET (он и так обязателен и не хранится в базе), поэтому дамп
 * базы без .env секрет не раскрывает; у каждого вида секретов свой ключ (purpose).
 * Формат: `v1:<base64(iv[12] | tag[16] | ciphertext)>`.
 */
function key(purpose: string): Buffer {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) throw new Error('JWT_SECRET must be set and at least 32 characters');
  return createHash('sha256').update(`${s}:${purpose}`).digest();
}

export function sealSecret(plain: string, purpose = 'sber-app-secret'): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(purpose), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')}`;
}

export function openSecret(sealed: string, purpose = 'sber-app-secret'): string {
  if (!sealed.startsWith('v1:')) throw new Error('unsupported secret format');
  const raw = Buffer.from(sealed.slice(3), 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const decipher = createDecipheriv('aes-256-gcm', key(purpose), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}
