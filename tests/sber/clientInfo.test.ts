import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/sber/sberClient', () => ({ sberFetch: vi.fn() }));

import { sberFetch } from '../../src/sber/sberClient';
import { fetchClientInfo } from '../../src/sber/clientInfo';

describe('fetchClientInfo', () => {
  it('parses org name and RUB account', async () => {
    vi.mocked(sberFetch).mockResolvedValue({
      status: 200, ok: true,
      body: JSON.stringify({
        orgName: 'ООО Тест',
        accounts: [
          { number: '40702810940000099835', currency: 'RUB' },
          { number: '40702840940000099836', currency: 'USD' },
        ],
      }),
      json<T>() { return JSON.parse(this.body) as T; },
    });
    const out = await fetchClientInfo('TOKEN');
    expect(out).toEqual({ orgName: 'ООО Тест', accountNumber: '40702810940000099835' });
  });

  it('falls back to first account when no RUB', async () => {
    vi.mocked(sberFetch).mockResolvedValue({
      status: 200, ok: true,
      body: JSON.stringify({ accounts: [{ number: '40702840940000099836', currency: 'USD' }] }),
      json<T>() { return JSON.parse(this.body) as T; },
    });
    const out = await fetchClientInfo('TOKEN');
    expect(out.accountNumber).toBe('40702840940000099836');
  });

  it('returns null fields gracefully on empty response', async () => {
    vi.mocked(sberFetch).mockResolvedValue({
      status: 200, ok: true, body: '{}', json<T>() { return JSON.parse(this.body) as T; },
    });
    const out = await fetchClientInfo('TOKEN');
    expect(out).toEqual({ orgName: null, accountNumber: null });
  });

  it('throws on non-2xx', async () => {
    vi.mocked(sberFetch).mockResolvedValue({
      status: 401, ok: false, body: 'unauth', json<T>() { return JSON.parse(this.body) as T; },
    });
    await expect(fetchClientInfo('TOKEN')).rejects.toThrow(/client-info/);
  });
});
