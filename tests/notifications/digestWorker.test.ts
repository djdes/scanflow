import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// We test runTickForMode directly via __testInternals. To do that, the
// worker imports getDb / notificationRepo / mailer — we mock those.
let memDb: Database.Database;

vi.mock('../../src/database/db', () => ({
  getDb: () => memDb,
}));

vi.mock('../../src/utils/mailer', () => ({
  sendNotification: vi.fn(async () => {}),
  smtpConfigured: vi.fn(() => true),
}));

import { __testInternals } from '../../src/notifications/digestWorker';
import { sendNotification, smtpConfigured } from '../../src/utils/mailer';

function setupDb(): void {
  memDb = new Database(':memory:');
  memDb.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT,
      notify_mode TEXT NOT NULL DEFAULT 'digest_hourly'
    );
    CREATE TABLE notification_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at TEXT
    );
  `);
}

describe('runTickForMode', () => {
  beforeEach(() => {
    setupDb();
    vi.clearAllMocks();
    (smtpConfigured as any).mockReturnValue(true);
  });

  it('does not send if no users in this mode', async () => {
    memDb.prepare(`INSERT INTO users (email, notify_mode) VALUES ('a@b.c', 'realtime')`).run();
    await __testInternals.runTickForMode('digest_hourly');
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('does not send when user has no pending events', async () => {
    memDb.prepare(`INSERT INTO users (id, email, notify_mode) VALUES (1, 'a@b.c', 'digest_hourly')`).run();
    await __testInternals.runTickForMode('digest_hourly');
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('sends digest with all pending events and marks them sent', async () => {
    memDb.prepare(`INSERT INTO users (id, email, notify_mode) VALUES (1, 'a@b.c', 'digest_hourly')`).run();
    const payload = JSON.stringify({ invoice_id: 1, invoice_number: '85', supplier: 'X', total_sum: 1000 });
    memDb.prepare(`INSERT INTO notification_events (user_id, event_type, payload_json) VALUES (1, 'photo_uploaded', ?)`).run(payload);
    memDb.prepare(`INSERT INTO notification_events (user_id, event_type, payload_json) VALUES (1, 'sent_to_1c', ?)`).run(payload);

    await __testInternals.runTickForMode('digest_hourly');
    expect(sendNotification).toHaveBeenCalledOnce();
    const callArgs = (sendNotification as any).mock.calls[0];
    expect(callArgs[0]).toBe('a@b.c');
    expect(callArgs[1]).toContain('Дайджест');
    expect(callArgs[2]).toContain('Фото загружено');

    const remaining = memDb.prepare(`SELECT COUNT(*) as cnt FROM notification_events WHERE sent_at IS NULL`).get() as { cnt: number };
    expect(remaining.cnt).toBe(0);
  });

  it('does NOT mark events sent if smtp send throws', async () => {
    memDb.prepare(`INSERT INTO users (id, email, notify_mode) VALUES (1, 'a@b.c', 'digest_hourly')`).run();
    memDb.prepare(`INSERT INTO notification_events (user_id, event_type, payload_json) VALUES (1, 'photo_uploaded', '{"invoice_id":1}')`).run();
    (sendNotification as any).mockRejectedValueOnce(new Error('SMTP down'));

    await __testInternals.runTickForMode('digest_hourly');
    const remaining = memDb.prepare(`SELECT COUNT(*) as cnt FROM notification_events WHERE sent_at IS NULL`).get() as { cnt: number };
    expect(remaining.cnt).toBe(1);
  });

  it('skips entire tick if SMTP not configured', async () => {
    (smtpConfigured as any).mockReturnValue(false);
    memDb.prepare(`INSERT INTO users (id, email, notify_mode) VALUES (1, 'a@b.c', 'digest_hourly')`).run();
    memDb.prepare(`INSERT INTO notification_events (user_id, event_type, payload_json) VALUES (1, 'photo_uploaded', '{"invoice_id":1}')`).run();
    await __testInternals.runTickForMode('digest_hourly');
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('processes multiple users independently', async () => {
    memDb.prepare(`INSERT INTO users (id, email, notify_mode) VALUES (1, 'a@b.c', 'digest_hourly')`).run();
    memDb.prepare(`INSERT INTO users (id, email, notify_mode) VALUES (2, 'd@e.f', 'digest_hourly')`).run();
    memDb.prepare(`INSERT INTO notification_events (user_id, event_type, payload_json) VALUES (1, 'photo_uploaded', '{"invoice_id":1}')`).run();
    memDb.prepare(`INSERT INTO notification_events (user_id, event_type, payload_json) VALUES (2, 'sent_to_1c', '{"invoice_id":2}')`).run();
    await __testInternals.runTickForMode('digest_hourly');
    expect(sendNotification).toHaveBeenCalledTimes(2);
  });
});
