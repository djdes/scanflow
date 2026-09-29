import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// emit() + пакетный режим: таймер тишины, одна сводка на пачку, одна запись в
// лимите. Все зависимости замоканы — ни базы, ни Telegram, ни почты (правило 17).
let flagOn = true;
let tgChats = '111,-100222';
let notifyEvents = ['photo_uploaded', 'invoice_recognized', 'recognition_error', 'suspicious_total', 'elevated_prices', 'approved_for_1c'];
const invoices = new Map<number, Record<string, unknown>>();

vi.mock('../../src/services/engineFlags', () => ({ isEngineOn: vi.fn(async () => flagOn) }));
vi.mock('../../src/database/repositories/userRepo', () => ({
  userRepo: {
    firstUserId: vi.fn(async () => 1),
    getNotifyConfig: vi.fn(async () => ({ email: 'owner@example.com', notify_mode: 'realtime', notify_events: notifyEvents })),
    getTelegramConfig: vi.fn(async () => ({ chat_id: tgChats, bot_token: 'token' })),
  },
}));
vi.mock('../../src/database/repositories/invoiceRepo', () => ({
  invoiceRepo: { getById: vi.fn(async (id: number) => invoices.get(id)) },
}));
vi.mock('../../src/notifications/telegram/telegramNotifier', () => ({
  sendInvoiceNotification: vi.fn(async () => undefined),
}));
vi.mock('../../src/notifications/telegram/telegramClient', () => ({ sendMessage: vi.fn(async () => 1) }));
vi.mock('../../src/utils/mailer', () => ({
  sendNotification: vi.fn(async () => undefined),
  smtpConfigured: () => true,
}));
vi.mock('../../src/notifications/rateLimit', () => ({
  checkAndRecordSend: vi.fn(async () => ({ allow: true })),
  NOTIFY_HOURLY_CAP: 30,
}));
vi.mock('../../src/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/config', () => ({ config: { publicBaseUrl: 'https://scanflow.ru' } }));

import { emit } from '../../src/notifications/events';
import { sendInvoiceNotification } from '../../src/notifications/telegram/telegramNotifier';
import { sendMessage } from '../../src/notifications/telegram/telegramClient';
import { sendNotification as sendEmail } from '../../src/utils/mailer';
import { checkAndRecordSend } from '../../src/notifications/rateLimit';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';
import { logger } from '../../src/utils/logger';
import type { EventType } from '../../src/notifications/types';

const S = 1000;

/** Дать доработать цепочке промисов, запущенной из таймера. */
async function settle(): Promise<void> {
  for (let i = 0; i < 200; i++) await Promise.resolve();
}

// Состояние пакетного режима живёт в модуле events.ts, поэтому у каждого
// теста свой получатель (владелец накладных).
function seed(owner: number, ids: number[]): void {
  for (const id of ids) invoices.set(id, { id, owner_user_id: owner, invoice_number: null, supplier: null, total_sum: null });
}
const fire = (type: EventType, id: number, extra: Record<string, unknown> = {}) =>
  emit(type, { invoice_id: id, ...extra }, null);

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  flagOn = true;
  tgChats = '111,-100222';
  vi.mocked(checkAndRecordSend).mockResolvedValue({ allow: true });
});
afterEach(() => { vi.useRealTimers(); });

