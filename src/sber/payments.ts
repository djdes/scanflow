import { sberFetch } from './sberClient';

const PAYMENTS_URL = 'https://fintech.sberbank.ru:9443/fintech/api/v1/payments';

export interface PaymentOrderPayload {
  date: string;                    // YYYY-MM-DD
  externalId: string;              // UUID
  amount: number;                  // > 0
  purpose: string;                 // ≤ 210 chars
  number?: string;
  payerName: string;
  payerInn: string;
  payerKpp?: string;
  payerAccount: string;            // 20 digits
  payerBankBic: string;            // 9 digits
  payerBankCorrAccount: string;    // 20 digits
  payeeName: string;
  payeeInn?: string;
  payeeKpp?: string;
  payeeAccount?: string;
  payeeBankBic: string;            // 9 digits
  payeeBankCorrAccount?: string;
}

export interface PaymentOrderResponse {
  externalId: string;
  number?: string;
  status?: string;
}

export class SberApiError extends Error {
  constructor(public status: number, public body: string, public requestId?: string) {
    super(`Sber API error ${status}: ${body}`);
    this.name = 'SberApiError';
  }
}

function validatePayload(p: PaymentOrderPayload): void {
  const checks: Array<[string, RegExp | ((v: unknown) => boolean), unknown]> = [
    ['date', /^\d{4}-\d{2}-\d{2}$/, p.date],
    ['externalId', /^.{1,36}$/, p.externalId],
    ['amount', (v) => typeof v === 'number' && v >= 0.01, p.amount],
    ['purpose', (v) => typeof v === 'string' && v.length > 0 && v.length <= 210, p.purpose],
    ['payerAccount', /^[0-9]{20}$/, p.payerAccount],
    ['payerBankBic', /^[0-9]{9}$/, p.payerBankBic],
    ['payerBankCorrAccount', /^[0-9]{20}$/, p.payerBankCorrAccount],
    ['payeeBankBic', /^[0-9]{9}$/, p.payeeBankBic],
  ];
  for (const [field, rule, val] of checks) {
    const ok = rule instanceof RegExp
      ? typeof val === 'string' && rule.test(val)
      : (rule as (v: unknown) => boolean)(val);
    if (!ok) {
      throw new Error(`Invalid payment payload: field "${field}" failed validation (got ${JSON.stringify(val)})`);
    }
  }
  if (p.payeeAccount !== undefined && !/^[0-9]{20}$/.test(p.payeeAccount)) {
    throw new Error('Invalid payment payload: field "payeeAccount" must be 20 digits');
  }
}

export async function createPaymentOrder(
  accessToken: string,
  payload: PaymentOrderPayload,
): Promise<PaymentOrderResponse> {
  validatePayload(payload);
  const body: Record<string, unknown> = {
    date: payload.date,
    externalId: payload.externalId,
    amount: payload.amount,
    operationCode: '01',
    priority: '5',
    purpose: payload.purpose,
    payerName: payload.payerName,
    payerInn: payload.payerInn,
    payerAccount: payload.payerAccount,
    payerBankBic: payload.payerBankBic,
    payerBankCorrAccount: payload.payerBankCorrAccount,
    payeeName: payload.payeeName,
    payeeBankBic: payload.payeeBankBic,
  };
  for (const opt of ['number', 'payerKpp', 'payeeInn', 'payeeKpp', 'payeeAccount', 'payeeBankCorrAccount'] as const) {
    if (payload[opt] !== undefined) body[opt] = payload[opt];
  }
  const res = await sberFetch(PAYMENTS_URL, {
    method: 'POST',
    headers: {
      Authorization: accessToken,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new SberApiError(res.status, res.body);
  }
  const data = res.json<{ externalId?: string; number?: string; status?: string }>();
  return {
    externalId: data.externalId ?? payload.externalId,
    number: data.number,
    status: data.status,
  };
}
