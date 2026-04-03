import { getDb } from '../database/db';
import { invoiceRepo } from '../database/repositories/invoiceRepo';
import { logger } from '../utils/logger';

interface WebhookConfig {
  url: string;
  enabled: number;
  auth_token: string | null;
}

function getWebhookConfig(): WebhookConfig | null {
  const db = getDb();
  const config = db.prepare('SELECT * FROM webhook_config WHERE id = 1').get() as WebhookConfig | undefined;
  if (!config || !config.enabled || !config.url) return null;
  return config;
}

export async function sendToWebhook(invoiceId: number): Promise<boolean> {
  const config = getWebhookConfig();
  if (!config) {
    logger.debug('Webhook not configured or disabled');
    return false;
  }

  const invoice = invoiceRepo.getWithItems(invoiceId);
  if (!invoice) {
    logger.warn('Invoice not found for webhook', { invoiceId });
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

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.auth_token) {
      headers['Authorization'] = `Bearer ${config.auth_token}`;
    }

    logger.info('Sending invoice to 1C webhook', { invoiceId, url: config.url });

    const response = await fetch(config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });

    if (response.ok) {
      invoiceRepo.markSent(invoiceId);
      logger.info('Invoice sent to 1C successfully', { invoiceId });
      return true;
    }

    logger.warn('1C webhook returned error', {
      invoiceId,
      status: response.status,
      statusText: response.statusText,
    });
    return false;
  } catch (err) {
    logger.error('Failed to send to 1C webhook', {
      invoiceId,
      error: (err as Error).message,
    });
    return false;
  }
}
