import { logger } from '../../utils/logger';
import { invoiceRepo, type Invoice } from '../../database/repositories/invoiceRepo';
import { sendMessage, editMessageText, MessageGoneError } from './telegramClient';
import { buildInvoiceThread, buildUrgentMessage, deriveEventState } from './telegramFormatter';
import { URGENT_EVENT_TYPES, type EventType, type EventPayload } from '../types';

interface TelegramConfig {
  token: string;
  chat_id: string;
}

// Top-level Telegram emission. Decides whether the event is urgent (separate
// message) or progress (thread edit), formats accordingly, and persists the
// telegram_message_id when a new thread is created.
//
// Never throws. All errors are logged and swallowed — notifications must
// never break the main pipeline.
export async function sendInvoiceNotification(
  cfg: TelegramConfig,
  invoice: Invoice,
  eventType: EventType,
  payload: EventPayload,
): Promise<void> {
  try {
    if (URGENT_EVENT_TYPES.has(eventType)) {
      // Urgent → separate standalone message. Don't touch invoice thread.
      const text = buildUrgentMessage(
        eventType as 'recognition_error' | 'suspicious_total',
        payload,
      );
      try {
        await sendMessage(cfg.token, cfg.chat_id, text);
      } catch (err) {
        logger.error('telegramNotifier: urgent send failed', {
          eventType,
          invoiceId: invoice.id,
          error: (err as Error).message,
        });
      }
      return;
    }

    // Progress event → edit (or create) the invoice thread message.
    const state = deriveEventState(invoice);
    const text = buildInvoiceThread(invoice, state);

    const existingMessageId = invoice.telegram_message_id ?? null;

    if (existingMessageId != null) {
      try {
        await editMessageText(cfg.token, cfg.chat_id, existingMessageId, text);
        return;
      } catch (err) {
        if (err instanceof MessageGoneError) {
          logger.warn('telegramNotifier: thread message gone, sending new one', {
            invoiceId: invoice.id,
            oldMessageId: existingMessageId,
          });
          // fall through to sendMessage below
        } else {
          logger.error('telegramNotifier: edit failed (non-recoverable)', {
            eventType,
            invoiceId: invoice.id,
            error: (err as Error).message,
          });
          return;
        }
      }
    }

    // Either no existing message_id, or edit failed with MessageGoneError.
    try {
      const newMessageId = await sendMessage(cfg.token, cfg.chat_id, text);
      invoiceRepo.setTelegramMessageId(invoice.id, newMessageId);
    } catch (err) {
      logger.error('telegramNotifier: thread send failed', {
        eventType,
        invoiceId: invoice.id,
        error: (err as Error).message,
      });
    }
  } catch (err) {
    // Defensive: this function must never throw.
    logger.error('telegramNotifier: unexpected error', {
      eventType,
      invoiceId: invoice.id,
      error: (err as Error).message,
    });
  }
}
