import { getDb } from '../database/db';
import { invoiceRepo } from '../database/repositories/invoiceRepo';
import { config } from '../config';
import { logger } from '../utils/logger';

/**
 * Loopback POST на /send-sber в контексте ВЛАДЕЛЬЦА накладной — переиспользуем
 * всю валидацию эндпоинта (проверенный поставщик, реквизиты плательщика,
 * строка платежа, вызов Sber API), не дублируя её.
 *
 * Правило, которое нельзя ослаблять: ключ — владельца накладной, а не «первого
 * админа»; иначе платёж создаётся от имени и со счёта другой компании.
 *
 * Отдельная проверка владельца подключения больше не нужна: подключение к Сберу
 * пер-тенантное, и у компании без своего подключения /send-sber вернёт
 * «Sber not connected» — автоотправка молча не сработает.
 *
 * Никогда не бросает: автоотправка не должна ронять конвейер обработки.
 */
export async function autoSendSberForInvoice(invoiceId: number): Promise<void> {
  try {
    const invoice = await invoiceRepo.getById(invoiceId);
    const ownerId = invoice?.owner_user_id ?? null;
    if (ownerId == null) {
      logger.warn('Auto-send Sber: у накладной нет владельца, пропуск', { invoiceId });
      return;
    }

    const row = await getDb()
      .prepare('SELECT api_key FROM users WHERE id = ?')
      .get<{ api_key: string }>(ownerId);
    const apiKey = row?.api_key;
    if (!apiKey) {
      logger.warn('Auto-send Sber: у владельца нет api_key', { invoiceId, ownerId });
      return;
    }

    const url = `http://127.0.0.1:${config.apiPort}/api/invoices/${invoiceId}/send-sber`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (res.ok) {
      const data = (await res.json().catch(() => ({}))) as { payment_number?: string };
      logger.info('Auto-sent to Sber', {
        invoiceId, ownerId, paymentNumber: data.payment_number ?? null,
      });
    } else {
      const text = await res.text().catch(() => '');
      logger.warn('Auto-send Sber rejected', {
        invoiceId, status: res.status, body: text.slice(0, 300),
      });
    }
  } catch (err) {
    logger.warn('Auto-send Sber error', { invoiceId, error: (err as Error).message });
  }
}
