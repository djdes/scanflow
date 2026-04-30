import { logger } from '../utils/logger';
import { userRepo } from '../database/repositories/userRepo';
import { invoiceRepo } from '../database/repositories/invoiceRepo';
import { sendInvoiceNotification } from './telegram/telegramNotifier';
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
    const userId = triggeredByUserId ?? userRepo.firstUserId();
    if (userId == null) {
      logger.debug('notifications.emit: no user, skipping', { eventType });
      return;
    }

    const cfg = userRepo.getNotifyConfig(userId);
    if (!cfg) {
      logger.debug('notifications.emit: no config row', { eventType, userId });
      return;
    }
    if (!cfg.notify_events.includes(eventType)) {
      logger.debug('notifications.emit: event disabled in config', { eventType, userId });
      return;
    }

    const tg = userRepo.getTelegramConfig(userId);
    if (!tg || !tg.chat_id || !tg.bot_token) {
      logger.debug('notifications.emit: telegram not configured', { eventType, userId });
      return;
    }

    const invoice = invoiceRepo.getById(payload.invoice_id);
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
