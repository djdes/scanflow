/**
 * «Подорожания за неделю» (п.11) — сводка владельцу компании в Telegram раз в
 * неделю (крон в src/index.ts, понедельник утром).
 *
 * Подход — как у notifySupplierExtractError в ./events.ts: сообщение уровня
 * компании, а не накладной; получатель — только сам владелец (никаких откатов к
 * «первому пользователю»); шлётся по его переключателю «Повышенные цены»
 * (elevated_prices); никогда не бросает. Уведомление по отдельной накладной уже
 * есть (elevated_prices в events.ts) — здесь только недельный итог.
 *
 * Дубли: до отправки неделя «застолбляется» строкой owner_digest_sends
 * (INSERT IGNORE по ключу владелец + вид + ISO-неделя, миграция 78). Повторный
 * запуск крона — рестарт в ту же минуту, второй процесс, ручной вызов — ничего
 * не пришлёт. Сама отправка проходит общий часовой лимит (notification_sends).
 */
import { getDb } from '../database/db';
import { config } from '../config';
import { logger } from '../utils/logger';
import { userRepo } from '../database/repositories/userRepo';
import { sendMessage } from './telegram/telegramClient';
import { parseValidChatIds } from './telegram/chatIds';
import { checkAndRecordSend } from './rateLimit';
import { getWeeklyPriceRises, type WeeklyRise } from '../services/analyticsPrices';
import { isoWeekKey } from '../services/analyticsMath';

export const PRICE_DIGEST_KIND = 'price_rises_week';
const MAX_ROWS = 10;

export function analyticsPricesUrl(): string {
  return `${config.publicBaseUrl}/app.html#/analytics/prices`;
}

const money = (n: number): string =>
  new Intl.NumberFormat('ru-RU', { maximumFractionDigits: n >= 100 ? 0 : 2 }).format(n);
const pct = (n: number): string =>
  new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(n);

function positionsWord(n: number): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'позиция';
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return 'позиции';
  return 'позиций';
}

/** Текст сводки (plain text, как остальные сообщения бота — экранировать не нужно). */
export function buildWeeklyPriceDigestMessage(rises: readonly WeeklyRise[], link = analyticsPricesUrl()): string {
  const shown = rises.slice(0, MAX_ROWS);
  const lines = ['📈 Подорожания за неделю', ''];
  for (const r of shown) {
    const impact = r.impact_rub != null && r.impact_rub >= 1 ? `, +${money(r.impact_rub)} ₽ на объёме недели` : '';
    lines.push(`• ${r.name}, ${r.unit} — ${r.supplier}: ${money(r.from_price)} → ${money(r.to_price)} ₽ (+${pct(r.change_pct)}%${impact})`);
  }
  if (rises.length > shown.length) {
    const rest = rises.length - shown.length;
    lines.push(`… и ещё ${rest} ${positionsWord(rest)}`);
  }
  lines.push('', `Динамика цен и у кого дешевле: ${link}`);
  return lines.join('\n');
}

/** Застолбить сводку за период; false — уже отправлялась (или место занято). */
export async function claimDigest(ownerUserId: number, kind: string, periodKey: string, items: number): Promise<boolean> {
  const r = await getDb().prepare(
    'INSERT IGNORE INTO owner_digest_sends (owner_user_id, kind, period_key, items) VALUES (?, ?, ?, ?)',
  ).run(ownerUserId, kind, periodKey, items);
  return r.changes === 1;
}

/** Сводка одному владельцу. true — хотя бы в один чат ушло. Никогда не бросает. */
export async function notifyWeeklyPriceRises(ownerUserId: number | null, now = new Date()): Promise<boolean> {
  try {
    // Владелец обязателен: молчание безопаснее, чем доставка чужой компании.
    if (ownerUserId == null) return false;
    const cfg = await userRepo.getNotifyConfig(ownerUserId);
    if (!cfg || !cfg.notify_events.includes('elevated_prices')) return false;
    const tg = await userRepo.getTelegramConfig(ownerUserId);
    const chatIds = parseValidChatIds(tg?.chat_id);
    if (!tg?.bot_token || chatIds.length === 0) return false;

    const rises = await getWeeklyPriceRises(ownerUserId, now);
    if (rises.length === 0) return false;

    if (!(await claimDigest(ownerUserId, PRICE_DIGEST_KIND, isoWeekKey(now), rises.length))) {
      logger.info('priceDigest: already sent this week, skipping', { ownerUserId, week: isoWeekKey(now) });
      return false;
    }
    const throttle = await checkAndRecordSend('price_digest', null);
    if (!throttle.allow) return false;

    const text = buildWeeklyPriceDigestMessage(rises);
    let delivered = false;
    for (const chatId of chatIds) {
      try {
        await sendMessage(tg.bot_token, chatId, text);
        delivered = true;
      } catch (err) {
        logger.error('priceDigest: telegram send failed', { ownerUserId, chatId, error: (err as Error).message });
      }
    }
    if (delivered) logger.info('priceDigest: weekly price rises sent', { ownerUserId, items: rises.length });
    return delivered;
  } catch (err) {
    logger.error('priceDigest: failed', { ownerUserId, error: (err as Error).message });
    return false;
  }
}

/**
 * Все компании, у которых за неделю были накладные, — по очереди. Никогда не
 * бросает (вызывается из крона).
 */
export async function sendWeeklyPriceDigests(now = new Date()): Promise<{ owners: number; sent: number }> {
  let owners: number[] = [];
  try {
    const rows = await getDb().prepare(`
      SELECT DISTINCT owner_user_id AS id
        FROM invoices
       WHERE owner_user_id IS NOT NULL
         AND created_at >= (NOW() - INTERVAL 8 DAY)
    `).all<{ id: number }>();
    owners = rows.map(r => Number(r.id)).filter(id => Number.isInteger(id) && id > 0);
  } catch (err) {
    logger.error('priceDigest: owner list failed', { error: (err as Error).message });
    return { owners: 0, sent: 0 };
  }
  let sent = 0;
  for (const id of owners) {
    if (await notifyWeeklyPriceRises(id, now)) sent++;
  }
  return { owners: owners.length, sent };
}
