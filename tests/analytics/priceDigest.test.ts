import { describe, it, expect, vi, beforeEach } from 'vitest';

// «Подорожания за неделю»: сводка владельцу — только по его отдельному
// переключателю, одна на неделю (строка owner_digest_sends ставится до
// отправки), неделя — по часам БД, никогда не бросает. Всё внешнее замокано:
// БД, Telegram, лимит, расчёт подорожаний.
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const runMock = vi.fn();
const allMock = vi.fn();
const sentGetMock = vi.fn();
const windowGetMock = vi.fn();
const prepareMock = vi.fn((sql: string) => ({
  run: runMock,
  all: allMock,
  get: String(sql).includes('DATE_FORMAT') ? windowGetMock : sentGetMock,
}));
vi.mock('../../src/database/db', () => ({ getDb: () => ({ prepare: prepareMock }) }));
vi.mock('../../src/database/repositories/userRepo', () => ({
  userRepo: { getNotifyConfig: vi.fn(), getTelegramConfig: vi.fn() },
}));
vi.mock('../../src/notifications/telegram/telegramClient', () => ({ sendMessage: vi.fn() }));
vi.mock('../../src/notifications/rateLimit', () => ({ checkAndRecordSend: vi.fn() }));
vi.mock('../../src/services/analyticsPrices', () => ({ getWeeklyPriceRises: vi.fn() }));

import {
  buildWeeklyPriceDigestMessage,
  digestPeriodKey,
  loadDigestWindow,
  notifyWeeklyPriceRises,
  sendWeeklyPriceDigests,
  weekLabel,
  PRICE_DIGEST_EVENT,
  PRICE_DIGEST_KIND,
} from '../../src/notifications/priceDigest';
import { ALL_EVENT_TYPES, DEFAULT_EVENT_TYPES, OPT_IN_EVENT_TYPES } from '../../src/notifications/types';
import { userRepo } from '../../src/database/repositories/userRepo';
import { sendMessage } from '../../src/notifications/telegram/telegramClient';
import { checkAndRecordSend } from '../../src/notifications/rateLimit';
import { getWeeklyPriceRises, type DigestWindow, type WeeklyRise } from '../../src/services/analyticsPrices';

const users = vi.mocked(userRepo);
const send = vi.mocked(sendMessage);
const throttle = vi.mocked(checkAndRecordSend);
const rises = vi.mocked(getWeeklyPriceRises);

/** Неделя сводки понедельника 28.09.2026: пн 21.09 – пн 28.09 (ISO-неделя 39). */
const WEEK: DigestWindow = { from: '2026-09-21', to: '2026-09-28' };

function rise(p: Partial<WeeklyRise> = {}): WeeklyRise {
  return {
    guid: 'g-1', name: 'Говядина лопатка', unit: 'кг',
    supplier_key: 'inn:7707083893', supplier: 'ООО «Мясной двор»',
    from_price: 520, from_date: '2026-08-10', to_price: 585, to_date: '2026-09-24',
    change_pct: 12.5, qty: 10, impact_rub: 650,
    ...p,
  };
}

const sqlCalls = (): string[] => prepareMock.mock.calls.map(c => String(c[0]));
const deletes = (): string[] => sqlCalls().filter(s => /DELETE FROM owner_digest_sends/.test(s));

beforeEach(() => {
  vi.clearAllMocks();
  users.getNotifyConfig.mockResolvedValue({ email: null, notify_mode: 'realtime', notify_events: ['elevated_prices', 'weekly_price_digest'] } as never);
  users.getTelegramConfig.mockResolvedValue({ chat_id: '111, -100222', bot_token: 'tok' });
  rises.mockResolvedValue([rise()]);
  runMock.mockResolvedValue({ changes: 1, lastInsertRowid: 0 });
  sentGetMock.mockResolvedValue(undefined);
  windowGetMock.mockResolvedValue({ week_from: WEEK.from, week_to: WEEK.to });
  throttle.mockResolvedValue({ allow: true });
  send.mockResolvedValue(1);
});

