import { describe, it, expect, vi, beforeEach } from 'vitest';

const net = vi.hoisted(() => ({ fetch: vi.fn() }));
const access = vi.hoisted(() => ({ acquireChatgptAccess: vi.fn() }));
const repo = vi.hoisted(() => ({ markReauth: vi.fn(), markRateLimited: vi.fn(), touchUsed: vi.fn() }));

vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');
  return { ...actual, fetch: net.fetch };
});
vi.mock('../../src/chatgpt/access', async () => {
  const actual = await vi.importActual<typeof import('../../src/chatgpt/access')>('../../src/chatgpt/access');
  return { ...actual, acquireChatgptAccess: access.acquireChatgptAccess };
});
vi.mock('../../src/database/repositories/chatgptConnectionRepo', () => ({ chatgptConnectionRepo: repo }));

import { codexRespond } from '../../src/chatgpt/codexClient';

const ok = (text: string) => new Response(
  `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`
  + `data: ${JSON.stringify({ type: 'response.completed', response: { model: 'gpt-6.1-sol', usage: { input_tokens: 10, output_tokens: 2 } } })}\n\n`,
  { status: 200, headers: { 'content-type': 'text/event-stream' } },
);
const req = () => ({
  model: 'gpt-6.1-sol', instructions: 'i', content: [{ type: 'input_text' as const, text: 't' }],
  effort: 'low' as const, signal: AbortSignal.timeout(5000), label: 'test',
});

beforeEach(() => {
  vi.resetAllMocks();
  repo.touchUsed.mockResolvedValue(undefined);
  access.acquireChatgptAccess.mockResolvedValue({ accessToken: 'AT-1', accountId: 'acc-1' });
});

describe('codexRespond', () => {
  it('успех: текст ответа, отметка использования', async () => {
    net.fetch.mockResolvedValue(ok('готово'));
    expect((await codexRespond(req())).text).toBe('готово');
    expect(net.fetch.mock.calls[0][0]).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(net.fetch.mock.calls[0][1].headers['chatgpt-account-id']).toBe('acc-1');
    expect(repo.touchUsed).toHaveBeenCalled();
  });

  it('401 — один повтор с принудительно обновлённым токеном', async () => {
    net.fetch.mockResolvedValueOnce(new Response('{"detail":"expired"}', { status: 401 })).mockResolvedValueOnce(ok('ок'));
    access.acquireChatgptAccess
      .mockResolvedValueOnce({ accessToken: 'AT-1', accountId: 'acc-1' })
      .mockResolvedValueOnce({ accessToken: 'AT-2', accountId: 'acc-1' });
    expect((await codexRespond(req())).text).toBe('ок');
    expect(access.acquireChatgptAccess).toHaveBeenLastCalledWith({ rejectedAccessToken: 'AT-1' });
    expect(net.fetch.mock.calls[1][1].headers.authorization).toBe('Bearer AT-2');
  });

  it('401 и после обновления — подключение «нужен вход»', async () => {
    net.fetch.mockImplementation(async () => new Response('{}', { status: 401 }));
    await expect(codexRespond(req())).rejects.toMatchObject({ status: 401 });
    expect(repo.markReauth).toHaveBeenCalled();
  });

  it('429 — пауза подключения до сброса лимита из тела ошибки', async () => {
    net.fetch.mockResolvedValue(new Response(JSON.stringify({ error: { message: 'usage limit', resets_in_seconds: 3600 } }), { status: 429 }));
    await expect(codexRespond(req())).rejects.toMatchObject({ status: 429 });
    const [untilMs, message] = repo.markRateLimited.mock.calls[0];
    expect(untilMs).toBeGreaterThan(Date.now() + 3500 * 1000);
    expect(message).toMatch(/usage limit/);
  });

  it('403 от Cloudflare — подсказка про прокси', async () => {
    net.fetch.mockResolvedValue(new Response('<html>Just a moment... cf-ray</html>', { status: 403 }));
    await expect(codexRespond(req())).rejects.toThrow(/OPENAI_PROXY_URL/);
  });
});
