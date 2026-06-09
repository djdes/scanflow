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

  it('uses an explicit apiKey argument (from DB config) over the env var', async () => {
    delete process.env.DADATA_API_KEY; // env empty — key must come from the arg
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ suggestions: [{ value: 'ООО Тест', data: { inn: '5012089824' } }] }),
    });
    const out = await lookupPartyByInn('5012089824', 'db-key-123');
    expect(out?.inn).toBe('5012089824');
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBe('Token db-key-123');
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
