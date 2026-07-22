import { getDb } from '../database/db';
import { invoiceRepo } from '../database/repositories/invoiceRepo';
import { userRepo } from '../database/repositories/userRepo';
import { config } from '../config';
import { logger } from '../utils/logger';

/**
 * Владелец единственного подключения к Сберу.
 *
 * ВРЕМЕННО: пока `sber_tokens` — одна строка на всю установку (CHECK (id = 1)),
 * подключение принадлежит начальному админу. Этап 2 мультитенантности добавит
 * `sber_tokens.owner_user_id`, и эта функция станет чтением этой колонки.
 *
 * Это единственное оставшееся законное использование firstUserId() вне
 * бутстрапа, и оно только ОГРАНИЧИВАЕТ отправку, а не расширяет её.
 */
async function sberConnectionOwnerId(): Promise<number | null> {
  return userRepo.firstUserId();
}

/**
 * Loopback POST на /send-sber в контексте ВЛАДЕЛЬЦА накладной — переиспользуем
 * всю валидацию эндпоинта (проверенный поставщик, реквизиты плательщика,
 * строка платежа, вызов Sber API), не дублируя её.
 *
 * Два правила, которые нельзя ослаблять:
 *  1. Ключ — владельца накладной, а не «первого админа»; иначе платёж создаётся
 *     от имени и со счёта другой компании.
 *  2. Пока подключение к Сберу одно на установку, автоотправка разрешена только
 *     компании-владельцу этого подключения; остальные пропускаются.
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

    const connectionOwnerId = await sberConnectionOwnerId();
    if (connectionOwnerId == null || connectionOwnerId !== ownerId) {
      logger.warn('Auto-send Sber: владелец накладной не владеет подключением, пропуск', {
        invoiceId, ownerId, connectionOwnerId,
      });
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
