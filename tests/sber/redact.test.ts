import { describe, it, expect } from 'vitest';
import { redact } from '../../src/sber/redact';

describe('redact', () => {
  it('masks secret keys in flat object', () => {
    const out = redact({ access_token: 'abc', client_id: '40285' });
    expect(out).toEqual({ access_token: '***', client_id: '40285' });
  });

  it('masks secret keys recursively', () => {
    const out = redact({
      data: { refresh_token: 'r', payer: { name: 'X', payerAccount: '4070' } },
    });
    expect(out).toEqual({
      data: { refresh_token: '***', payer: { name: 'X', payerAccount: '***' } },
    });
  });

  it('returns null/undefined as-is', () => {
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
  });

  it('handles arrays', () => {
    const out = redact([{ access_token: 'a' }, { name: 'b' }]);
    expect(out).toEqual([{ access_token: '***' }, { name: 'b' }]);
  });

  it('does not mutate input', () => {
    const input = { access_token: 'abc' };
    redact(input);
    expect(input.access_token).toBe('abc');
  });
});
