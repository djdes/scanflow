import { chatgptConnectionRepo, type ChatgptConnection } from '../database/repositories/chatgptConnectionRepo';
import { chatgptDeviceLoginRepo, type ChatgptDeviceLogin } from '../database/repositories/chatgptDeviceLoginRepo';
import { logger } from '../utils/logger';
import { codexRespond } from './codexClient';
import { DEVICE_CODE_TTL_SEC, pollDeviceCode, requestDeviceCode } from './deviceAuth';

/**
 * Подключение своей подписки ChatGPT по коду и управление им (только админ, платформенный
 * конфиг — как настройки анализатора). Токены наружу не уходят: админка видит аккаунт,
 * тариф, сроки и ошибки.
 */

export type PollChatgptLoginResult =
  | { status: 'idle' }
  | { status: 'pending'; login: ChatgptDeviceLogin }
  | { status: 'expired' }
  | { status: 'connected'; connection: ChatgptConnection | null };

export async function chatgptStatus(): Promise<{ connection: ChatgptConnection | null; pendingLogin: ChatgptDeviceLogin | null }> {
  const [connection, login] = await Promise.all([chatgptConnectionRepo.get(), chatgptDeviceLoginRepo.get()]);
  return { connection, pendingLogin: login && login.expiresMs > Date.now() ? login : null };
}

export async function startChatgptLogin(actorUserId: number | null): Promise<ChatgptDeviceLogin> {
  const code = await requestDeviceCode();
  const login: ChatgptDeviceLogin = {
    userCode: code.userCode,
    deviceAuthId: code.deviceAuthId,
    verificationUrl: code.verificationUrl,
    intervalSec: code.intervalSec,
    expiresMs: Date.now() + DEVICE_CODE_TTL_SEC * 1000,
    createdBy: actorUserId,
  };
  await chatgptDeviceLoginRepo.replace(login);
  return login;
}

/**
 * Один шаг проверки подтверждения. Клиент зовёт его с интервалом, который назвал OpenAI,
 * поэтому ни один HTTP-запрос не висит минутами.
 */
export async function pollChatgptLogin(): Promise<PollChatgptLoginResult> {
  const login = await chatgptDeviceLoginRepo.get();
  if (!login) return { status: 'idle' };
  if (login.expiresMs <= Date.now()) {
    await chatgptDeviceLoginRepo.delete();
    return { status: 'expired' };
  }
  const result = await pollDeviceCode({ deviceAuthId: login.deviceAuthId, userCode: login.userCode });
  if (result.status === 'pending') return { status: 'pending', login };

  await chatgptConnectionRepo.replace({
    credentials: result.credentials,
    account: result.account,
    createdBy: login.createdBy,
    nowMs: Date.now(),
  });
  await chatgptDeviceLoginRepo.delete();
  logger.info('ChatGPT connected', { email: result.account.email, plan: result.account.planType });
  return { status: 'connected', connection: await chatgptConnectionRepo.get() };
}

export async function cancelChatgptLogin(): Promise<void> {
  await chatgptDeviceLoginRepo.delete();
}

/** Забыть подключение: токены удаляются из БД (на стороне OpenAI сессия истечёт сама). */
export async function disconnectChatgpt(): Promise<void> {
  await chatgptDeviceLoginRepo.delete();
  await chatgptConnectionRepo.delete();
  logger.info('ChatGPT disconnected');
}

const TEST_TIMEOUT_MS = 60_000;

/**
 * Короткий настоящий запрос к модели: проверяет токены, выход сервера к chatgpt.com и лимиты.
 * Ошибку возвращает текстом — её показывает админка.
 */
export async function testChatgpt(model: string): Promise<{ ok: boolean; model: string; latencyMs: number; reply: string | null; error: string | null }> {
  const startedAt = Date.now();
  try {
    const response = await codexRespond({
      model,
      instructions: 'Ты проверяешь связь. Ответь ровно одним словом: готово',
      content: [{ type: 'input_text', text: 'Проверка связи' }],
      effort: 'low',
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      label: 'ChatGPT test',
    });
    return { ok: true, model: response.model ?? model, latencyMs: Date.now() - startedAt, reply: response.text.slice(0, 200), error: null };
  } catch (e) {
    return { ok: false, model, latencyMs: Date.now() - startedAt, reply: null, error: (e as Error).message };
  }
}