describe('согласие: отдельный переключатель, по умолчанию выключен', () => {
  it('«Подорожания за неделю» — в списке событий профиля, но не в наборе нового пользователя', () => {
    expect(PRICE_DIGEST_EVENT).toBe('weekly_price_digest');
    expect(ALL_EVENT_TYPES).toContain('weekly_price_digest');
    expect(OPT_IN_EVENT_TYPES.has('weekly_price_digest')).toBe(true);
    expect(DEFAULT_EVENT_TYPES).not.toContain('weekly_price_digest');
    expect(DEFAULT_EVENT_TYPES).toContain('elevated_prices');
    expect(DEFAULT_EVENT_TYPES).toHaveLength(ALL_EVENT_TYPES.length - 1);
  });

  it('включены только «Повышенные цены» — сводку не шлём', async () => {
    users.getNotifyConfig.mockResolvedValue({ email: null, notify_mode: 'realtime', notify_events: ['elevated_prices'] } as never);
    expect(await notifyWeeklyPriceRises(7, WEEK)).toBe(false);
    expect(rises).not.toHaveBeenCalled();
    expect(runMock).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('buildWeeklyPriceDigestMessage', () => {
  it('неделя, позиция, поставщик, было → стало, процент, рубли и ссылка на аналитику', () => {
    const text = buildWeeklyPriceDigestMessage(
      [rise(), rise({ name: 'Молоко', unit: 'л', from_price: 78, to_price: 86.5, change_pct: 10.9, impact_rub: null })],
      { link: 'https://x/app.html#/analytics/prices', window: WEEK },
    );
    expect(text.split('\n')[0]).toBe('📈 Подорожания за неделю 21.09–27.09');
    expect(text).toContain('• Говядина лопатка, кг — ООО «Мясной двор»: 520 → 585 ₽ (+12,5%, +650 ₽ на объёме недели)');
    expect(text).toContain('• Молоко, л — ООО «Мясной двор»: 78 → 86,5 ₽ (+10,9%)');
    expect(text).toContain('Динамика цен и у кого дешевле: https://x/app.html#/analytics/prices');
  });

  it('больше десяти — «и ещё N позиций»; длинные названия обрезаются', () => {
    const many = Array.from({ length: 13 }, (_, i) => rise({ guid: `g-${i}`, name: 'Очень длинное название '.repeat(10) }));
    const text = buildWeeklyPriceDigestMessage(many, { link: 'L' });
    expect(text.split('\n')[0]).toBe('📈 Подорожания за неделю');
    expect(text.match(/^• /gm)).toHaveLength(10);
    expect(text).toContain('… и ещё 3 позиции');
    expect(text.length).toBeLessThan(4096);
    expect(text).toContain('…, кг');
  });

  it('подпись недели и ключ сводки — по понедельнику окна', () => {
    expect(weekLabel(WEEK)).toBe('21.09–27.09');
    expect(weekLabel({ from: '2026-12-28', to: '2027-01-04' })).toBe('28.12–03.01');
    expect(digestPeriodKey(WEEK)).toBe('2026-W39');
    expect(digestPeriodKey({ from: '2026-12-28', to: '2027-01-04' })).toBe('2026-W53');
  });
});

describe('loadDigestWindow — прошлая неделя по часам БД', () => {
  it('понедельник — понедельник, считает сама БД', async () => {
    expect(await loadDigestWindow()).toEqual(WEEK);
    const sql = sqlCalls()[0];
    expect(sql).toMatch(/WEEKDAY\(CURDATE\(\)\)/);
    // «?» в запросе нет — bindParams не спутает формат даты с параметром
    expect(sql).not.toMatch(/\?/);
  });

  it('мусор вместо дат — ошибка (её ловит вызывающий)', async () => {
    windowGetMock.mockResolvedValue({ week_from: null, week_to: '2026-09-28' });
    await expect(loadDigestWindow()).rejects.toThrow(/bad week window/);
  });
});

describe('notifyWeeklyPriceRises', () => {
  it('застолбить неделю, пройти лимит и отправить во все чаты владельца', async () => {
    expect(await notifyWeeklyPriceRises(7, WEEK)).toBe(true);
    expect(users.getNotifyConfig).toHaveBeenCalledWith(7);
    expect(rises).toHaveBeenCalledWith(7, WEEK);
    expect(sqlCalls().some(s => /INSERT IGNORE INTO owner_digest_sends/.test(s))).toBe(true);
    expect(runMock).toHaveBeenCalledWith(7, PRICE_DIGEST_KIND, '2026-W39', 1);
    expect(throttle).toHaveBeenCalledWith('price_digest', null);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(c => c[1])).toEqual(['111', '-100222']);
    expect(send.mock.calls[0][0]).toBe('tok');
    expect(send.mock.calls[0][2]).toContain('Говядина лопатка');
    expect(deletes()).toEqual([]);
  });

  it('без окна — берёт прошлую неделю из БД', async () => {
    expect(await notifyWeeklyPriceRises(7)).toBe(true);
    expect(windowGetMock).toHaveBeenCalled();
    expect(rises).toHaveBeenCalledWith(7, WEEK);
  });

  it('уже отправляли на этой неделе — не считаем и не шлём', async () => {
    sentGetMock.mockResolvedValue({ sent: 1 });
    expect(await notifyWeeklyPriceRises(7, WEEK)).toBe(false);
    expect(rises).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('заявку на неделю перехватил другой процесс — молчим', async () => {
    runMock.mockResolvedValue({ changes: 0, lastInsertRowid: 0 });
    expect(await notifyWeeklyPriceRises(7, WEEK)).toBe(false);
    expect(throttle).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('без владельца, с выключенной сводкой или без Telegram — ничего не делаем', async () => {
    expect(await notifyWeeklyPriceRises(null, WEEK)).toBe(false);
    expect(users.getNotifyConfig).not.toHaveBeenCalled();

    users.getNotifyConfig.mockResolvedValue({ email: null, notify_mode: 'realtime', notify_events: ['recognition_error'] } as never);
    expect(await notifyWeeklyPriceRises(7, WEEK)).toBe(false);
    users.getNotifyConfig.mockResolvedValue(null);
    expect(await notifyWeeklyPriceRises(7, WEEK)).toBe(false);

    users.getNotifyConfig.mockResolvedValue({ email: null, notify_mode: 'realtime', notify_events: ['weekly_price_digest'] } as never);
    users.getTelegramConfig.mockResolvedValue({ chat_id: null, bot_token: 'tok' });
    expect(await notifyWeeklyPriceRises(7, WEEK)).toBe(false);
    users.getTelegramConfig.mockResolvedValue({ chat_id: '111', bot_token: null });
    expect(await notifyWeeklyPriceRises(7, WEEK)).toBe(false);

    expect(rises).not.toHaveBeenCalled();
    expect(runMock).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('подорожаний нет — неделю не занимаем и не пишем', async () => {
    rises.mockResolvedValue([]);
    expect(await notifyWeeklyPriceRises(7, WEEK)).toBe(false);
    expect(runMock).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('часовой лимит исчерпан — не шлём и освобождаем неделю для следующего запуска', async () => {
    throttle.mockResolvedValue({ allow: false, announce: false, sentInWindow: 31 });
    expect(await notifyWeeklyPriceRises(7, WEEK)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(deletes()).toHaveLength(1);
    expect(runMock).toHaveBeenLastCalledWith(7, PRICE_DIGEST_KIND, '2026-W39');
  });

  it('один чат упал — второй получает; все упали — неделя остаётся занятой (дубль хуже пропуска)', async () => {
    send.mockRejectedValueOnce(new Error('403 bot was blocked'));
    expect(await notifyWeeklyPriceRises(7, WEEK)).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);

    send.mockRejectedValue(new Error('network'));
    expect(await notifyWeeklyPriceRises(7, WEEK)).toBe(false);
    expect(deletes()).toEqual([]);
  });

  it('ошибки не выходят наружу', async () => {
    rises.mockRejectedValue(new Error('db down'));
    await expect(notifyWeeklyPriceRises(7, WEEK)).resolves.toBe(false);
    users.getNotifyConfig.mockRejectedValue(new Error('db down'));
    await expect(notifyWeeklyPriceRises(7, WEEK)).resolves.toBe(false);
  });

  it('упали между заявкой и отправкой — заявку снимаем', async () => {
    throttle.mockRejectedValue(new Error('boom'));
    await expect(notifyWeeklyPriceRises(7, WEEK)).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(deletes()).toHaveLength(1);
  });
});

describe('sendWeeklyPriceDigests', () => {
  it('обходит компании с накладными за неделю сводки по очереди', async () => {
    allMock.mockResolvedValue([{ id: 7 }, { id: 9 }, { id: null }]);
    rises.mockImplementation(async (owner: number) => (owner === 7 ? [rise()] : []));
    expect(await sendWeeklyPriceDigests()).toEqual({ owners: 2, sent: 1 });
    expect(rises).toHaveBeenCalledTimes(2);
    expect(rises).toHaveBeenCalledWith(9, WEEK);
    const ownersSql = sqlCalls().find(s => /SELECT DISTINCT owner_user_id/.test(s))!;
    expect(ownersSql).toMatch(/owner_user_id IS NOT NULL/);
    expect(allMock).toHaveBeenCalledWith(WEEK.from, WEEK.to);
    // окно недели читается один раз на весь обход
    expect(windowGetMock).toHaveBeenCalledTimes(1);
  });

  it('список компаний или неделя не прочитались — не бросает', async () => {
    allMock.mockRejectedValue(new Error('db down'));
    await expect(sendWeeklyPriceDigests()).resolves.toEqual({ owners: 0, sent: 0 });
    windowGetMock.mockRejectedValue(new Error('db down'));
    await expect(sendWeeklyPriceDigests()).resolves.toEqual({ owners: 0, sent: 0 });
  });
});
