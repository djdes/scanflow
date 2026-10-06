import { chatgptConnectionRepo, type ChatgptConnection, type ChatgptCredentials } from '../database/repositories/chatgptConnectionRepo';
import { logger } from '../utils/logger';
import { ChatgptAuthError, refreshTokens } from './deviceAuth';

/** Обновляем токен заранее, если до истечения осталось меньше этого (как делает и codex). */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Подключением сейчас пользоваться нельзя: его нет, нужен повторный вход или исчерпан лимит
 * подписки. status 409 — чтобы withRetry не повторял запрос: от повтора ничего не изменится.
 */
export class ChatgptUnavailableError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = 'ChatgptUnavailableError';
  }
}

export interface ChatgptAccess {
  accessToken: string;
  accountId: string | null;
}

let refreshing: Promise<ChatgptAccess> | null = null;

/**
 * Действующий access-токен подключения. Refresh-токен у OpenAI одноразовый: два одновременных
 * обновления выбили бы сессию целиком. Поэтому внутри процесса обновление одно (общий промис),
 * а в БД — оптимистичная блокировка по version: проигравший перечитывает свежие токены.
 *
 * rejectedAccessToken — токен, на который бэкенд ответил 401: если в БД уже другой, отдаём его,
 * иначе обновляем принудительно, не дожидаясь срока.
 */
export async function acquireChatgptAccess(opts: { rejectedAccessToken?: string } = {}): Promise<ChatgptAccess> {
  const { connection, credentials } = await load();
  if (!needsRefresh(connection, credentials, opts.rejectedAccessToken)) {
    return { accessToken: credentials.accessToken, accountId: connection.accountId };
  }
  if (!refreshing) {
    refreshing = refresh(opts.rejectedAccessToken).finally(() => { refreshing = null; });
  }
  return refreshing;
}

async function refresh(rejectedAccessToken: string | undefined): Promise<ChatgptAccess> {
  // Перечитываем под «замком»: пока ждали, токен мог уже обновиться.
  const { connection, credentials } = await load();
  if (!needsRefresh(connection, credentials, rejectedAccessToken)) {
    return { accessToken: credentials.accessToken, accountId: connection.accountId };
  }
  if (!credentials.refreshToken) {
    await chatgptConnectionRepo.markReauth('нет refresh-токена');
    throw new ChatgptUnavailableError('Подключение ChatGPT требует повторного входа по коду (нет refresh-токена)');
  }

  let grant;
  try {
    grant = await refreshTokens(credentials.refreshToken);
  } catch (e) {
    if (e instanceof ChatgptAuthError && e.code === 'rejected') {
      await chatgptConnectionRepo.markReauth(e.message);
      throw new ChatgptUnavailableError(`Подключение ChatGPT требует повторного входа по коду: ${e.message}`);
    }
    throw e;
  }

  const account = {
    accountId: grant.account.accountId ?? connection.accountId,
    email: grant.account.email ?? connection.accountEmail,
    planType: grant.account.planType ?? connection.planType,
    accessExpiresMs: grant.account.accessExpiresMs,
  };
  const written = await chatgptConnectionRepo.updateTokens({
    expectedVersion: connection.version,
    credentials: {
      accessToken: grant.credentials.accessToken,
      // Провайдер не всегда присылает новый refresh/id-токен — тогда остаются прежние.
      refreshToken: grant.credentials.refreshToken ?? credentials.refreshToken,
      idToken: grant.credentials.idToken ?? credentials.idToken,
    },
    account,
    refreshedMs: Date.now(),
  });
  if (written) {
    logger.info('ChatGPT: access token refreshed', {
      expiresAt: account.accessExpiresMs ? new Date(account.accessExpiresMs).toISOString() : null,
    });
    return { accessToken: grant.credentials.accessToken, accountId: account.accountId };
  }
  // Строку успели обновить в обход этого вызова — берём то, что записано.
  const latest = await load();
  return { accessToken: latest.credentials.accessToken, accountId: latest.connection.accountId };
}

async function load(): Promise<{ connection: ChatgptConnection; credentials: ChatgptCredentials }> {
  const connection = await chatgptConnectionRepo.get();
  if (!connection) throw new ChatgptUnavailableError('ChatGPT не подключён: Настройки → «Подключение ChatGPT» → «Войти по коду»');
  if (connection.status === 'reauth_required') {
    throw new ChatgptUnavailableError(`Подключение ChatGPT требует повторного входа по коду${connection.lastError ? `: ${connection.lastError}` : ''}`);
  }
  if (connection.rateLimitedUntilMs && connection.rateLimitedUntilMs > Date.now()) {
    throw new ChatgptUnavailableError(`Лимит подписки ChatGPT исчерпан до ${new Date(connection.rateLimitedUntilMs).toISOString()}`);
  }
  const credentials = await chatgptConnectionRepo.getCredentials();
  if (!credentials) {
    // Токены нельзя расшифровать (сменился JWT_SECRET) — восстанавливается входом по коду.
    await chatgptConnectionRepo.markReauth('токены не расшифровать: сменился JWT_SECRET');
    throw new ChatgptUnavailableError('Подключение ChatGPT требует повторного входа по коду (токены не расшифровать)');
  }
  return { connection, credentials };
}

function needsRefresh(connection: ChatgptConnection, credentials: ChatgptCredentials, rejectedAccessToken: string | undefined): boolean {
  if (rejectedAccessToken !== undefined) return credentials.accessToken === rejectedAccessToken;
  if (connection.accessExpiresMs == null) return false;
  return connection.accessExpiresMs - Date.now() <= REFRESH_MARGIN_MS;
}
