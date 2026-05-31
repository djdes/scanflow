import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';

vi.mock('../../src/notifications/telegram/telegramClient', () => ({
  sendMessage: vi.fn().mockResolvedValue(1),
  editMessageText: vi.fn(),
  getMe: vi.fn(),
  getUpdates: vi.fn(),
}));
import { sendMessage } from '../../src/notifications/telegram/telegramClient';
import { emitElevatedPricesIfAny } from '../../src/notifications/events';
import { backfillAllStats } from '../../src/pricing/priceStats';

const GUID = 'guid-tomato';

async function seedHistory(prices: number[]): Promise<void> {
  for (let i = 0; i < prices.length; i++) {
    const r = await getDb().prepare(
      `INSERT INTO invoices (file_name, file_path, status, invoice_date)
       VALUES (?, ?, 'processed', ?)`
    ).run(`h${i}`, `/t/h${i}`, `2026-01-0${i + 1}`);
    const id = Number(r.lastInsertRowid);
    await getDb().prepare(
      `INSERT INTO invoice_items (invoice_id, original_name, quantity, unit, price, total, mapping_confidence, onec_guid)
       VALUES (?, 'Помидор', 1, 'кг', ?, ?, 1, ?)`
    ).run(id, prices[i], prices[i], GUID);
  }
  await backfillAllStats();
}

async function seedCurrent(price: number): Promise<number> {
  const r = await getDb().prepare(
    `INSERT INTO invoices (file_name, file_path, status, supplier, invoice_number, invoice_date, total_sum)
     VALUES ('c.jpg','/t/c.jpg','processed','ООО "Овощи"','НК-1','2026-02-01', ?)`
  ).run(price);
  const id = Number(r.lastInsertRowid);
  await getDb().prepare(
    `INSERT INTO invoice_items (invoice_id, original_name, mapped_name, quantity, unit, price, total, mapping_confidence, onec_guid)
     VALUES (?, 'Помидор красный', 'Помидор', 1, 'кг', ?, ?, 1, ?)`
  ).run(id, price, price, GUID);
  return id;
}

async function setupUserWithTelegram(): Promise<void> {
  await getDb().prepare(
    `INSERT INTO users (id, username, password_hash, api_key, role, notify_events, telegram_chat_id, telegram_bot_token)
     VALUES (1, 'admin', 'x', 'k', 'admin', ?, '12345', 'bot:token')`
  ).run(JSON.stringify(['invoice_recognized', 'elevated_prices']));
}

describe.runIf((process.env.DB_NAME || '').includes('test'))('emitElevatedPricesIfAny', () => {
  beforeEach(async () => {
    await resetDb();
    await setupUserWithTelegram();
    vi.mocked(sendMessage).mockClear();
  });
  afterAll(async () => { await closeTestDb(); });

  it('sends a Telegram message listing items >10% above the usual price', async () => {
    // 5 prior supplies at 100 ₽/кг → median = 100
    await seedHistory([100, 100, 100, 100, 100]);
    // Current at 150 ₽/кг → +50% deviation
    const cur = await seedCurrent(150);

    await emitElevatedPricesIfAny(cur);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [token, chatId, text] = vi.mocked(sendMessage).mock.calls[0];
    expect(token).toBe('bot:token');
    expect(chatId).toBe('12345');
    expect(text).toContain('Повышенные цены');
    expect(text).toContain('Помидор');
    expect(text).toContain('+50%');
    expect(text).toContain('обычно');
  });

  it('does NOT send when no item exceeds 10%', async () => {
    await seedHistory([100, 100, 100, 100, 100]);
    const cur = await seedCurrent(105); // +5%, below threshold
    await emitElevatedPricesIfAny(cur);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does NOT send when the user has elevated_prices disabled', async () => {
    await getDb().prepare(`UPDATE users SET notify_events = ? WHERE id = 1`).run(JSON.stringify(['invoice_recognized']));
    await seedHistory([100, 100, 100, 100, 100]);
    const cur = await seedCurrent(200);
    await emitElevatedPricesIfAny(cur);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
