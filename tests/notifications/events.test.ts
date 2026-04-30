import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/database/repositories/userRepo', () => ({
  userRepo: {
    firstUserId: vi.fn(() => 1),
    getNotifyConfig: vi.fn(),
    getTelegramConfig: vi.fn(),
  },
}));

vi.mock('../../src/database/repositories/invoiceRepo', () => ({
  invoiceRepo: {
    getById: vi.fn(),
  },
}));

vi.mock('../../src/notifications/telegram/telegramNotifier', () => ({
  sendInvoiceNotification: vi.fn(async () => {}),
}));

import { emit } from '../../src/notifications/events';
import { userRepo } from '../../src/database/repositories/userRepo';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';
import { sendInvoiceNotification } from '../../src/notifications/telegram/telegramNotifier';

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
const sampleInvoice = { id: 1, status: 'processed', telegram_message_id: null } as any;

describe('emit()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips when event is disabled in notify_events', async () => {
    (userRepo.getNotifyConfig as any).mockReturnValue({
      email: null, notify_mode: 'realtime',
      notify_events: ['sent_to_1c'],
    });
    (userRepo.getTelegramConfig as any).mockReturnValue({ chat_id: 'c', bot_token: 't' });
    (invoiceRepo.getById as any).mockReturnValue(sampleInvoice);

    await emit('photo_uploaded', samplePayload, 1);
    expect(sendInvoiceNotification).not.toHaveBeenCalled();
  });

  it('skips when telegram not configured (no chat_id)', async () => {
    (userRepo.getNotifyConfig as any).mockReturnValue({
      email: null, notify_mode: 'realtime', notify_events: ALL_EVENTS,
    });
    (userRepo.getTelegramConfig as any).mockReturnValue({ chat_id: null, bot_token: 't' });
    await emit('photo_uploaded', samplePayload, 1);
    expect(sendInvoiceNotification).not.toHaveBeenCalled();
  });

  it('skips when telegram not configured (no bot_token)', async () => {
    (userRepo.getNotifyConfig as any).mockReturnValue({
      email: null, notify_mode: 'realtime', notify_events: ALL_EVENTS,
    });
    (userRepo.getTelegramConfig as any).mockReturnValue({ chat_id: 'c', bot_token: null });
    await emit('photo_uploaded', samplePayload, 1);
    expect(sendInvoiceNotification).not.toHaveBeenCalled();
  });

  it('skips when invoice not found in DB', async () => {
    (userRepo.getNotifyConfig as any).mockReturnValue({
      email: null, notify_mode: 'realtime', notify_events: ALL_EVENTS,
    });
    (userRepo.getTelegramConfig as any).mockReturnValue({ chat_id: 'c', bot_token: 't' });
    (invoiceRepo.getById as any).mockReturnValue(undefined);

    await emit('photo_uploaded', samplePayload, 1);
    expect(sendInvoiceNotification).not.toHaveBeenCalled();
  });

  it('routes to Telegram when fully configured', async () => {
    (userRepo.getNotifyConfig as any).mockReturnValue({
      email: null, notify_mode: 'realtime', notify_events: ALL_EVENTS,
    });
    (userRepo.getTelegramConfig as any).mockReturnValue({ chat_id: 'c', bot_token: 't' });
    (invoiceRepo.getById as any).mockReturnValue(sampleInvoice);

    await emit('invoice_recognized', samplePayload, 1);
    expect(sendInvoiceNotification).toHaveBeenCalledOnce();
    const callArgs = (sendInvoiceNotification as any).mock.calls[0];
    expect(callArgs[0]).toEqual({ token: 't', chat_id: 'c' });
    expect(callArgs[1]).toBe(sampleInvoice);
    expect(callArgs[2]).toBe('invoice_recognized');
  });

  it('falls back to firstUserId when triggeredByUserId is null', async () => {
    (userRepo.firstUserId as any).mockReturnValue(42);
    (userRepo.getNotifyConfig as any).mockReturnValue({
      email: null, notify_mode: 'realtime', notify_events: ALL_EVENTS,
    });
    (userRepo.getTelegramConfig as any).mockReturnValue({ chat_id: 'c', bot_token: 't' });
    (invoiceRepo.getById as any).mockReturnValue(sampleInvoice);

    await emit('photo_uploaded', samplePayload, null);
    expect(userRepo.firstUserId).toHaveBeenCalled();
    expect(userRepo.getNotifyConfig).toHaveBeenCalledWith(42);
    expect(userRepo.getTelegramConfig).toHaveBeenCalledWith(42);
  });

  it('does not throw if telegramNotifier rejects', async () => {
    (userRepo.getNotifyConfig as any).mockReturnValue({
      email: null, notify_mode: 'realtime', notify_events: ALL_EVENTS,
    });
    (userRepo.getTelegramConfig as any).mockReturnValue({ chat_id: 'c', bot_token: 't' });
    (invoiceRepo.getById as any).mockReturnValue(sampleInvoice);
    (sendInvoiceNotification as any).mockRejectedValueOnce(new Error('boom'));

    await expect(emit('photo_uploaded', samplePayload, 1)).resolves.toBeUndefined();
  });
});
