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

async function callTelegram<T>(token: string, method: string, params: Record<string, unknown>): Promise<T> {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15_000),
  });
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
