import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/sber/sberClient', () => ({ sberFetch: vi.fn() }));

import { sberFetch } from '../../src/sber/sberClient';
import { createPaymentOrder, SberApiError, type PaymentOrderPayload } from '../../src/sber/payments';

describe('createPaymentOrder', () => {
  const valid: PaymentOrderPayload = {
    date: '2026-05-06',
    externalId: '11111111-2222-3333-4444-555555555555',
    amount: 1234.56,
    purpose: 'Оплата по накладной',
    payerName: 'ООО БФС',
    payerInn: '7707083893',
    payerKpp: '770701001',
    payerAccount: '40702810940000099835',
    payerBankBic: '044525225',
    payerBankCorrAccount: '30101810400000000225',
    payeeName: 'ООО Свит лайф',
    payeeInn: '5012089824',
    payeeKpp: '501201001',
    payeeAccount: '40702810000000000001',
    payeeBankBic: '044525225',
    payeeBankCorrAccount: '30101810400000000225',
  };

  it('POSTs to /v1/payments with operationCode=01 and priority=5', async () => {
    vi.mocked(sberFetch).mockResolvedValue({
      status: 201, ok: true,
      body: JSON.stringify({ externalId: valid.externalId, number: '12345', status: 'ACCEPTED' }),
      json<T>() { return JSON.parse(this.body) as T; },
    });
    const out = await createPaymentOrder('TOKEN', valid);
    expect(out).toEqual({ externalId: valid.externalId, number: '12345', status: 'ACCEPTED' });
    const [url, opts] = vi.mocked(sberFetch).mock.calls[0];
    expect(url).toBe('https://fintech.sberbank.ru:9443/fintech/api/v1/payments');
    const optsTyped = opts as { method?: string; headers?: Record<string, string>; body: string };
    expect(optsTyped.method).toBe('POST');
    expect(optsTyped.headers!.Authorization).toBe('TOKEN');
    expect(optsTyped.headers!['Content-Type']).toBe('application/json');
    const body = JSON.parse(optsTyped.body);
    expect(body.operationCode).toBe('01');
    expect(body.priority).toBe('5');
    expect(body.amount).toBe(1234.56);
    expect(body.payerAccount).toBe('40702810940000099835');
  });

  it('throws on 400 with sber error', async () => {
    vi.mocked(sberFetch).mockResolvedValue({
      status: 400, ok: false, body: '{"errors":[{"description":"Invalid BIC"}]}',
      json<T>() { return JSON.parse(this.body) as T; },
    });
    await expect(createPaymentOrder('T', valid)).rejects.toMatchObject({
      message: expect.stringContaining('400'),
      status: 400,
      body: expect.stringContaining('Invalid BIC'),
    });
  });

  it('validates payerAccount is 20 digits before sending', async () => {
    vi.mocked(sberFetch).mockReset();
    await expect(createPaymentOrder('T', { ...valid, payerAccount: '407' })).rejects.toThrow(/payerAccount/);
    expect(sberFetch).not.toHaveBeenCalled();
  });

  it('validates BIC is 9 digits', async () => {
    await expect(createPaymentOrder('T', { ...valid, payeeBankBic: '12' })).rejects.toThrow(/payeeBankBic/);
  });

  it('validates purpose ≤ 210 chars', async () => {
    await expect(createPaymentOrder('T', { ...valid, purpose: 'X'.repeat(211) })).rejects.toThrow(/purpose/);
  });

  it('omits empty optional fields', async () => {
    vi.mocked(sberFetch).mockResolvedValue({
      status: 201, ok: true, body: '{}', json<T>() { return JSON.parse(this.body) as T; },
    });
    const minimal: PaymentOrderPayload = { ...valid };
    delete (minimal as Partial<PaymentOrderPayload>).payeeKpp;
    delete (minimal as Partial<PaymentOrderPayload>).payeeAccount;
    delete (minimal as Partial<PaymentOrderPayload>).payeeBankCorrAccount;
    delete (minimal as Partial<PaymentOrderPayload>).payerKpp;
    await createPaymentOrder('TOKEN', minimal);
    const opts = vi.mocked(sberFetch).mock.calls[vi.mocked(sberFetch).mock.calls.length - 1][1] as { body: string };
    const body = JSON.parse(opts.body);
    expect(body.payeeKpp).toBeUndefined();
    expect(body.payeeAccount).toBeUndefined();
  });

  it('SberApiError carries status and body', () => {
    const e = new SberApiError(429, 'Too Many');
    expect(e.status).toBe(429);
    expect(e.body).toBe('Too Many');
    expect(e.message).toContain('429');
  });
});
