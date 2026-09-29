import { describe, it, expect, vi, beforeEach } from 'vitest';

// «Подорожания за неделю»: сводка владельцу — по его переключателю, одна на
// неделю (строка owner_digest_sends ставится до отправки), никогда не бросает.
// Всё внешнее замокано: БД, Telegram, лимит, расчёт подорожаний.
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const runMock = vi.fn();
const allMock = vi.fn();
const prepareMock = vi.fn((_sql: string) => ({ run: runMock, all: allMock, get: vi.fn() }));
vi.mock('../../src/database/db', () => ({ getDb: () => ({ prepare: prepareMock }) }));
vi.mock('../../src/database/repositories/userRepo', () => ({
  userRepo: { getNotifyConfig: vi.fn(), getTelegramConfig: vi.fn() },
}));
vi.mock('../../src/notifications/telegram/telegramClient', () => ({ sendMessage: vi.fn() }));
vi.mock('../../src/notifications/rateLimit', () => ({ checkAndRecordSend: vi.fn() }));
vi.mock('../../src/services/analyticsPrices', () => ({ getWeeklyPriceRises: vi.fn() }));

import {
  buildWeeklyPriceDigestMessage,
  notifyWeeklyPriceRises,
  sendWeeklyPriceDigests,
  PRICE_DIGEST_KIND,
} from '../../src/notifications/priceDigest';
import { userRepo } from '../../src/database/repositories/userRepo';
import { sendMessage } from '../../src/notifications/telegram/telegramClient';
import { checkAndRecordSend } from '../../src/notifications/rateLimit';
import { getWeeklyPriceRises, type WeeklyRise } from '../../src/services/analyticsPrices';

const users = vi.mocked(userRepo);
const send = vi.mocked(sendMessage);
const throttle = vi.mocked(checkAndRecordSend);
const rises = vi.mocked(getWeeklyPriceRises);

const NOW = new Date(Date.UTC(2026, 8, 28, 6, 30)); // понедельник, ISO-неделя 2026-W40

function rise(p: Partial<WeeklyRise> = {}): WeeklyRise {
  return {
    guid: 'g-1', name: 'Говядина лопатка', unit: 'кг',
    supplier_key: 'inn:7707083893', supplier: 'ООО «Мясной двор»',
    from_price: 520, from_date: '2026-08-10', to_price: 585, to_date: '2026-09-24',
    change_pct: 12.5, qty: 10, impact_rub: 650,
    ...p,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  users.getNotifyConfig.mockResolvedValue({ email: null, notify_mode: 'realtime', notify_events: ['elevated_prices'] } as never);
  users.getTelegramConfig.mockResolvedValue({ chat_id: '111, -100222', bot_token: 'tok' });
  rises.mockResolvedValue([rise()]);
  runMock.mockResolvedValue({ changes: 1, lastInsertRowid: 0 });
  throttle.mockResolvedValue({ allow: true });
  send.mockResolvedValue(1);
});

describe('buildWeeklyPriceDigestMessage', () => {
  it('позиция, поставщик, было → стало, процент, рубли и ссылка на аналитику', () => {
    const text = buildWeeklyPriceDigestMessage([rise(), rise({ name: 'Молоко', unit: 'л', from_price: 78, to_price: 86.5, change_pct: 10.9, impact_rub: null })], 'https://x/app.html#/analytics/prices');
    expect(text.split('\n')[0]).toBe('📈 Подорожания за неделю');
    expect(text).toContain('• Говядина лопатка, кг — ООО «Мясной двор»: 520 → 585 ₽ (+12,5%, +650 ₽ на объёме недели)');
    expect(text).toContain('• Молоко, л — ООО «Мясной двор»: 78 → 86,5 ₽ (+10,9%)');
    expect(text).toContain('Динамика цен и у кого дешевле: https://x/app.html#/analytics/prices');
  });

  it('больше десяти — «и ещё N позиций»', () => {
    const many = Array.from({ length: 13 }, (_, i) => rise({ guid: `g-${i}` }));
    const text = buildWeeklyPriceDigestMessage(many, 'L');
    expect(text.match(/^• /gm)).toHaveLength(10);
    expect(text).toContain('… и ещё 3 позиции');
  });
});

