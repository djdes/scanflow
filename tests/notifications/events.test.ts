import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the modules events.ts depends on. We're unit-testing the routing
// logic, not the SMTP transport or the DB.
vi.mock('../../src/database/repositories/userRepo', () => ({
  userRepo: {
    firstUserId: vi.fn(() => 1),
    getNotifyConfig: vi.fn(),
  },
}));

vi.mock('../../src/database/repositories/notificationRepo', () => ({
  notificationRepo: {
    enqueue: vi.fn(),
  },
}));

vi.mock('../../src/utils/mailer', () => ({
  sendNotification: vi.fn(async () => {}),
  smtpConfigured: vi.fn(() => true),
}));

import { emit } from '../../src/notifications/events';
import { userRepo } from '../../src/database/repositories/userRepo';
import { notificationRepo } from '../../src/database/repositories/notificationRepo';
import { sendNotification } from '../../src/utils/mailer';

const ALL_EVENTS = [
  'photo_uploaded',
  'invoice_recognized',
  'recognition_error',
  'suspicious_total',
  'invoice_edited',
  'approved_for_1c',
  'sent_to_1c',
] as const;

const samplePayload = { invoice_id: 1, invoice_number: '85', supplier: 'X', total_sum: 1000 };

describe('emit()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing if user has no email', async () => {
    (userRepo.getNotifyConfig as any).mockReturnValue({
      email: null, notify_mode: 'realtime', notify_events: ALL_EVENTS,
    });
    await emit('photo_uploaded', samplePayload, 1);
    expect(sendNotification).not.toHaveBeenCalled();
    expect(notificationRepo.enqueue).not.toHaveBeenCalled();
  });

  it('does nothing if event is disabled in config', async () => {
    (userRepo.getNotifyConfig as any).mockReturnValue({
      email: 'a@b.c', notify_mode: 'realtime',
      notify_events: ['sent_to_1c'], // photo_uploaded NOT in the list
    });
    await emit('photo_uploaded', samplePayload, 1);
    expect(sendNotification).not.toHaveBeenCalled();
    expect(notificationRepo.enqueue).not.toHaveBeenCalled();
  });

  it('sends immediately in realtime mode for non-urgent event', async () => {
    (userRepo.getNotifyConfig as any).mockReturnValue({
      email: 'a@b.c', notify_mode: 'realtime', notify_events: ALL_EVENTS,
    });
    await emit('photo_uploaded', samplePayload, 1);
    expect(sendNotification).toHaveBeenCalledOnce();
    expect(notificationRepo.enqueue).not.toHaveBeenCalled();
  });

  it('queues non-urgent event in digest mode', async () => {
    (userRepo.getNotifyConfig as any).mockReturnValue({
      email: 'a@b.c', notify_mode: 'digest_hourly', notify_events: ALL_EVENTS,
    });
    await emit('photo_uploaded', samplePayload, 1);
    expect(sendNotification).not.toHaveBeenCalled();
    expect(notificationRepo.enqueue).toHaveBeenCalledOnce();
    expect(notificationRepo.enqueue).toHaveBeenCalledWith(1, 'photo_uploaded', samplePayload);
  });

  it('sends urgent event immediately even in digest_daily mode', async () => {
    (userRepo.getNotifyConfig as any).mockReturnValue({
      email: 'a@b.c', notify_mode: 'digest_daily', notify_events: ALL_EVENTS,
    });
    await emit('recognition_error', { ...samplePayload, error_message: 'oops' }, 1);
    expect(sendNotification).toHaveBeenCalledOnce();
    expect(notificationRepo.enqueue).not.toHaveBeenCalled();
  });

  it('sends suspicious_total urgently even in digest_hourly mode', async () => {
    (userRepo.getNotifyConfig as any).mockReturnValue({
      email: 'a@b.c', notify_mode: 'digest_hourly', notify_events: ALL_EVENTS,
    });
    await emit('suspicious_total', samplePayload, 1);
    expect(sendNotification).toHaveBeenCalledOnce();
    expect(notificationRepo.enqueue).not.toHaveBeenCalled();
  });

  it('falls back to firstUserId when triggeredByUserId is null', async () => {
    (userRepo.firstUserId as any).mockReturnValue(42);
    (userRepo.getNotifyConfig as any).mockReturnValue({
      email: 'a@b.c', notify_mode: 'realtime', notify_events: ALL_EVENTS,
    });
    await emit('photo_uploaded', samplePayload, null);
    expect(userRepo.firstUserId).toHaveBeenCalled();
    expect(userRepo.getNotifyConfig).toHaveBeenCalledWith(42);
  });

  it('does not throw when sendNotification rejects', async () => {
    (userRepo.getNotifyConfig as any).mockReturnValue({
      email: 'a@b.c', notify_mode: 'realtime', notify_events: ALL_EVENTS,
    });
    (sendNotification as any).mockRejectedValueOnce(new Error('SMTP down'));
    // Must not throw
    await expect(emit('photo_uploaded', samplePayload, 1)).resolves.toBeUndefined();
  });
});
