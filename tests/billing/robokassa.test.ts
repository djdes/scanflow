import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCheckoutSignature, formatRobokassaAmount, verifyResultSignature } from '../../src/billing/robokassa/protocol';
import { PaymentsDisabledError, robokassaGateway } from '../../src/billing/robokassa/gateway';

afterEach(() => vi.unstubAllEnvs());

describe('Robokassa preparation stays disabled', () => {
  it('does not enable payments even when future environment variables are populated', () => {
    vi.stubEnv('BILLING_ENABLED', 'true');
    vi.stubEnv('ROBOKASSA_MERCHANT_LOGIN', 'test-only');
    vi.stubEnv('ROBOKASSA_PASSWORD_1', 'test-only');
    vi.stubEnv('ROBOKASSA_PASSWORD_2', 'test-only');
    expect(robokassaGateway.enabled).toBe(false);
    expect(() => robokassaGateway.createCheckout()).toThrow(PaymentsDisabledError);
    expect(() => robokassaGateway.acceptResult()).toThrow(PaymentsDisabledError);
  });
});

describe('Robokassa protocol', () => {
  it('formats integer kopecks without losing cents', () => {
    expect(formatRobokassaAmount(99000)).toBe('990.00');
    expect(formatRobokassaAmount(1)).toBe('0.01');
    expect(formatRobokassaAmount(199)).toBe('1.99');
    for (const amount of [0, -1, 1.1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => formatRobokassaAmount(amount)).toThrow();
    }
  });
  it('places Receipt before password 1 and sorts custom fields', () => {
    const input = { merchantLogin: 'test-shop', invoiceId: '9223372036854775807', amountKopecks: 99000,
      password1: 'test-pass-1', algorithm: 'sha256' as const,
      encodedReceipt: '%7B%22items%22%3A%5B%5D%7D', customFields: { Shp_plan: 'pro', Shp_owner: '42' } };
    const expected = createHash('sha256').update('test-shop:990.00:9223372036854775807:%7B%22items%22%3A%5B%5D%7D:test-pass-1:Shp_owner=42:Shp_plan=pro').digest('hex');
    expect(createCheckoutSignature(input)).toBe(expected);
    expect(() => createCheckoutSignature({ ...input, invoiceId: '9223372036854775808' })).toThrow();
    expect(() => createCheckoutSignature({ ...input, customFields: { Shp_plan: 'pro:Shp_owner=1' } })).toThrow();
  });
  it('verifies password 2 signatures with six decimal places, not a rounded amount', () => {
    const input = { outSum: '990.000000', invoiceId: '123', password2: 'test-pass-2', algorithm: 'sha256' as const,
      customFields: { Shp_plan: 'pro', Shp_owner: '42' }, signature: '' };
    input.signature = createHash('sha256').update('990.000000:123:test-pass-2:Shp_owner=42:Shp_plan=pro').digest('hex').toUpperCase();
    expect(verifyResultSignature(input)).toBe(true);
    for (const mutation of [
      { outSum: '990.00' }, { outSum: '991.000000' }, { invoiceId: '124' },
      { password2: 'test-pass-1' }, { signature: '' }, { signature: 'z'.repeat(64) },
      { customFields: { Shp_owner: '43', Shp_plan: 'pro' } },
    ]) expect(verifyResultSignature({ ...input, ...mutation })).toBe(false);
  });
});
