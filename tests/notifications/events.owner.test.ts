import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/database/repositories/userRepo', () => ({
  userRepo: {
    firstUserId: vi.fn(async () => 1),
    getNotifyConfig: vi.fn(async () => ({
      email: null, notify_mode: 'realtime', notify_events: ['photo_uploaded'],
    })),
    getTelegramConfig: vi.fn(async () => ({ chat_id: 'chat', bot_token: 'token' })),
  },
}));

vi.mock('../../src/database/repositories/invoiceRepo', () => ({
  invoiceRepo: {
    getById: vi.fn(async () => ({
      id: 10, owner_user_id: 7, invoice_number: '№1', supplier: 'ООО Тест', total_sum: 100,
    })),
  },
}));

vi.mock('../../src/notifications/telegram/telegramNotifier', () => ({
  sendInvoiceNotification: vi.fn(async () => undefined),
}));
vi.mock('../../src/notifications/telegram/telegramClient', () => ({
  sendMessage: vi.fn(async () => undefined),
}));
vi.mock('../../src/utils/mailer', () => ({
  sendNotification: vi.fn(async () => undefined),
  smtpConfigured: () => false,
}));
vi.mock('../../src/notifications/rateLimit', () => ({
  checkAndRecordSend: vi.fn(async () => ({ allow: true, announce: false, sentInWindow: 1 })),
  NOTIFY_HOURLY_CAP: 30,
}));
// Логгер мокаем обязательно: настоящий тянет src/config, а тот грузит dotenv
// побочным эффектом и подставляет боевые DB_*. Тест не должен уметь дотянуться
// до реальной базы даже случайно (правило 17).
vi.mock('../../src/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { emit } from '../../src/notifications/events';
import { userRepo } from '../../src/database/repositories/userRepo';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';
import { sendInvoiceNotification } from '../../src/notifications/telegram/telegramNotifier';

describe('emit(): получатель — владелец накладной', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('берёт получателя из invoice.owner_user_id, а не из первого пользователя', async () => {
    await emit('photo_uploaded', { invoice_id: 10 } as never, null);

    expect(userRepo.getTelegramConfig).toHaveBeenCalledWith(7);
    expect(userRepo.getNotifyConfig).toHaveBeenCalledWith(7);
    expect(userRepo.firstUserId).not.toHaveBeenCalled();
    expect(sendInvoiceNotification).toHaveBeenCalledTimes(1);
  });

  it('ничего не шлёт, если у накладной нет владельца и вызов фоновый', async () => {
    (invoiceRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 11, owner_user_id: null, invoice_number: '№2', supplier: 'X', total_sum: 1,
    });

    await emit('photo_uploaded', { invoice_id: 11 } as never, null);

    expect(sendInvoiceNotification).not.toHaveBeenCalled();
    expect(userRepo.firstUserId).not.toHaveBeenCalled();
  });
});
