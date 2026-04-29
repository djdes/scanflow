import cron, { type ScheduledTask } from 'node-cron';
import { logger } from '../utils/logger';
import { getDb } from '../database/db';
import { notificationRepo } from '../database/repositories/notificationRepo';
import { sendNotification, smtpConfigured } from '../utils/mailer';
import { renderDigest, type DigestGroup } from './templates';
import type { EventType, NotifyMode } from './types';

interface UserDigestRow {
  id: number;
  email: string | null;
  notify_mode: string;
}

// Build the digest for a single user in a single mode tick. Returns the
// number of events sent (0 means nothing to send).
async function sendDigestForUser(user: UserDigestRow, cutoffIso: string): Promise<number> {
  if (!user.email) return 0;
  const pending = notificationRepo.pendingForUser(user.id, cutoffIso);
  if (pending.length === 0) return 0;

  // Group by event_type, preserving insertion order across types
  const seen = new Set<EventType>();
  const groups: DigestGroup[] = [];
  for (const ev of pending) {
    const evt = ev.event_type as EventType;
    if (!seen.has(evt)) {
      seen.add(evt);
      groups.push({ event_type: evt, events: [] });
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(ev.payload_json);
    } catch {
      payload = { invoice_id: -1 };
    }
    const group = groups.find(g => g.event_type === evt)!;
    group.events.push({
      payload: payload as DigestGroup['events'][number]['payload'],
      created_at: ev.created_at,
    });
  }

  const { subject, html } = renderDigest(groups);
  try {
    await sendNotification(user.email, subject, html);
    notificationRepo.markSent(pending.map(p => p.id));
    return pending.length;
  } catch (err) {
    logger.error('digestWorker: send failed for user', {
      userId: user.id,
      error: (err as Error).message,
    });
    return 0; // leave events unsent; next tick retries
  }
}

// Pulls users with the given notify_mode and runs sendDigestForUser
// for each. Cutoff = now() at the start so events emitted DURING the
// tick roll into the next batch.
async function runTickForMode(mode: NotifyMode): Promise<void> {
  if (!smtpConfigured()) {
    logger.debug('digestWorker: SMTP not configured, skipping tick', { mode });
    return;
  }
  const cutoffIso = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const users = getDb()
    .prepare(`SELECT id, email, notify_mode FROM users WHERE notify_mode = ?`)
    .all(mode) as UserDigestRow[];

  let totalSent = 0;
  for (const user of users) {
    totalSent += await sendDigestForUser(user, cutoffIso);
  }
  logger.info('digestWorker: tick done', { mode, users: users.length, totalSent });
}

// Cron handles. Started by startDigestWorker, stopped by stopDigestWorker.
const handles: ScheduledTask[] = [];

// Start cron jobs. Call this once at app startup.
//   - hourly digest fires at minute 0 of hours 09..18 (Europe/Moscow)
//   - daily digest fires at 19:00 Europe/Moscow
//   - cleanup of sent rows older than 7 days runs at 03:30 daily
export function startDigestWorker(): void {
  // Hourly: minute 0, hours 9–18, all days, MSK
  handles.push(
    cron.schedule(
      '0 9-18 * * *',
      () => { runTickForMode('digest_hourly').catch(err => logger.error('digest_hourly tick failed', { error: (err as Error).message })); },
      { timezone: 'Europe/Moscow' },
    ),
  );

  // Daily: 19:00 MSK
  handles.push(
    cron.schedule(
      '0 19 * * *',
      () => { runTickForMode('digest_daily').catch(err => logger.error('digest_daily tick failed', { error: (err as Error).message })); },
      { timezone: 'Europe/Moscow' },
    ),
  );

  // Cleanup: 03:30 every day
  handles.push(
    cron.schedule(
      '30 3 * * *',
      () => {
        try {
          const removed = notificationRepo.purgeOldSent();
          if (removed > 0) logger.info('digestWorker: purged old sent events', { removed });
        } catch (err) {
          logger.error('digestWorker: purge failed', { error: (err as Error).message });
        }
      },
      { timezone: 'Europe/Moscow' },
    ),
  );

  logger.info('digestWorker: started (hourly @ 9-18 MSK, daily @ 19 MSK, purge @ 3:30 MSK)');
}

// For tests: drop schedules.
export function stopDigestWorker(): void {
  for (const h of handles) h.stop();
  handles.length = 0;
}

// Exposed for tests — callable directly without cron.
export const __testInternals = { runTickForMode, sendDigestForUser };
