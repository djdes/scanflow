import { getDb } from '../db';
import type { EventType, EventPayload } from '../../notifications/types';

export interface PendingNotification {
  id: number;
  user_id: number;
  event_type: EventType;
  payload_json: string;
  created_at: string;
  sent_at: string | null;
}

export const notificationRepo = {
  async enqueue(userId: number, eventType: EventType, payload: EventPayload): Promise<void> {
    await getDb()
      .prepare(
        `INSERT INTO notification_events (user_id, event_type, payload_json)
         VALUES (?, ?, ?)`,
      )
      .run(userId, eventType, JSON.stringify(payload));
  },

  // Returns rows created at or before `cutoffIso` for the given user that
  // haven't been sent yet. cutoffIso is taken at digest start so events
  // emitted DURING digest send roll into the next batch.
  async pendingForUser(userId: number, cutoffIso: string): Promise<PendingNotification[]> {
    return getDb()
      .prepare(
        `SELECT * FROM notification_events
         WHERE user_id = ? AND sent_at IS NULL AND created_at <= ?
         ORDER BY created_at`,
      )
      .all<PendingNotification>(userId, cutoffIso);
  },

  async markSent(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    await getDb()
      .prepare(`UPDATE notification_events SET sent_at = NOW() WHERE id IN (${placeholders})`)
      .run(...ids);
  },

  // Cleanup: remove sent rows older than 7 days. Called from digestWorker
  // once a day.
  async purgeOldSent(): Promise<number> {
    const result = await getDb()
      .prepare(`DELETE FROM notification_events WHERE sent_at IS NOT NULL AND sent_at < (NOW() - INTERVAL 7 DAY)`)
      .run();
    return result.changes;
  },

  // For tests / debug
  async countPending(userId: number): Promise<number> {
    const row = await getDb()
      .prepare(`SELECT COUNT(*) as cnt FROM notification_events WHERE user_id = ? AND sent_at IS NULL`)
      .get<{ cnt: number }>(userId);
    return row?.cnt ?? 0;
  },
};
