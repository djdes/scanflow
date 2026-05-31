import { logger } from '../utils/logger';
import { userRepo } from '../database/repositories/userRepo';
import { invoiceRepo } from '../database/repositories/invoiceRepo';
import { sendInvoiceNotification } from './telegram/telegramNotifier';
import { sendMessage } from './telegram/telegramClient';
import { sendNotification as sendEmail, smtpConfigured } from '../utils/mailer';
import { renderRealtime } from './templates';
import { type EventType, type EventPayload } from './types';

// Domain-event entry point. Routes the event to Telegram (current channel).
// Email infrastructure remains in the codebase as dead code, but no events
// reach it anymore.
//
// Never throws — failure is logged and swallowed (notifications must never
// break the main pipeline).
//
// triggeredByUserId: pass req.user?.id when in HTTP context. When the
// caller is a background process (file watcher, cron), pass null —
// we'll use the first user as the recipient (single-user system).
export async function emit(
  eventType: EventType,
  payload: EventPayload,
  triggeredByUserId: number | null,
): Promise<void> {
  try {
    const userId = triggeredByUserId ?? (await userRepo.firstUserId());
    if (userId == null) {
      logger.debug('notifications.emit: no user, skipping', { eventType });
      return;
    }

    const cfg = await userRepo.getNotifyConfig(userId);
    if (!cfg) {
      logger.debug('notifications.emit: no config row', { eventType, userId });
      return;
    }
    if (!cfg.notify_events.includes(eventType)) {
      logger.debug('notifications.emit: event disabled in config', { eventType, userId });
      return;
    }

    const tg = await userRepo.getTelegramConfig(userId);
    if (!tg || !tg.chat_id || !tg.bot_token) {
      logger.debug('notifications.emit: telegram not configured', { eventType, userId });
      return;
    }

    const invoice = await invoiceRepo.getById(payload.invoice_id);
    if (!invoice) {
      logger.debug('notifications.emit: invoice not found', { invoiceId: payload.invoice_id });
      return;
    }

    await sendInvoiceNotification(
      { token: tg.bot_token, chat_id: tg.chat_id },
      invoice,
      eventType,
      payload,
    );
  } catch (err) {
    // Defensive: emit() must never throw. Even if the DB is locked or
    // userRepo blows up, the main pipeline continues.
    logger.error('notifications.emit: unexpected error', {
      eventType,
      error: (err as Error).message,
    });
  }
}

/**
 * Notify the user (Telegram) about a supplier-requisite recognition failure.
 * Separate from emit() because supplier-extract jobs have no invoice_id (emit
 * is invoice-coupled). Gated on the `recognition_error` toggle (on by default)
 * so it follows the user's "error notifications" preference. Never throws.
 */
/**
 * If the just-recognised invoice has any items priced >10% above the usual
 * (median) price for that 1C nomenclature, fire a dedicated `elevated_prices`
 * notification with the per-item details. Mirrors the threshold of the in-app
 * yellow zone (10–25%) and includes orange/red tiers too. Never throws.
 */
export async function emitElevatedPricesIfAny(invoiceId: number): Promise<void> {
  try {
    const inv = await invoiceRepo.getWithItems(invoiceId);
    if (!inv) return;
    const elevated = inv.items
      .map(it => {
        const median = it.median_price;
        const samples = it.median_samples ?? 0;
        const unitMatch = !!it.unit && !!it.median_price_unit && it.unit === it.median_price_unit;
        const price = typeof it.price === 'number' ? it.price : null;
        if (median == null || median <= 0 || samples < 3 || !unitMatch || price == null || price <= 0) return null;
        const dev = ((price - Number(median)) / Number(median)) * 100;
        if (dev <= 10) return null;
        return {
          name: it.mapped_name || it.original_name || '',
          unit: it.unit,
          price,
          median_price: Number(median),
          deviation_pct: dev,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (!elevated.length) return;
    const payload: EventPayload = {
      invoice_id: inv.id,
      invoice_number: inv.invoice_number,
      supplier: inv.supplier,
      total_sum: inv.total_sum,
      elevated_items: elevated,
    };
    // Telegram via the existing emit() pipeline (gated on notify_events).
    await emit('elevated_prices', payload, null);
    // Email (parallel channel) — same notify_events gate, sent only if the
    // user has an email AND the mailer has a working transport.
    await sendElevatedPricesEmail(payload);
  } catch (err) {
    logger.error('emitElevatedPricesIfAny failed', { invoiceId, error: (err as Error).message });
  }
}

async function sendElevatedPricesEmail(payload: EventPayload): Promise<void> {
  try {
    const userId = await userRepo.firstUserId();
    if (userId == null) return;
    const cfg = await userRepo.getNotifyConfig(userId);
    if (!cfg || !cfg.email) return;
    if (!cfg.notify_events.includes('elevated_prices')) return;
    if (!smtpConfigured()) {
      logger.debug('elevated_prices email skipped: no mail transport configured');
      return;
    }
    const rendered = renderRealtime('elevated_prices', payload);
    await sendEmail(cfg.email, rendered.subject, rendered.html);
  } catch (err) {
    logger.error('sendElevatedPricesEmail failed', { error: (err as Error).message });
  }
}

export async function notifySupplierExtractError(fileName: string, errorMessage: string): Promise<void> {
  try {
    const userId = await userRepo.firstUserId();
    if (userId == null) return;
    const cfg = await userRepo.getNotifyConfig(userId);
    if (!cfg || !cfg.notify_events.includes('recognition_error')) return;
    const tg = await userRepo.getTelegramConfig(userId);
    if (!tg || !tg.chat_id || !tg.bot_token) return;
    const text = [
      `🚨 Ошибка распознавания реквизитов`,
      `Файл: ${fileName || '—'}`,
      ``,
      `Причина: ${errorMessage || 'без описания'}`,
    ].join('\n');
    await sendMessage(tg.bot_token, tg.chat_id, text);
  } catch (err) {
    logger.error('notifySupplierExtractError failed', { error: (err as Error).message });
  }
}
