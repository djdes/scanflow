import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sendMessage, editMessageText, MessageGoneError, getMe, getUpdates } from '../../../src/notifications/telegram/telegramClient';

const TOKEN = 'test:bot-token';
const CHAT = '123456';

function mockFetchResponse(body: unknown, ok = true): void {
  global.fetch = vi.fn(async () => ({
    json: async () => body,
    ok,
  })) as any;
}

describe('telegramClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('sendMessage', () => {
    it('returns message_id on success', async () => {
      mockFetchResponse({ ok: true, result: { message_id: 999 } });
      const id = await sendMessage(TOKEN, CHAT, 'hello');
      expect(id).toBe(999);
    });

    it('posts the right body to Telegram API', async () => {
      const fetchMock = vi.fn(async () => ({
        json: async () => ({ ok: true, result: { message_id: 1 } }),
        ok: true,
      }));
      global.fetch = fetchMock as any;
      await sendMessage(TOKEN, CHAT, 'hi');
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toContain(`bot${TOKEN}/sendMessage`);
      expect(init?.method).toBe('POST');
      const body = JSON.parse(init?.body as string);
      expect(body.chat_id).toBe(CHAT);
      expect(body.text).toBe('hi');
      expect(body.disable_web_page_preview).toBe(true);
    });

    it('throws on Telegram API error', async () => {
      mockFetchResponse({ ok: false, error_code: 401, description: 'Unauthorized' });
      await expect(sendMessage(TOKEN, CHAT, 'x')).rejects.toThrow(/401 Unauthorized/);
    });
  });

  describe('editMessageText', () => {
    it('resolves on success', async () => {
      mockFetchResponse({ ok: true, result: true });
      await expect(editMessageText(TOKEN, CHAT, 42, 'updated')).resolves.toBeUndefined();
    });

    it('throws MessageGoneError when Telegram says message not found', async () => {
      mockFetchResponse({
        ok: false,
        error_code: 400,
        description: 'Bad Request: message to edit not found',
      });
      await expect(editMessageText(TOKEN, CHAT, 42, 'x')).rejects.toBeInstanceOf(MessageGoneError);
    });

    it('throws MessageGoneError when message can\'t be edited', async () => {
      mockFetchResponse({
        ok: false,
        error_code: 400,
        description: "Bad Request: message can't be edited",
      });
      await expect(editMessageText(TOKEN, CHAT, 42, 'x')).rejects.toBeInstanceOf(MessageGoneError);
    });

    it('throws generic Error for other 400 codes', async () => {
      mockFetchResponse({
        ok: false,
        error_code: 400,
        description: 'Bad Request: chat not found',
      });
      // Not "message not found" — general error
      const err = await editMessageText(TOKEN, CHAT, 42, 'x').catch(e => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(MessageGoneError);
    });
  });

  describe('getMe', () => {
    it('returns id and username on success', async () => {
      mockFetchResponse({ ok: true, result: { id: 12345, username: 'scanflow_bot', is_bot: true } });
      const me = await getMe(TOKEN);
      expect(me).toEqual({ id: 12345, username: 'scanflow_bot' });
    });

    it('throws "Unauthorized" on 401 (bad token)', async () => {
      mockFetchResponse({ ok: false, error_code: 401, description: 'Unauthorized' });
      await expect(getMe(TOKEN)).rejects.toThrow(/401 Unauthorized/);
    });
  });

  describe('getUpdates', () => {
    it('returns empty array when bot has no updates', async () => {
      mockFetchResponse({ ok: true, result: [] });
      const updates = await getUpdates(TOKEN);
      expect(updates).toEqual([]);
    });

    it('returns parsed updates with chat info', async () => {
      mockFetchResponse({
        ok: true,
        result: [
          { update_id: 1, message: { chat: { id: 111, type: 'private' } } },
          { update_id: 2, message: { chat: { id: -200, type: 'group' } } },
        ],
      });
      const updates = await getUpdates(TOKEN);
      expect(updates).toHaveLength(2);
      expect(updates[0].message?.chat.id).toBe(111);
      expect(updates[1].message?.chat.type).toBe('group');
    });

    it('throws on Telegram API error', async () => {
      mockFetchResponse({ ok: false, error_code: 401, description: 'Unauthorized' });
      await expect(getUpdates(TOKEN)).rejects.toThrow(/401 Unauthorized/);
    });
  });
});
