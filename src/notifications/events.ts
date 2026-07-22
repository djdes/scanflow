import { logger } from '../utils/logger';
import { userRepo } from '../database/repositories/userRepo';
import { invoiceRepo } from '../database/repositories/invoiceRepo';
import { sendInvoiceNotification } from './telegram/telegramNotifier';
import { sendMessage } from './telegram/telegramClient';
import { sendNotification as sendEmail, smtpConfigured } from '../utils/mailer';
import { renderRealtime } from './templates';
import { checkAndRecordSend, NOTIFY_HOURLY_CAP } from './rateLimit';
import { type EventType, type EventPayload } from './types';

// Domain-event entry point. Fans the event out to Telegram AND email — both are
// live: a user with `users.email` set and SMTP configured really does get mail
// (the 2026-07-14 storm arrived on both channels). Only the *digest* path is
// dead code.
//
// Every send passes the rate limiter first (see ./rateLimit.ts) — a hard cap on
// notifications per hour, backed by the DB so it survives process restarts.
//
// Never throws — failure is logged and swallowed (notifications must never
// break the main pipeline).
//
// triggeredByUserId: pass req.user?.id when in HTTP context. Background callers
// (file watcher, cron) pass null — the recipient is then the invoice's owner.
export async function emit(
  eventType: EventType,
  payload: EventPayload,
  triggeredByUserId: number | null,
): Promise<void> {
  try {
    // Накладная загружается ПЕРВОЙ: получатель выводится из неё.
    const invoice = await invoiceRepo.getById(payload.invoice_id);
    if (!invoice) {
      logger.debug('notifications.emit: invoice not found', { invoiceId: payload.invoice_id });
      return;
    }

    // Получатель — владелец накладной.
    //
    // Ключевое правило: накладная, У КОТОРОЙ ЕСТЬ владелец, никогда не
    // адресуется никому другому. Раньше здесь безусловно вызывался
    // firstUserId(), из-за чего события одной компании уходили в Telegram-бот
    // другой (инцидент 2026-07-22).
    //
    // Накладная БЕЗ владельца ничьей компании не принадлежит: так создаются
    // файлы, положенные прямо в inbox/ — у watcher нет пользовательского
    // контекста. Для неё откат допустим (инициатор, затем администратор
    // платформы) и кросс-тенантной доставкой не является — претендента на такую
    // накладную просто нет.
    const userId = invoice.owner_user_id ?? triggeredByUserId ?? (await userRepo.firstUserId());
    if (userId == null) {
      logger.debug('notifications.emit: no recipient, skipping', {
        eventType, invoiceId: payload.invoice_id,
      });
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

    // Circuit breaker. Checked after the config gates (a disabled event must not
    // burn quota) and before either channel, so it covers Telegram AND email.
    // Bounds the blast radius of ANY future loop that emits in a hot path.
    const throttle = await checkAndRecordSend(eventType, payload.invoice_id);
    if (!throttle.allow) {
      if (throttle.announce) {
        const mutedTg = await userRepo.getTelegramConfig(userId);
        if (mutedTg?.chat_id && mutedTg?.bot_token) {
          await sendMessage(
            mutedTg.bot_token,
            mutedTg.chat_id,
            `🔇 Уведомления приглушены на час.\n\n`
            + `За последний час их набралось ${throttle.sentInWindow} (лимит ${NOTIFY_HOURLY_CAP}) — `
            + `это похоже на сбой, а не на обычную работу. Загляните в логи.\n\n`
            + `Накладные продолжают обрабатываться как обычно — молчит только рассылка.`,
          ).catch(() => {});
        }
      }
      return;
    }

    // Telegram channel — send if configured. A missing TG config is no longer
    // an early-return: email below should still go through.
    const tg = await userRepo.getTelegramConfig(userId);
    if (tg && tg.chat_id && tg.bot_token) {
      await sendInvoiceNotification(
        { token: tg.bot_token, chat_id: tg.chat_id },
        invoice,
        eventType,
        payload,
      );
    } else {
      logger.debug('notifications.emit: telegram not configured', { eventType, userId });
    }

    // Email channel — parallel to Telegram, gated by the same notify_events
    // toggle (already checked above). Same mailer transport as registration
    // emails. Each render includes a link back to the invoice.
    if (cfg.email && smtpConfigured()) {
      try {
        const rendered = renderRealtime(eventType, payload);
        await sendEmail(cfg.email, rendered.subject, rendered.html);
      } catch (err) {
        logger.warn('notifications.emit: email failed', { eventType, error: (err as Error).message });
      }
    }
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
    // Single dispatch — emit() handles Telegram + email in parallel.
    await emit('elevated_prices', {
      invoice_id: inv.id,
      invoice_number: inv.invoice_number,
      supplier: inv.supplier,
      total_sum: inv.total_sum,
      elevated_items: elevated,
    }, null);
  } catch (err) {
    logger.error('emitElevatedPricesIfAny failed', { invoiceId, error: (err as Error).message });
  }
}

export async function notifySupplierExtractError(
  fileName: string,
  errorMessage: string,
  ownerUserId: number | null,
): Promise<void> {
  try {
    // ownerUserId обязателен и не имеет значения по умолчанию: молчание
    // безопаснее, чем доставка чужой компании. Отката к firstUserId() быть не должно.
    if (ownerUserId == null) {
      logger.debug('notifySupplierExtractError: no owner, skipping', { fileName });
      return;
    }
    const userId = ownerUserId;
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
