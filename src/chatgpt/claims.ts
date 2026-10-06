import type { ChatgptAccount } from '../database/repositories/chatgptConnectionRepo';

/**
 * Поля аккаунта из JWT-токенов ChatGPT (подпись не проверяем: токены получены напрямую у
 * auth.openai.com по TLS и нужны только для чтения). Бэкенд Codex требует account id
 * отдельным заголовком chatgpt-account-id — без него отвечает 401.
 */
const AUTH_CLAIM = 'https://api.openai.com/auth';
const PROFILE_CLAIM = 'https://api.openai.com/profile';

export function readJwtClaims(token: string | null | undefined): Record<string, unknown> | null {
  if (!token) return null;
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const obj = (claims: Record<string, unknown> | null, key: string): Record<string, unknown> | null => {
  const v = claims?.[key];
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
};

/** Account id, email, тариф и срок access-токена — из access- и id-токена. */
export function accountFromTokens(accessToken: string, idToken: string | null): ChatgptAccount {
  const access = readJwtClaims(accessToken);
  const id = readJwtClaims(idToken);
  const accessAuth = obj(access, AUTH_CLAIM);
  const idAuth = obj(id, AUTH_CLAIM);
  const profile = obj(access, PROFILE_CLAIM);
  const exp = access?.exp;
  return {
    accountId: str(accessAuth?.chatgpt_account_id) ?? str(idAuth?.chatgpt_account_id),
    email: str(id?.email) ?? str(profile?.email) ?? str(access?.email),
    planType: str(idAuth?.chatgpt_plan_type) ?? str(accessAuth?.chatgpt_plan_type),
    accessExpiresMs: typeof exp === 'number' ? exp * 1000 : null,
  };
}
