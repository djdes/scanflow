import { logger } from '../../utils/logger';

// Thrown by editMessageText when Telegram says the message is gone
// (deleted by user, or doesn't exist). Caller should fall back to sendMessage.
export class MessageGoneError extends Error {
  constructor(public telegramDescription: string) {
    super(`Telegram message gone: ${telegramDescription}`);
    this.name = 'MessageGoneError';
  }
}

interface TelegramOk<T> {
  ok: true;
  result: T;
}
interface TelegramErr {
  ok: false;
  description: string;
  error_code: number;
}

// Extracts a useful description from native fetch failures. undici (Node 18+
// native fetch) throws plain `Error('fetch failed')` and stuffs the actual
// reason — DNS, ETIMEDOUT, ECONNREFUSED, TLS — into `err.cause`. Without this
// helper logs only show "fetch failed" with zero info to act on.
function describeFetchError(err: unknown): string {
  const e = err as { message?: string; cause?: { code?: string; message?: string; errors?: Array<{ code?: string; message?: string }> } };
  const baseMsg = e?.message ?? String(err);
  const cause = e?.cause;
  if (!cause) return baseMsg;

  // AggregateError-like (multiple addrs tried, all failed)
  if (Array.isArray(cause.errors) && cause.errors.length > 0) {
    const causes = cause.errors
      .map((c) => `${c?.code ?? '?'} ${c?.message ?? ''}`.trim())
      .join('; ');
    return `${baseMsg} (${causes})`;
  }

  const code = cause.code ? `${cause.code} ` : '';
  const causeMsg = cause.message ?? '';
  return `${baseMsg} (${code}${causeMsg})`.trim();
}

async function callTelegram<T>(token: string, method: string, params: Record<string, unknown>): Promise<T> {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    // Surface the real cause (DNS, firewall, TLS) instead of opaque "fetch failed".
    throw new Error(`Telegram API ${method} network error: ${describeFetchError(err)}`);
  }
  const data = (await res.json()) as TelegramOk<T> | TelegramErr;
  if (!data.ok) {
    const errData = data as TelegramErr;
    // editMessageText returns 400 with descriptions like:
    //   "Bad Request: message to edit not found"
    //   "Bad Request: message can't be edited"
    //   "Bad Request: MESSAGE_ID_INVALID"
    if (
      method === 'editMessageText' &&
      errData.error_code === 400 &&
      /message (to edit )?not found|message can't be edited|MESSAGE_ID_INVALID/i.test(errData.description)
    ) {
      throw new MessageGoneError(errData.description);
    }
    throw new Error(`Telegram API ${method} failed: ${errData.error_code} ${errData.description}`);
  }
  return data.result;
}

interface SendMessageResult {
  message_id: number;
}

// Sends a new text message to chat. Returns the new message_id.
export async function sendMessage(token: string, chatId: string, text: string): Promise<number> {
  const result = await callTelegram<SendMessageResult>(token, 'sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });
  logger.debug('Telegram sendMessage ok', { chatId, messageId: result.message_id });
  return result.message_id;
}

// Edits an existing message. Throws MessageGoneError if the message is no
// longer editable; the caller should fall back to sendMessage.
export async function editMessageText(
  token: string,
  chatId: string,
  messageId: number,
  text: string,
): Promise<void> {
  await callTelegram(token, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
  });
  logger.debug('Telegram editMessageText ok', { chatId, messageId });
}

// Узкий type под наши нужды — Telegram Update имеет много полей,
// но для поиска chat_id нам нужно только это.
export interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: {
      id: number;
      type: 'private' | 'group' | 'supergroup' | 'channel';
    };
  };
}

interface GetMeResult {
  id: number;
  username: string;
  is_bot: boolean;
}

// Returns the bot's identity. Used to validate the token (401 = bad token)
// and surface the bot's @username to the UI so we can deep-link to t.me.
export async function getMe(token: string): Promise<{ id: number; username: string }> {
  const result = await callTelegram<GetMeResult>(token, 'getMe', {});
  logger.debug('Telegram getMe ok', { username: result.username });
  return { id: result.id, username: result.username };
}

// Returns recent updates for the bot. Telegram retains them for 24 hours
// and only as long as no webhook is configured. Empty array is normal —
// the user simply hasn't written anything to the bot yet.
export async function getUpdates(token: string): Promise<TelegramUpdate[]> {
  const result = await callTelegram<TelegramUpdate[]>(token, 'getUpdates', {});
  logger.debug('Telegram getUpdates ok', { count: result.length });
  return result;
}
