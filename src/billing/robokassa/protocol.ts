import { createHash, timingSafeEqual } from 'node:crypto';

// Pure protocol helpers only. They do not read credentials, issue requests,
// create orders, acknowledge callbacks, or grant access.
// https://docs.robokassa.ru/ru/pay-interface
// https://docs.robokassa.ru/ru/notifications-and-redirects
type HashAlgorithm = 'md5' | 'sha256' | 'sha512';
type CustomFields = Readonly<Record<string, string>>;

function customParts(fields: CustomFields): string[] {
  return Object.keys(fields).sort().map(key => {
    if (!/^Shp_[A-Za-z0-9_]+$/.test(key) || /[:\r\n]/.test(fields[key])) {
      throw new Error('Invalid Robokassa custom field');
    }
    return `${key}=${fields[key]}`;
  });
}

function validateInvoiceId(value: string): void {
  if (!/^[1-9]\d{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) {
    throw new Error('Invalid Robokassa invoice ID');
  }
}

export function formatRobokassaAmount(kopecks: number): string {
  if (!Number.isSafeInteger(kopecks) || kopecks <= 0) throw new Error('Amount must be positive integer kopecks');
  return `${Math.floor(kopecks / 100)}.${String(kopecks % 100).padStart(2, '0')}`;
}

export function createCheckoutSignature(input: {
  merchantLogin: string; invoiceId: string; amountKopecks: number;
  password1: string; algorithm: HashAlgorithm; customFields?: CustomFields;
  // Exactly the URL-encoded Receipt value sent to Robokassa, if applicable.
  encodedReceipt?: string;
}): string {
  validateInvoiceId(input.invoiceId);
  if (!input.merchantLogin || !input.password1 || /[:\r\n]/.test(input.merchantLogin)) throw new Error('Missing or invalid merchant configuration');
  const parts = [input.merchantLogin, formatRobokassaAmount(input.amountKopecks), input.invoiceId];
  if (input.encodedReceipt !== undefined) {
    if (!input.encodedReceipt || /[:\r\n]/.test(input.encodedReceipt)) throw new Error('Invalid encoded receipt');
    parts.push(input.encodedReceipt);
  }
  parts.push(input.password1, ...customParts(input.customFields ?? {}));
  return createHash(input.algorithm).update(parts.join(':'), 'utf8').digest('hex');
}

export function verifyResultSignature(input: {
  outSum: string; invoiceId: string; signature: string;
  password2: string; algorithm: HashAlgorithm; customFields?: CustomFields;
}): boolean {
  try {
    validateInvoiceId(input.invoiceId);
    // Preserve OutSum verbatim in the signature: production callbacks can
    // contain six decimal places. Never parse/round before verification.
    if (!/^\d{1,16}(?:\.\d{1,6})?$/.test(input.outSum) || !input.password2) return false;
    const expected = createHash(input.algorithm)
      .update([input.outSum, input.invoiceId, input.password2, ...customParts(input.customFields ?? {})].join(':'), 'utf8')
      .digest('hex');
    if (input.signature.length !== expected.length || !/^[a-f0-9]+$/i.test(input.signature)) return false;
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(input.signature, 'hex'));
  } catch { return false; }
}
