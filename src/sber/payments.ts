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

// ─── Статус платёжки (раздел «Получение статуса рублевого платежного поручения») ───

export interface PaymentState {
  bankStatus: string | null;
  bankComment: string | null;
}

export async function getPaymentState(accessToken: string, externalId: string): Promise<PaymentState> {
  const res = await sberFetch(`${PAYMENTS_URL}/${encodeURIComponent(externalId)}/state`, {
    headers: { Authorization: accessToken, Accept: 'application/json' },
  });
  if (!res.ok) throw new SberApiError(res.status, res.body);
  const data = res.json<{ bankStatus?: string; bankComment?: string }>();
  return { bankStatus: data.bankStatus ?? null, bankComment: data.bankComment ?? null };
}

/** Окончательные статусы: опрос прекращается. Остальные — промежуточные. */
const FINAL_OK = new Set(['IMPLEMENTED']);
const FINAL_FAIL = new Set([
  'CHECKERROR', 'DELETED', 'INVALIDEDS', 'RECALL', 'REFUSEDBYBANK', 'REFUSEDBYABS',
  'REQUISITEERROR', 'REFUSED_BY_RZK', 'FRAUDDENY',
  // Наш статус: банк не нашёл платёжку по externalId (черновик удалили в банке).
  'NOT_FOUND',
]);

/** Все окончательные статусы — для выборки «что ещё опрашивать». */
export const FINAL_BANK_STATUSES: readonly string[] = [...FINAL_OK, ...FINAL_FAIL];

export type BankStatusKind = 'paid' | 'failed' | 'draft' | 'in_progress' | 'unknown';

export function bankStatusKind(status: string | null | undefined): BankStatusKind {
  if (!status) return 'unknown';
  if (FINAL_OK.has(status)) return 'paid';
  if (FINAL_FAIL.has(status)) return 'failed';
  if (status === 'CREATED' || status === 'PARTSIGNED') return 'draft';
  return 'in_progress';
}

export function isFinalBankStatus(status: string | null | undefined): boolean {
  const k = bankStatusKind(status);
  return k === 'paid' || k === 'failed';
}

const LABELS: Record<string, string> = {
  CREATED: 'Создан, ждёт подписи', PARTSIGNED: 'Частично подписан', SIGNED: 'Подписан',
  ACCEPTED: 'Принят банком', ACCEPTED_BY_ABS: 'Принят банком', DELIVERED: 'Доставлен в банк',
  DELIVERED_RZK: 'Доставлен в СБК', TO_PROCESSING_RZK: 'К отправке в СБК', SENDING_TO_RZK: 'Отправляется в СБК',
  PROCESSING_RZK: 'Обрабатывается СБК', NOT_ACCEPTED_RZK: 'Не принят СБК', RZK_SIGN_ERROR: 'Ошибка ЭП СБК',
  CARD2: 'Картотека 2 — ждёт денег на счёте', DELAYED: 'Приостановлен', REQUESTED_RECALL: 'Запрошен отзыв',
  FRAUDSENT: 'На проверке безопасности', FRAUDREVIEW: 'На проверке у специалиста банка',
  FRAUDSMS: 'Нужно подтверждение SMS', FRAUDALLOW: 'Проверка безопасности пройдена',
  IMPLEMENTED: 'Исполнен', CHECKERROR: 'Ошибка контроля', DELETED: 'Удалён', INVALIDEDS: 'Подпись неверна',
  RECALL: 'Отозван', REFUSEDBYBANK: 'Отклонён банком', REFUSEDBYABS: 'Отказан АБС',
  REQUISITEERROR: 'Ошибка реквизитов', REFUSED_BY_RZK: 'Отказан контролирующей организацией',
  FRAUDDENY: 'Отвергнут проверкой безопасности', NOT_FOUND: 'Не найден в банке (черновик удалён?)',
};

export function bankStatusLabel(status: string | null | undefined): string {
  if (!status) return 'Статус неизвестен';
  return LABELS[status] ?? status;
}