describe('notifyWeeklyPriceRises', () => {
  it('застолбить неделю, пройти лимит и отправить во все чаты владельца', async () => {
    expect(await notifyWeeklyPriceRises(7, NOW)).toBe(true);
    expect(users.getNotifyConfig).toHaveBeenCalledWith(7);
    expect(rises).toHaveBeenCalledWith(7, NOW);
    expect(String(prepareMock.mock.calls[0][0])).toMatch(/INSERT IGNORE INTO owner_digest_sends/);
    expect(runMock).toHaveBeenCalledWith(7, PRICE_DIGEST_KIND, '2026-W40', 1);
    expect(throttle).toHaveBeenCalledWith('price_digest', null);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(c => c[1])).toEqual(['111', '-100222']);
    expect(send.mock.calls[0][0]).toBe('tok');
    expect(send.mock.calls[0][2]).toContain('Говядина лопатка');
  });

  it('уже отправляли на этой неделе — молчим', async () => {
    runMock.mockResolvedValue({ changes: 0, lastInsertRowid: 0 });
    expect(await notifyWeeklyPriceRises(7, NOW)).toBe(false);
    expect(throttle).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('без владельца, с выключенными «Повышенными ценами» или без Telegram — ничего не делаем', async () => {
    expect(await notifyWeeklyPriceRises(null, NOW)).toBe(false);
    expect(users.getNotifyConfig).not.toHaveBeenCalled();

    users.getNotifyConfig.mockResolvedValue({ email: null, notify_mode: 'realtime', notify_events: ['recognition_error'] } as never);
    expect(await notifyWeeklyPriceRises(7, NOW)).toBe(false);

    users.getNotifyConfig.mockResolvedValue({ email: null, notify_mode: 'realtime', notify_events: ['elevated_prices'] } as never);
    users.getTelegramConfig.mockResolvedValue({ chat_id: null, bot_token: 'tok' });
    expect(await notifyWeeklyPriceRises(7, NOW)).toBe(false);
    users.getTelegramConfig.mockResolvedValue({ chat_id: '111', bot_token: null });
    expect(await notifyWeeklyPriceRises(7, NOW)).toBe(false);

    expect(rises).not.toHaveBeenCalled();
    expect(runMock).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('подорожаний нет — неделю не занимаем и не пишем', async () => {
    rises.mockResolvedValue([]);
    expect(await notifyWeeklyPriceRises(7, NOW)).toBe(false);
    expect(runMock).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('лимит рассылки исчерпан — не шлём', async () => {
    throttle.mockResolvedValue({ allow: false, announce: false, sentInWindow: 31 });
    expect(await notifyWeeklyPriceRises(7, NOW)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('один чат упал — второй получает; ошибки не выходят наружу', async () => {
    send.mockRejectedValueOnce(new Error('403 bot was blocked'));
    expect(await notifyWeeklyPriceRises(7, NOW)).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);

    send.mockRejectedValue(new Error('network'));
    expect(await notifyWeeklyPriceRises(7, NOW)).toBe(false);

    rises.mockRejectedValue(new Error('db down'));
    await expect(notifyWeeklyPriceRises(7, NOW)).resolves.toBe(false);
  });
});

describe('sendWeeklyPriceDigests', () => {
  it('обходит компании с накладными за неделю по очереди', async () => {
    allMock.mockResolvedValue([{ id: 7 }, { id: 9 }, { id: null }]);
    rises.mockImplementation(async (owner: number) => (owner === 7 ? [rise()] : []));
    expect(await sendWeeklyPriceDigests(NOW)).toEqual({ owners: 2, sent: 1 });
    expect(rises).toHaveBeenCalledTimes(2);
    expect(String(prepareMock.mock.calls[0][0])).toMatch(/owner_user_id IS NOT NULL/);
  });

  it('список компаний не прочитался — не бросает', async () => {
    allMock.mockRejectedValue(new Error('db down'));
    await expect(sendWeeklyPriceDigests(NOW)).resolves.toEqual({ owners: 0, sent: 0 });
  });
});
