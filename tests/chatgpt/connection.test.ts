import { describe, it, expect, vi, beforeEach } from 'vitest';

const codex = vi.hoisted(() => ({ codexRespond: vi.fn() }));

vi.mock('../../src/chatgpt/codexClient', () => ({ codexRespond: codex.codexRespond }));
vi.mock('../../src/database/repositories/chatgptConnectionRepo', () => ({ chatgptConnectionRepo: {} }));
vi.mock('../../src/database/repositories/chatgptDeviceLoginRepo', () => ({ chatgptDeviceLoginRepo: {} }));

import { testChatgpt } from '../../src/chatgpt/connection';

beforeEach(() => {
  vi.resetAllMocks();
});

describe('testChatgpt', () => {
  it('«Проверить связь» спрашивает OpenAI даже на паузе лимита: успех её снимет, новый 429 продлит', async () => {
    codex.codexRespond.mockResolvedValue({ text: 'готово', model: 'gpt-6.1-sol' });
    const result = await testChatgpt('gpt-6.1-sol');
    expect(result.ok).toBe(true);
    expect(codex.codexRespond).toHaveBeenCalledWith(expect.objectContaining({ ignoreRateLimit: true }));
  });
});
