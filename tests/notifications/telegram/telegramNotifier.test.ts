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
    // Пузыри накладной по чатам: chat_id → message_id. Раньше был один
    // setTelegramMessageId на накладную — с несколькими чатами так нельзя,
    // Telegram адресует сообщение парой (chat_id, message_id).
    getTelegramMessageIds: vi.fn(async () => new Map<string, number>()),
    setTelegramMessageIdForChat: vi.fn(),
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
  } as Invoice;
}

const CHAT = '111';
const CHAT2 = '-100222';
const cfg = { token: 't', chat_id: CHAT };
const cfgMulti = { token: 't', chat_id: `${CHAT},${CHAT2}` };
const payload = { invoice_id: 85 };

/** Подсунуть уже существующие пузыри (chat_id → message_id). */
function withExistingBubbles(pairs: Array<[string, number]>): void {
  (invoiceRepo.getTelegramMessageIds as any).mockResolvedValueOnce(new Map(pairs));
}

describe('sendInvoiceNotification', () => {
  beforeEach(() => {
    // resetAllMocks, а не clearAllMocks: последний чистит только записи о
    // вызовах, но НЕ очередь mockRejectedValueOnce — недоиспользованное
    // «одноразовое» падение протекало в следующий тест и роняло его.
    vi.resetAllMocks();
    (invoiceRepo.getTelegramMessageIds as any).mockResolvedValue(new Map());
    (sendMessage as any).mockResolvedValue(999);
    (editMessageText as any).mockResolvedValue(undefined);
  });

  describe('один чат — прежнее поведение', () => {
    it('шлёт новое сообщение на первом событии по накладной', async () => {
      await sendInvoiceNotification(cfg, makeInvoice(), 'invoice_recognized', payload);
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(editMessageText).not.toHaveBeenCalled();
      expect(invoiceRepo.setTelegramMessageIdForChat).toHaveBeenCalledWith(85, CHAT, 999);
    });

    it('правит существующий пузырь, а не плодит новые', async () => {
      withExistingBubbles([[CHAT, 42]]);
      await sendInvoiceNotification(cfg, makeInvoice(), 'approved_for_1c', payload);
      expect(editMessageText).toHaveBeenCalledOnce();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(invoiceRepo.setTelegramMessageIdForChat).not.toHaveBeenCalled();
    });

    it('шлёт новое, если старое сообщение удалили (MessageGoneError)', async () => {
      withExistingBubbles([[CHAT, 42]]);
      (editMessageText as any).mockRejectedValueOnce(new MessageGoneError('gone'));
      await sendInvoiceNotification(cfg, makeInvoice(), 'approved_for_1c', payload);
      expect(editMessageText).toHaveBeenCalledOnce();
      expect(sendMessage).toHaveBeenCalledOnce();
      // Пара перезаписывается: message_id сменился.
      expect(invoiceRepo.setTelegramMessageIdForChat).toHaveBeenCalledWith(85, CHAT, 999);
    });

    it('НЕ дублирует сообщение при прочих ошибках правки', async () => {
      withExistingBubbles([[CHAT, 42]]);
      (editMessageText as any).mockRejectedValueOnce(new Error('Network timeout'));
      await sendInvoiceNotification(cfg, makeInvoice(), 'approved_for_1c', payload);
      expect(editMessageText).toHaveBeenCalledOnce();
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('срочное событие — отдельное сообщение, пузырь не трогает', async () => {
      withExistingBubbles([[CHAT, 42]]);
      await sendInvoiceNotification(cfg, makeInvoice(), 'recognition_error', { ...payload, error_message: 'oops' });
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(editMessageText).not.toHaveBeenCalled();
      expect(invoiceRepo.setTelegramMessageIdForChat).not.toHaveBeenCalled();
    });

    it('срочное suspicious_total — тоже отдельным сообщением', async () => {
      withExistingBubbles([[CHAT, 42]]);
      await sendInvoiceNotification(cfg, makeInvoice(), 'suspicious_total', { ...payload, items_total: 980 });
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(editMessageText).not.toHaveBeenCalled();
      expect(invoiceRepo.setTelegramMessageIdForChat).not.toHaveBeenCalled();
    });

    it('не бросает, когда отправка падает', async () => {
      (sendMessage as any).mockRejectedValueOnce(new Error('Telegram down'));
      await expect(
        sendInvoiceNotification(cfg, makeInvoice(), 'invoice_recognized', payload),
      ).resolves.toBeUndefined();
    });

    it('не бросает, когда падает срочная отправка', async () => {
      (sendMessage as any).mockRejectedValueOnce(new Error('Telegram down'));
      await expect(
        sendInvoiceNotification(cfg, makeInvoice(), 'recognition_error', { ...payload, error_message: 'x' }),
      ).resolves.toBeUndefined();
    });
  });

  describe('несколько чатов', () => {
    it('прогресс уходит в каждый чат своим пузырём', async () => {
      await sendInvoiceNotification(cfgMulti, makeInvoice(), 'invoice_recognized', payload);
      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(invoiceRepo.setTelegramMessageIdForChat).toHaveBeenCalledWith(85, CHAT, 999);
      expect(invoiceRepo.setTelegramMessageIdForChat).toHaveBeenCalledWith(85, CHAT2, 999);
    });

    it('срочное событие уходит в каждый чат', async () => {
      await sendInvoiceNotification(cfgMulti, makeInvoice(), 'recognition_error', { ...payload, error_message: 'x' });
      expect(sendMessage).toHaveBeenCalledTimes(2);
      const chats = (sendMessage as any).mock.calls.map((c: unknown[]) => c[1]);
      expect(chats).toEqual([CHAT, CHAT2]);
    });

    it('где пузырь есть — правит, где нет — создаёт', async () => {
      // Чат добавили уже после того, как накладная обзавелась пузырём в первом.
      withExistingBubbles([[CHAT, 42]]);
      await sendInvoiceNotification(cfgMulti, makeInvoice(), 'approved_for_1c', payload);
      expect(editMessageText).toHaveBeenCalledOnce();
      expect((editMessageText as any).mock.calls[0][1]).toBe(CHAT);
      expect(sendMessage).toHaveBeenCalledOnce();
      expect((sendMessage as any).mock.calls[0][1]).toBe(CHAT2);
      expect(invoiceRepo.setTelegramMessageIdForChat).toHaveBeenCalledWith(85, CHAT2, 999);
    });

    it('недоступный чат не лишает уведомления остальные', async () => {
      // Бота выкинули из первой группы — второй чат обязан получить сообщение.
      (sendMessage as any).mockRejectedValueOnce(new Error('bot was kicked'));
      await sendInvoiceNotification(cfgMulti, makeInvoice(), 'invoice_recognized', payload);
      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(invoiceRepo.setTelegramMessageIdForChat).toHaveBeenCalledOnce();
      expect(invoiceRepo.setTelegramMessageIdForChat).toHaveBeenCalledWith(85, CHAT2, 999);
    });

    it('сбой правки в одном чате не мешает остальным', async () => {
      withExistingBubbles([[CHAT, 42], [CHAT2, 43]]);
      (editMessageText as any).mockRejectedValueOnce(new Error('Network timeout'));
      await sendInvoiceNotification(cfgMulti, makeInvoice(), 'approved_for_1c', payload);
      expect(editMessageText).toHaveBeenCalledTimes(2);
    });

    it('дубликаты в списке не приводят к двойной отправке', async () => {
      await sendInvoiceNotification({ token: 't', chat_id: `${CHAT}, ${CHAT}` }, makeInvoice(), 'invoice_recognized', payload);
      expect(sendMessage).toHaveBeenCalledOnce();
    });

    it('пустой и мусорный список — молча ничего не шлём', async () => {
      for (const chat_id of ['', '   ', '@channel, abc']) {
        vi.clearAllMocks();
        (invoiceRepo.getTelegramMessageIds as any).mockResolvedValue(new Map());
        await sendInvoiceNotification({ token: 't', chat_id }, makeInvoice(), 'invoice_recognized', payload);
        expect(sendMessage).not.toHaveBeenCalled();
        expect(editMessageText).not.toHaveBeenCalled();
      }
    });
  });
});
