import { getDb } from '../database/db';
import { userRepo } from '../database/repositories/userRepo';
import { sendMessage } from '../notifications/telegram/telegramClient';
import { parseValidChatIds } from '../notifications/telegram/chatIds';
import { logger } from '../utils/logger';

/**
 * Служебное оповещение владельцу компании в Telegram — не про конкретную
 * накладную («в 1С ничего не уходит», «Сбер: не обновился токен»). Одного вида
 * не чаще minIntervalHours (owner_alerts, миграция 75). Никогда не бросает:
 * оповещения не должны ломать то, что их вызвало.
 */
export async function sendOwnerAlert(
  ownerUserId: number,
  kind: string,
  text: string,
  minIntervalHours: number,
): Promise<boolean> {
  try {
    const db = getDb();
    const last = await db.prepare('SELECT last_sent_at FROM owner_alerts WHERE owner_user_id = ? AND kind = ?')
      .get<{ last_sent_at: string }>(ownerUserId, kind);
    if (last) {
      const sentAt = new Date(`${String(last.last_sent_at).replace(' ', 'T')}Z`).getTime();
      if (Date.now() - sentAt < minIntervalHours * 3_600_000) return false;
    }
    const tg = await userRepo.getTelegramConfig(ownerUserId);
    const chatIds = parseValidChatIds(tg?.chat_id);
    if (!tg?.bot_token || chatIds.length === 0) {
      logger.info('owner alert: Telegram not configured, skipped', { ownerUserId, kind });
      return false;
    }
    let delivered = 0;
    for (const chatId of chatIds) {
      try { await sendMessage(tg.bot_token, chatId, text); delivered++; } catch (err) {
        logger.warn('owner alert: send to chat failed', { ownerUserId, kind, error: (err as Error).message });
      }
    }
    if (delivered === 0) return false;
    await db.prepare(`
      INSERT INTO owner_alerts (owner_user_id, kind, last_sent_at, detail) VALUES (?, ?, UTC_TIMESTAMP(), ?)
      ON DUPLICATE KEY UPDATE last_sent_at = UTC_TIMESTAMP(), detail = VALUES(detail)
    `).run(ownerUserId, kind, text.slice(0, 500));
    logger.info('owner alert sent', { ownerUserId, kind });
    return true;
  } catch (err) {
    logger.warn('owner alert failed', { ownerUserId, kind, error: (err as Error).message });
    return false;
  }
}

/** Когда этому владельцу в последний раз ушло оповещение вида kind (мс эпохи), null — не уходило. */
export async function lastOwnerAlertMs(ownerUserId: number, kind: string): Promise<number | null> {
  const row = await getDb().prepare('SELECT last_sent_at FROM owner_alerts WHERE owner_user_id = ? AND kind = ?')
    .get<{ last_sent_at: string }>(ownerUserId, kind);
  if (!row) return null;
  const ms = new Date(`${String(row.last_sent_at).replace(' ', 'T')}Z`).getTime();
  return Number.isFinite(ms) ? ms : null;
}
