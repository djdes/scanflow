import { getDb } from '../database/db';
import { logger } from '../utils/logger';

/**
 * Ceiling on notifications per rolling hour, across all events and channels.
 * A busy human day is a few dozen invoices spread over hours; a burst above this
 * is a bug looping, not someone working. Tuned to be generous — the point is to
 * cap a runaway, not to ration normal use.
 */
export const NOTIFY_HOURLY_CAP = 30;

const WINDOW_MINUTES = 60;

/**
 * Sentinel row recording that we already warned the user we're muting. Keeps the
 * "muted" message itself from becoming the next flood.
 */
const MUTED_MARKER = '__muted__';

export type ThrottleDecision =
  | { allow: true }
  | { allow: false; announce: boolean; sentInWindow: number };

/**
 * Decide whether this notification may go out, and record it if so.
 *
 * The counter is deliberately DB-backed, not in-memory. In the 2026-07-14 storm
 * PM2 killed and restarted the process every 90 seconds, so a process-local
 * counter would have reset before it ever reached a limit — it would have caught
 * nothing. Surviving restarts is the entire point of this breaker.
 *
 * Never throws: on a DB error we fail OPEN (allow the send). A broken limiter
 * must not silently swallow real notifications.
 */
export async function checkAndRecordSend(
  eventType: string,
  invoiceId: number | null,
): Promise<ThrottleDecision> {
  try {
    const db = getDb();

    const sent = await db.prepare(
      `SELECT COUNT(*) AS cnt FROM notification_sends
        WHERE created_at > (NOW() - INTERVAL ${WINDOW_MINUTES} MINUTE)
          AND event_type != ?`
    ).get<{ cnt: number }>(MUTED_MARKER);
    const sentInWindow = Number(sent?.cnt ?? 0);

    if (sentInWindow < NOTIFY_HOURLY_CAP) {
      await db.prepare(
        'INSERT INTO notification_sends (event_type, invoice_id) VALUES (?, ?)'
      ).run(eventType, invoiceId);
      return { allow: true };
    }

    // Over the cap. Announce once per window, then go quiet.
    const marker = await db.prepare(
      `SELECT COUNT(*) AS cnt FROM notification_sends
        WHERE event_type = ? AND created_at > (NOW() - INTERVAL ${WINDOW_MINUTES} MINUTE)`
    ).get<{ cnt: number }>(MUTED_MARKER);
    const announce = Number(marker?.cnt ?? 0) === 0;
    if (announce) {
      await db.prepare(
        'INSERT INTO notification_sends (event_type, invoice_id) VALUES (?, NULL)'
      ).run(MUTED_MARKER, null);
    }

    logger.error('Notification rate limit hit — muting for the rest of the window', {
      eventType, invoiceId, sentInWindow, cap: NOTIFY_HOURLY_CAP,
    });
    return { allow: false, announce, sentInWindow };
  } catch (err) {
    logger.error('Notification rate limit check failed — allowing the send', {
      eventType, error: (err as Error).message,
    });
    return { allow: true };
  }
}

/** Drop send-log rows older than a day; the window only ever looks back an hour. */
export async function pruneSendLog(): Promise<number> {
  const res = await getDb()
    .prepare('DELETE FROM notification_sends WHERE created_at < (NOW() - INTERVAL 1 DAY)')
    .run();
  return res.changes;
}
