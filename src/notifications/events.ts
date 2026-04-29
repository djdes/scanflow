import { logger } from '../utils/logger';
import { userRepo } from '../database/repositories/userRepo';
import { notificationRepo } from '../database/repositories/notificationRepo';
import { sendNotification, smtpConfigured } from '../utils/mailer';
import { renderRealtime } from './templates';
import { URGENT_EVENT_TYPES, type EventType, type EventPayload } from './types';

// Domain-event entry point. Routes the event according to the user's
// notify_mode + notify_events config. Never throws — failure is logged
// and swallowed (notifications must never break the main pipeline).
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
    if (!cfg.email) {
      logger.debug('notifications.emit: user has no email', { eventType, userId });
      return;
    }
    if (!cfg.notify_events.includes(eventType)) {
      logger.debug('notifications.emit: event disabled in config', { eventType, userId });
      return;
    }

    const isUrgent = URGENT_EVENT_TYPES.has(eventType);
    const sendNow = isUrgent || cfg.notify_mode === 'realtime';

    if (sendNow) {
      if (!smtpConfigured()) {
        logger.warn('notifications.emit: SMTP not configured, dropping urgent event', { eventType });
        return;
      }
      const { subject, html } = renderRealtime(eventType, payload);
      try {
        await sendNotification(cfg.email, subject, html);
      } catch (err) {
        logger.error('notifications.emit: send failed', {
          eventType,
          userId,
          error: (err as Error).message,
        });
      }
    } else {
      // Queue for digest worker
      notificationRepo.enqueue(userId, eventType, payload);
      logger.debug('notifications.emit: queued for digest', { eventType, userId });
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
