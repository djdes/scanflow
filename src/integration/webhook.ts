import { invoiceRepo } from '../database/repositories/invoiceRepo';
import { webhookConfigRepo, WebhookConfig } from '../database/repositories/webhookConfigRepo';
import { logger } from '../utils/logger';
import { emit as emitNotification } from '../notifications/events';
import { logIntegrationEvent } from './integrationLog';

async function getWebhookConfig(ownerUserId: number): Promise<WebhookConfig | null> {
  const config = await webhookConfigRepo.get(ownerUserId);
  if (!config || !config.enabled || !config.url) return null;
  return config;
}

export async function sendToWebhook(invoiceId: number): Promise<boolean> {
  // Накладную читаем ПЕРВОЙ: настройка вебхука пер-тенантная, и без владельца
  // накладной непонятно, в чью 1С её вообще отправлять. -1 = «владельца нет»,
  // такой компании не существует, поэтому вебхук просто не сработает.
  const invoice = await invoiceRepo.getWithItems(invoiceId);
  if (!invoice) {
    logger.warn('Invoice not found for webhook', { invoiceId });
    return false;
  }

  const config = await getWebhookConfig(invoice.owner_user_id ?? -1);
  if (!config) {
    logger.debug('Webhook not configured or disabled');
    return false;
  }

  const payload = {
    invoice_id: invoice.id,
    invoice_number: invoice.invoice_number,
    invoice_date: invoice.invoice_date,
    invoice_type: invoice.invoice_type,
    supplier: invoice.supplier,
    supplier_inn: invoice.supplier_inn,
    supplier_bik: invoice.supplier_bik,
    supplier_account: invoice.supplier_account,
    supplier_corr_account: invoice.supplier_corr_account,
    supplier_address: invoice.supplier_address,
    total_sum: invoice.total_sum,
    vat_sum: invoice.vat_sum,
    items: invoice.items.map(item => ({
      name: item.original_name,
      mapped_name: item.mapped_name,
      quantity: item.quantity,
      unit: item.unit,
      price: item.price,
      total: item.total,
      vat_rate: item.vat_rate,
    })),
  };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.auth_token) {
    headers['Authorization'] = `Bearer ${config.auth_token}`;
  }

  // Retry on transient failures (network / 5xx / timeouts). 4xx responses are
  // client errors — not worth retrying, they'll keep failing. Exponential
  // backoff: 1s, 3s, 8s. Total worst-case wait: ~12s + 3 * request timeout.
  const MAX_ATTEMPTS = 3;
  const BACKOFF_MS = [1000, 3000, 8000];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      logger.info('Sending invoice to 1C webhook', { invoiceId, url: config.url, attempt });

      const response = await fetch(config.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });

      if (response.ok) {
        // Capture pre-state BEFORE markSent so we can suppress the notification
        // when the invoice was already sent (otherwise a webhook retry, OR a
        // webhook + 1С /confirm racing on the same invoice, fires two emails).
        const before = await invoiceRepo.getById(invoiceId);
        const wasAlreadySent = before?.sent_at != null;

        await invoiceRepo.markSent(invoiceId);

        if (!wasAlreadySent && before) {
          emitNotification('sent_to_1c', {
            invoice_id: before.id,
            invoice_number: before.invoice_number,
            supplier: before.supplier,
            total_sum: before.total_sum,
          }, null).catch(() => {});
        }
        logger.info('Invoice sent to 1C successfully', { invoiceId, attempt });
        void logIntegrationEvent({
          integration: 'webhook', event_type: 'webhook_sent', invoice_id: invoiceId,
          summary: `Вебхук по накладной №${invoice.invoice_number ?? invoiceId} отправлен (HTTP ${response.status})`,
        });
        return true;
      }

      // Don't retry client errors — 401/403/404/422/etc. are not transient.
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        logger.warn('1C webhook returned non-retryable error', {
          invoiceId,
          status: response.status,
          statusText: response.statusText,
        });
        void logIntegrationEvent({
          integration: 'webhook', event_type: 'webhook_failed', status: 'error', invoice_id: invoiceId,
          summary: `Ошибка вебхука по накладной №${invoice.invoice_number ?? invoiceId} (HTTP ${response.status})`,
        });
        return false;
      }

      logger.warn('1C webhook returned retryable error', {
        invoiceId,
        status: response.status,
        statusText: response.statusText,
        attempt,
      });
    } catch (err) {
      logger.warn('1C webhook request failed', {
        invoiceId,
        error: (err as Error).message,
        attempt,
      });
    }

    if (attempt < MAX_ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, BACKOFF_MS[attempt - 1]));
    }
  }

  logger.error('Failed to send to 1C webhook after all retries', { invoiceId, attempts: MAX_ATTEMPTS });
  void logIntegrationEvent({
    integration: 'webhook', event_type: 'webhook_failed', status: 'error', invoice_id: invoiceId,
    summary: `Не удалось отправить вебхук по накладной №${invoice.invoice_number ?? invoiceId} (${MAX_ATTEMPTS} попыток)`,
  });
  return false;
}
