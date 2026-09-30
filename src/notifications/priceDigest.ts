/**
 * «Подорожания за неделю» (п.11) — сводка владельцу компании в Telegram по
 * понедельникам (крон в src/index.ts: каждый час с 09:30 до 17:30 — если
 * процесс в 09:30 перезапускался, сводка уйдёт в следующий час).
 *
 * Правила:
 *  • только по согласию: отдельный переключатель «Подорожания за неделю»
 *    (notify_events: weekly_price_digest) — он не входит в набор по умолчанию
 *    (OPT_IN_EVENT_TYPES), существующим пользователям не добавлялся. Сам по
 *    себе переключатель «Повышенные цены» (включён у всех) сводку не шлёт;
 *  • получатель — только сам владелец (никаких откатов к «первому
 *    пользователю»), подорожания — только по его накладным;
 *  • одна сводка на компанию за неделю: до отправки неделя «застолбляется»
 *    строкой owner_digest_sends (INSERT IGNORE по ключу владелец + вид +
 *    ISO-неделя, миграция 78). Повторный запуск крона, второй процесс, ручной
 *    вызов — ничего не пришлют. Строка снимается, только если отправка даже не
 *    начиналась (упёрлись в общий часовой лимит notification_sends): тогда
 *    следующий запуск попробует снова. Если Telegram ответил ошибкой — строка
 *    остаётся: сообщение могло и дойти, а дубль хуже пропуска;
 *  • неделя — прошлая календарная [пн, пн) по часам БД (прод живёт по МСК), по
 *    времени загрузки накладной; её ISO-номер — ключ сводки;
 *  • никогда не бросает (правило 9): сводка не должна ломать то, что её вызвало.
 */
import { getDb } from '../database/db';
import { config } from '../config';
import { logger } from '../utils/logger';
import { userRepo } from '../database/repositories/userRepo';
import { sendMessage } from './telegram/telegramClient';
import { parseValidChatIds } from './telegram/chatIds';
import { checkAndRecordSend } from './rateLimit';
import { getWeeklyPriceRises, type DigestWindow, type WeeklyRise } from '../services/analyticsPrices';
import { isoWeekKey, parseDbDateTime } from '../services/analyticsMath';
import type { EventType } from './types';

export const PRICE_DIGEST_KIND = 'price_rises_week';
/** Переключатель в профиле (notify_events), без которого сводка не уходит. */
export const PRICE_DIGEST_EVENT: EventType = 'weekly_price_digest';
const MAX_ROWS = 10;
const MAX_NAME = 80;
const MAX_SUPPLIER = 60;
const MAX_TEXT = 3900; // у Telegram предел 4096 символов

export function analyticsPricesUrl(): string {
  return `${config.publicBaseUrl}/app.html#/analytics/prices`;
}

const money = (n: number): string =>
  new Intl.NumberFormat('ru-RU', { maximumFractionDigits: n >= 100 ? 0 : 2 }).format(n);
const pct = (n: number): string =>
  new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(n);
const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function positionsWord(n: number): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'позиция';
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return 'позиции';
  return 'позиций';
}

/** «21.09–27.09» для окна [2026-09-21, 2026-09-28). */
export function weekLabel(window: DigestWindow): string {
  const from = parseDbDateTime(window.from);
  const to = parseDbDateTime(window.to);
  if (from == null || to == null) return '';
  const dm = (ms: number): string => {
    const d = new Date(ms);
    return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  };
  return `${dm(from)}–${dm(to - 86_400_000)}`;
}

