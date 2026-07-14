import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory stand-in for the notification_sends table. Answers the two COUNT
// queries the limiter issues by looking at the SQL text: the "real sends" count
// excludes the muted marker (`event_type != ?`), the "already announced?" count
// selects it (`event_type = ?`).
interface Row { event_type: string; invoice_id: number | null }
let rows: Row[] = [];
let dbThrows = false;

const MUTED = '__muted__';

vi.mock('../../src/database/db', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      get: async (marker: string) => {
        if (dbThrows) throw new Error('pool is closed');
        const cnt = sql.includes('event_type != ?')
          ? rows.filter(r => r.event_type !== marker).length
          : rows.filter(r => r.event_type === marker).length;
        return { cnt };
      },
      run: async (eventType: string, invoiceId: number | null) => {
        if (dbThrows) throw new Error('pool is closed');
        rows.push({ event_type: eventType, invoice_id: invoiceId ?? null });
        return { changes: 1 };
      },
    }),
  }),
}));

import { checkAndRecordSend, NOTIFY_HOURLY_CAP } from '../../src/notifications/rateLimit';

beforeEach(() => {
  rows = [];
  dbThrows = false;
});

describe('notification rate limit', () => {
  it('allows sends below the cap and records each one', async () => {
    for (let i = 0; i < NOTIFY_HOURLY_CAP; i++) {
      const d = await checkAndRecordSend('photo_uploaded', i);
      expect(d.allow).toBe(true);
    }
    expect(rows).toHaveLength(NOTIFY_HOURLY_CAP);
  });

  it('blocks once the cap is reached', async () => {
    for (let i = 0; i < NOTIFY_HOURLY_CAP; i++) {
      await checkAndRecordSend('photo_uploaded', i);
    }
    const d = await checkAndRecordSend('photo_uploaded', 999);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.sentInWindow).toBe(NOTIFY_HOURLY_CAP);
  });

  it('announces the mute exactly once, then stays silent', async () => {
    for (let i = 0; i < NOTIFY_HOURLY_CAP; i++) {
      await checkAndRecordSend('photo_uploaded', i);
    }

    const first = await checkAndRecordSend('photo_uploaded', 100);
    expect(first.allow).toBe(false);
    if (!first.allow) expect(first.announce).toBe(true);

    // Every later drop in the same window must stay quiet — otherwise the
    // "muted" warning becomes the next flood.
    for (const id of [101, 102, 103]) {
      const next = await checkAndRecordSend('photo_uploaded', id);
      expect(next.allow).toBe(false);
      if (!next.allow) expect(next.announce).toBe(false);
    }

    expect(rows.filter(r => r.event_type === MUTED)).toHaveLength(1);
  });

  it('does not count the muted marker itself toward the cap', async () => {
    for (let i = 0; i < NOTIFY_HOURLY_CAP; i++) {
      await checkAndRecordSend('photo_uploaded', i);
    }
    await checkAndRecordSend('photo_uploaded', 100); // inserts the marker

    const d = await checkAndRecordSend('photo_uploaded', 101);
    expect(d.allow).toBe(false);
    // Still exactly the cap — the marker row must not inflate the count.
    if (!d.allow) expect(d.sentInWindow).toBe(NOTIFY_HOURLY_CAP);
  });

  it('fails OPEN when the DB errors — a broken limiter must not eat real alerts', async () => {
    dbThrows = true;
    const d = await checkAndRecordSend('recognition_error', 1);
    expect(d.allow).toBe(true);
  });
});
