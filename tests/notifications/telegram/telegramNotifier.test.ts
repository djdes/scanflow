import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../src/notifications/telegram/telegramClient', () => ({
  sendMessage: vi.fn(async () => 999),
  editMessageText: vi.fn(async () => {}),
  MessageGoneError: class MessageGoneError extends Error {
    constructor(d: string) { super(d); this.name = 'MessageGoneError'; }
  },
}));

vi.mock('../../../src/database/repositories/invoiceRepo', () => ({
  invoiceRepo: {
    setTelegramMessageId: vi.fn(),
  },
}));

import { sendInvoiceNotification } from '../../../src/notifications/telegram/telegramNotifier';
import { sendMessage, editMessageText, MessageGoneError } from '../../../src/notifications/telegram/telegramClient';
import { invoiceRepo } from '../../../src/database/repositories/invoiceRepo';
import type { Invoice } from '../../../src/database/repositories/invoiceRepo';

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 85,
    file_name: 'photo.jpg',
    file_path: '/data/photo.jpg',
    invoice_number: '85',
    invoice_date: null,
    supplier: 'X',
    total_sum: 1000,
    invoice_type: null,
    supplier_inn: null,
    supplier_bik: null,
    supplier_account: null,
    supplier_corr_account: null,
    supplier_address: null,
    vat_sum: null,
    raw_text: null,
    status: 'processed',
    ocr_engine: null,
    error_message: null,
    created_at: '2026-04-29 10:00:00',
    sent_at: null,
    approved_for_1c: 0,
    approved_at: null,
    file_hash: null,
    items_total_mismatch: 0,
    telegram_message_id: null,
    ...overrides,
  };
}

const cfg = { token: 't', chat_id: 'c' };
const payload = { invoice_id: 85 };

describe('sendInvoiceNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends new message for first event on invoice (no telegram_message_id)', async () => {
    await sendInvoiceNotification(cfg, makeInvoice(), 'invoice_recognized', payload);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(editMessageText).not.toHaveBeenCalled();
    expect(invoiceRepo.setTelegramMessageId).toHaveBeenCalledWith(85, 999);
  });

  it('edits existing message when telegram_message_id is set', async () => {
    await sendInvoiceNotification(cfg, makeInvoice({ telegram_message_id: 42 }), 'approved_for_1c', payload);
    expect(editMessageText).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(invoiceRepo.setTelegramMessageId).not.toHaveBeenCalled();
  });

  it('falls back to sendMessage when edit hits MessageGoneError', async () => {
    (editMessageText as any).mockRejectedValueOnce(new MessageGoneError('gone'));
    await sendInvoiceNotification(cfg, makeInvoice({ telegram_message_id: 42 }), 'approved_for_1c', payload);
    expect(editMessageText).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(invoiceRepo.setTelegramMessageId).toHaveBeenCalledWith(85, 999);
  });

  it('does NOT fallback for non-MessageGoneError edit failures', async () => {
    (editMessageText as any).mockRejectedValueOnce(new Error('Network timeout'));
    await sendInvoiceNotification(cfg, makeInvoice({ telegram_message_id: 42 }), 'approved_for_1c', payload);
    expect(editMessageText).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('sends standalone message for urgent recognition_error', async () => {
    await sendInvoiceNotification(
      cfg,
      makeInvoice({ telegram_message_id: 42 }),
      'recognition_error',
      { ...payload, error_message: 'oops' },
    );
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(editMessageText).not.toHaveBeenCalled();
    // Crucially: telegram_message_id NOT updated (urgent message is standalone)
    expect(invoiceRepo.setTelegramMessageId).not.toHaveBeenCalled();
  });

  it('sends standalone message for urgent suspicious_total', async () => {
    await sendInvoiceNotification(
      cfg,
      makeInvoice({ telegram_message_id: 42 }),
      'suspicious_total',
      { ...payload, items_total: 980 },
    );
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(editMessageText).not.toHaveBeenCalled();
    expect(invoiceRepo.setTelegramMessageId).not.toHaveBeenCalled();
  });

  it('does not throw when sendMessage rejects', async () => {
    (sendMessage as any).mockRejectedValueOnce(new Error('Telegram down'));
    await expect(
      sendInvoiceNotification(cfg, makeInvoice(), 'invoice_recognized', payload),
    ).resolves.toBeUndefined();
  });

  it('does not throw when urgent send fails', async () => {
    (sendMessage as any).mockRejectedValueOnce(new Error('Telegram down'));
    await expect(
      sendInvoiceNotification(cfg, makeInvoice(), 'recognition_error', { ...payload, error_message: 'x' }),
    ).resolves.toBeUndefined();
  });
});