/** Текст сводки (plain text, как остальные сообщения бота — экранировать не нужно). */
export function buildWeeklyPriceDigestMessage(
  rises: readonly WeeklyRise[],
  opts: { link?: string; window?: DigestWindow } = {},
): string {
  const link = opts.link ?? analyticsPricesUrl();
  const label = opts.window ? weekLabel(opts.window) : '';
  const shown = rises.slice(0, MAX_ROWS);
  const lines = [`📈 Подорожания за неделю${label ? ` ${label}` : ''}`, ''];
  for (const r of shown) {
    const impact = r.impact_rub != null && r.impact_rub >= 1 ? `, +${money(r.impact_rub)} ₽ на объёме недели` : '';
    lines.push(`• ${clip(r.name, MAX_NAME)}, ${r.unit} — ${clip(r.supplier, MAX_SUPPLIER)}: ${money(r.from_price)} → ${money(r.to_price)} ₽ (+${pct(r.change_pct)}%${impact})`);
  }
  if (rises.length > shown.length) {
    const rest = rises.length - shown.length;
    lines.push(`… и ещё ${rest} ${positionsWord(rest)}`);
  }
  lines.push('', `Динамика цен и у кого дешевле: ${link}`);
  const text = lines.join('\n');
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

/** Ключ сводки — ISO-неделя, о которой она (по понедельнику окна). */
export function digestPeriodKey(window: DigestWindow): string {
  const t = parseDbDateTime(window.from);
  return isoWeekKey(t == null ? new Date() : new Date(t));
}

/**
 * Прошлая календарная неделя по часам БД: с понедельника по понедельник. Часы
 * БД — потому что created_at накладных записаны ими (прод — МСК), а процесс
 * может жить в UTC.
 */
export async function loadDigestWindow(): Promise<DigestWindow> {
  const row = await getDb().prepare(`
    SELECT DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL (WEEKDAY(CURDATE()) + 7) DAY), '%Y-%m-%d') AS week_from,
           DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY), '%Y-%m-%d') AS week_to
  `).get<{ week_from: string; week_to: string }>();
  const from = String(row?.week_from ?? '');
  const to = String(row?.week_to ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new Error(`priceDigest: bad week window ${from}..${to}`);
  }
  return { from, to };
}

/** Сводка за эту неделю этому владельцу уже уходила (или ушла в другом процессе). */
export async function digestAlreadySent(ownerUserId: number, kind: string, periodKey: string): Promise<boolean> {
  const row = await getDb().prepare(
    'SELECT 1 AS sent FROM owner_digest_sends WHERE owner_user_id = ? AND kind = ? AND period_key = ?',
  ).get<{ sent: number }>(ownerUserId, kind, periodKey);
  return !!row;
}

/** Застолбить сводку за период; false — уже отправлялась (или место занято). */
export async function claimDigest(ownerUserId: number, kind: string, periodKey: string, items: number): Promise<boolean> {
  const r = await getDb().prepare(
    'INSERT IGNORE INTO owner_digest_sends (owner_user_id, kind, period_key, items) VALUES (?, ?, ?, ?)',
  ).run(ownerUserId, kind, periodKey, items);
  return r.changes === 1;
}

/** Снять заявку, если отправка даже не начиналась, — следующий запуск попробует снова. */
export async function releaseDigest(ownerUserId: number, kind: string, periodKey: string): Promise<void> {
  await getDb().prepare(
    'DELETE FROM owner_digest_sends WHERE owner_user_id = ? AND kind = ? AND period_key = ?',
  ).run(ownerUserId, kind, periodKey);
}

/**
 * Сводка одному владельцу. true — хотя бы в один чат ушло. Никогда не бросает.
 * `window` — неделя сводки (по умолчанию — прошлая, по часам БД).
 */
export async function notifyWeeklyPriceRises(ownerUserId: number | null, window?: DigestWindow): Promise<boolean> {
  let claimed: { key: string } | null = null;
  try {
    // Владелец обязателен: молчание безопаснее, чем доставка чужой компании.
    if (ownerUserId == null) return false;
    const cfg = await userRepo.getNotifyConfig(ownerUserId);
    if (!cfg || !cfg.notify_events.includes(PRICE_DIGEST_EVENT)) return false;
    const tg = await userRepo.getTelegramConfig(ownerUserId);
    const chatIds = parseValidChatIds(tg?.chat_id);
    if (!tg?.bot_token || chatIds.length === 0) return false;

    const week = window ?? await loadDigestWindow();
    const key = digestPeriodKey(week);
    if (await digestAlreadySent(ownerUserId, PRICE_DIGEST_KIND, key)) return false;

    const rises = await getWeeklyPriceRises(ownerUserId, week);
    if (rises.length === 0) return false;
    const text = buildWeeklyPriceDigestMessage(rises, { window: week });

    if (!(await claimDigest(ownerUserId, PRICE_DIGEST_KIND, key, rises.length))) {
      logger.info('priceDigest: already sent this week, skipping', { ownerUserId, week: key });
      return false;
    }
    claimed = { key };
    const throttle = await checkAndRecordSend('price_digest', null);
    if (!throttle.allow) {
      // Ничего не отправлялось — неделю освобождаем, повторит следующий запуск.
      await releaseDigest(ownerUserId, PRICE_DIGEST_KIND, key);
      logger.warn('priceDigest: hourly notification limit, will retry', { ownerUserId, week: key });
      return false;
    }
    claimed = null; // отправка началась — заявка остаётся при любом исходе

    let delivered = false;
    for (const chatId of chatIds) {
      try {
        await sendMessage(tg.bot_token, chatId, text);
        delivered = true;
      } catch (err) {
        logger.error('priceDigest: telegram send failed', { ownerUserId, chatId, error: (err as Error).message });
      }
    }
    if (delivered) logger.info('priceDigest: weekly price rises sent', { ownerUserId, week: key, items: rises.length });
    return delivered;
  } catch (err) {
    logger.error('priceDigest: failed', { ownerUserId, error: (err as Error).message });
    if (claimed && ownerUserId != null) {
      // Упали между заявкой и отправкой — сообщение точно не уходило.
      await releaseDigest(ownerUserId, PRICE_DIGEST_KIND, claimed.key).catch(() => {});
    }
    return false;
  }
}

/**
 * Все компании, у которых за неделю сводки были накладные, — по очереди.
 * Никогда не бросает (вызывается из крона).
 */
export async function sendWeeklyPriceDigests(): Promise<{ owners: number; sent: number }> {
  let owners: number[] = [];
  let week: DigestWindow;
  try {
    week = await loadDigestWindow();
    const rows = await getDb().prepare(`
      SELECT DISTINCT owner_user_id AS id
        FROM invoices
       WHERE owner_user_id IS NOT NULL
         AND created_at >= ? AND created_at < ?
    `).all<{ id: number }>(week.from, week.to);
    owners = rows.map(r => Number(r.id)).filter(id => Number.isInteger(id) && id > 0);
  } catch (err) {
    logger.error('priceDigest: owner list failed', { error: (err as Error).message });
    return { owners: 0, sent: 0 };
  }
  let sent = 0;
  for (const id of owners) {
    if (await notifyWeeklyPriceRises(id, week)) sent++;
  }
  return { owners: owners.length, sent };
}
