export class PaymentsDisabledError extends Error {
  readonly code = 'PAYMENTS_NOT_ENABLED';
  constructor() { super('Онлайн-оплата пока недоступна. Во время открытой беты сервис бесплатный.'); }
}

// Intentionally locked in code. Adding credentials or BILLING_ENABLED to .env
// cannot enable checkout. Activation requires a separate implementation of
// persistent orders, verified settlement, idempotency and fiscal documents.
export const robokassaGateway = {
  provider: 'robokassa' as const,
  enabled: false as const,
  createCheckout(): never { throw new PaymentsDisabledError(); },
  acceptResult(): never { throw new PaymentsDisabledError(); },
};