describe('emit(): пакетный режим уведомлений', () => {
  it('пачка фото → первые две загрузки поштучно, остальное одной сводкой после 90 с тишины', async () => {
    seed(7, [101, 102, 103, 104]);
    for (const id of [101, 102, 103, 104]) await fire('photo_uploaded', id);
    expect(sendInvoiceNotification).toHaveBeenCalledTimes(2);
    expect(checkAndRecordSend).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(30 * S);
    invoices.set(101, { ...invoices.get(101), invoice_number: 'А-17', supplier: 'ООО "Вкусный мир ТК"' });
    await fire('invoice_recognized', 101, { invoice_number: 'А-17', supplier: 'ООО "Вкусный мир ТК"' });
    await fire('invoice_recognized', 102);
    await fire('elevated_prices', 102);
    await fire('invoice_recognized', 103);
    await fire('suspicious_total', 103);
    await fire('recognition_error', 104, { error_message: 'нечитаемо' });

    // Поштучно ничего не ушло, лимит не тронут.
    expect(sendInvoiceNotification).toHaveBeenCalledTimes(2);
    expect(checkAndRecordSend).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(90 * S - 1);
    await settle();
    expect(sendMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await settle();

    // Одна сводка — в каждый чат получателя; одна запись в лимите.
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sendMessage).mock.calls.map(c => c[1])).toEqual(['111', '-100222']);
    expect(checkAndRecordSend).toHaveBeenCalledTimes(3);
    expect(checkAndRecordSend).toHaveBeenLastCalledWith('batch_summary', null);

    const text = vi.mocked(sendMessage).mock.calls[0][2] as string;
    expect(text.split('\n')[0]).toBe(
      '📦 Загружено 4 фото: распознано 3, с ошибкой 1 (#104), подозрительная сумма 1, повышенные цены 1',
    );
    expect(text).toContain('• № А-17 · ООО "Вкусный мир ТК"');
    expect(text).toContain('https://scanflow.ru/app.html#/invoices/104');

    // Письма: два поштучных (загрузки до включения режима) и одна сводка.
    expect(vi.mocked(sendEmail).mock.calls.map(c => c[1]))
      .toEqual(['Фото загружено', 'Фото загружено', 'Пакетная загрузка: 4 фото']);

    // Пачка закрыта: следующее событие — снова поштучно.
    await fire('invoice_recognized', 104);
    expect(sendInvoiceNotification).toHaveBeenCalledTimes(3);
  });

  it('новые события продлевают ожидание сводки', async () => {
    seed(8, [201, 202, 203]);
    for (const id of [201, 202, 203]) await fire('photo_uploaded', id);
    await vi.advanceTimersByTimeAsync(80 * S);
    await fire('invoice_recognized', 201);
    await vi.advanceTimersByTimeAsync(80 * S); // от первой пачки — 160 с, от последнего события — 80
    await settle();
    expect(sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10 * S);
    await settle();
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('ссылки только на существующие накладные: склеенная страница из сводки выпадает', async () => {
    seed(9, [301, 302, 303]);
    for (const id of [301, 302, 303]) await fire('photo_uploaded', id);
    await fire('invoice_recognized', 301);
    invoices.delete(303); // лист многостраничной накладной влит в 301
    await vi.advanceTimersByTimeAsync(90 * S);
    await settle();
    const text = vi.mocked(sendMessage).mock.calls[0][2] as string;
    expect(text).toContain('/invoices/301');
    expect(text).not.toContain('/invoices/303');
  });

  it('непакетные события в пакетном режиме уходят сразу', async () => {
    seed(10, [401, 402, 403]);
    for (const id of [401, 402, 403]) await fire('photo_uploaded', id);
    await fire('approved_for_1c', 401);
    expect(sendInvoiceNotification).toHaveBeenCalledTimes(3);
    expect(vi.mocked(sendInvoiceNotification).mock.calls[2][2]).toBe('approved_for_1c');
  });

  it('флаг batch_notify выключен — всё как раньше, поштучно', async () => {
    flagOn = false;
    seed(11, [501, 502, 503]);
    for (const id of [501, 502, 503]) await fire('photo_uploaded', id);
    await fire('invoice_recognized', 503);
    expect(sendInvoiceNotification).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(5 * 60 * S);
    await settle();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('лимит исчерпан — сводку не шлём, но один раз предупреждаем о приглушении', async () => {
    tgChats = '111';
    seed(12, [601, 602, 603]);
    for (const id of [601, 602, 603]) await fire('photo_uploaded', id);
    vi.mocked(checkAndRecordSend).mockResolvedValue({ allow: false, announce: true, sentInWindow: 30 });
    await vi.advanceTimersByTimeAsync(90 * S);
    await settle();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendMessage).mock.calls[0][2]).toMatch(/^🔇 Уведомления приглушены/);
    // Только поштучные письма о двух загрузках до пачки — письма-сводки нет.
    expect(vi.mocked(sendEmail).mock.calls.map(c => c[1])).toEqual(['Фото загружено', 'Фото загружено']);
  });

  it('сбой при сборке сводки не выходит из таймера наружу', async () => {
    seed(13, [701, 702, 703]);
    for (const id of [701, 702, 703]) await fire('photo_uploaded', id);
    vi.mocked(invoiceRepo.getById).mockRejectedValueOnce(new Error('db down'));
    await vi.advanceTimersByTimeAsync(90 * S);
    await settle();
    expect(logger.error).toHaveBeenCalledWith('notifications: batch summary failed', expect.objectContaining({ userId: 13 }));
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
