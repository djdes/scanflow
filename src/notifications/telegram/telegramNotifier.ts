import { logger } from '../../utils/logger';
import { invoiceRepo, type Invoice } from '../../database/repositories/invoiceRepo';
import { sendMessage, editMessageText, MessageGoneError } from './telegramClient';
import { buildInvoiceThread, buildUrgentMessage, deriveEventState } from './telegramFormatter';
import { parseValidChatIds } from './chatIds';
import { URGENT_EVENT_TYPES, type EventType, type EventPayload } from '../types';

interface TelegramConfig {
  token: string;
  /** Один id или несколько через запятую — разбирается parseValidChatIds. */
  chat_id: string;
}

// Top-level Telegram emission. Decides whether the event is urgent (separate
// message) or progress (thread edit), formats accordingly, and persists the
// per-chat message id when a new thread is created.
//
// Рассылка идёт во ВСЕ настроенные чаты. Прогресс по накладной показывается
// одним редактируемым сообщением, а Telegram адресует его парой
// (chat_id, message_id) — в каждом чате id свой, поэтому пары лежат в
// invoice_telegram_messages, а не в одной колонке invoices.telegram_message_id.
//
// Never throws. All errors are logged and swallowed — notifications must
// never break the main pipeline. Ошибка по ОДНОМУ чату не мешает остальным:
// бота могли выкинуть из одной группы, это не повод лишать уведомления всех.
export async function sendInvoiceNotification(
  cfg: TelegramConfig,
  invoice: Invoice,
  eventType: EventType,
  payload: EventPayload,
): Promise<void> {
  try {
    const chatIds = parseValidChatIds(cfg.chat_id);
    if (chatIds.length === 0) {
      logger.debug('telegramNotifier: no valid chat ids configured', { invoiceId: invoice.id });
      return;
    }

    if (URGENT_EVENT_TYPES.has(eventType)) {
      // Urgent → separate standalone message. Don't touch invoice thread.
      const text = buildUrgentMessage(
        eventType as 'recognition_error' | 'suspicious_total' | 'elevated_prices' | 'sber_payment_overdue',
        payload,
      );
      // Последовательно, а не Promise.all: у Telegram лимиты на бота, а чатов
      // единицы — выигрыш от параллельности нулевой, риск словить 429 реальный.
      for (const chatId of chatIds) {
        try {
          await sendMessage(cfg.token, chatId, text);
        } catch (err) {
          logger.error('telegramNotifier: urgent send failed', {
            eventType,
            invoiceId: invoice.id,
            chatId,
            error: (err as Error).message,
          });
        }
      }
      return;
    }

    // Progress event → edit (or create) the invoice thread message in each chat.
    const state = deriveEventState(invoice);
    const text = buildInvoiceThread(invoice, state);
    const existing = await invoiceRepo.getTelegramMessageIds(invoice.id);

    for (const chatId of chatIds) {
      await sendThreadToChat(cfg.token, chatId, invoice, eventType, text, existing.get(chatId) ?? null);
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

/**
 * Пузырь накладной в ОДНОМ чате: правим существующее сообщение, а если его нет
 * или оно удалено — шлём новое и запоминаем пару. Никогда не бросает: сбой в
 * одном чате не должен обрывать обход остальных.
 */
async function sendThreadToChat(
  token: string,
  chatId: string,
  invoice: Invoice,
  eventType: EventType,
  text: string,
  existingMessageId: number | null,
): Promise<void> {
  if (existingMessageId != null) {
    try {
      await editMessageText(token, chatId, existingMessageId, text);
      return;
    } catch (err) {
      if (err instanceof MessageGoneError) {
        logger.warn('telegramNotifier: thread message gone, sending new one', {
          invoiceId: invoice.id,
          chatId,
          oldMessageId: existingMessageId,
        });
        // fall through to sendMessage below
      } else {
        logger.error('telegramNotifier: edit failed (non-recoverable)', {
          eventType,
          invoiceId: invoice.id,
          chatId,
          error: (err as Error).message,
        });
        return;
      }
    }
  }

  // Either no existing message_id for this chat, or edit failed with MessageGoneError.
  try {
    const newMessageId = await sendMessage(token, chatId, text);
    // Must await: a fire-and-forget rejection escapes this try/catch and
    // surfaces as an unhandledRejection (which pages the operator via
    // sendErrorEmail), violating this module's never-throw contract.
    await invoiceRepo.setTelegramMessageIdForChat(invoice.id, chatId, newMessageId);
  } catch (err) {
    logger.error('telegramNotifier: thread send failed', {
      eventType,
      invoiceId: invoice.id,
      chatId,
      error: (err as Error).message,
    });
  }
}
