import { describe, it, expect, vi, beforeEach } from 'vitest';
import { lookupPartyByInn, DadataNotConfiguredError } from '../../src/sber/dadata';

describe('lookupPartyByInn', () => {
  beforeEach(() => {
    process.env.DADATA_API_KEY = 'test-key';
    global.fetch = vi.fn();
  });

  it('throws DadataNotConfiguredError when key absent', async () => {
    delete process.env.DADATA_API_KEY;
    await expect(lookupPartyByInn('5012089824')).rejects.toBeInstanceOf(DadataNotConfiguredError);
  });

  it('returns null when no suggestions', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ suggestions: [] }),
    });
    expect(await lookupPartyByInn('9999999999')).toBeNull();
  });

  it('parses first suggestion', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        suggestions: [{
          value: 'ООО "Свит лайф"',
          data: {
            inn: '5012089824',
            kpp: '501201001',
            name: { full: 'ООО "Свит лайф"' },
            address: { value: 'Москва' },
          },
        }],
      }),
    });
    const out = await lookupPartyByInn('5012089824');
    expect(out).toEqual({
      name: 'ООО "Свит лайф"',
      inn: '5012089824',
      kpp: '501201001',
      address: 'Москва',
    });
  });

  it('throws on non-200', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false, status: 401, text: async () => 'unauth',
    });
    await expect(lookupPartyByInn('5012089824')).rejects.toThrow(/DaData/);
  });
});
