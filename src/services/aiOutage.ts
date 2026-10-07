import { invoiceRepo } from '../database/repositories/invoiceRepo';
import { userRepo } from '../database/repositories/userRepo';
import { logger } from '../utils/logger';
import type { AiUnavailableError } from '../ai/errors';
import { lastOwnerAlertMs, sendOwnerAlert } from './ownerAlerts';

/**
 * Оповещения администраторам о том, что модель (подписка ChatGPT) недоступна и снова
 * работает. Подписка общая на платформу, поэтому — админам, а не владельцам компаний:
 * те видят у своих накладных статус «Ждёт GPT».
 *
 * Пока сбой длится, «остановился» уходит не чаще раза в 6 часов (owner_alerts);
 * «снова работает» — один раз и только после «остановился». Никогда не бросает.
 */
const OUTAGE_REPEAT_HOURS = 6;

async function adminIds(): Promise<number[]> {
  return (await userRepo.listAll()).filter(u => u.role === 'admin').map(u => u.id);
}

export async function reportAiOutage(err: AiUnavailableError): Promise<void> {
  try {
    const waiting = await invoiceRepo.countWaitingAi(null);
    const text = `⏸ Распознавание приостановлено: ${err.text}.`
      + (waiting ? `\nЖдут распознавания: ${waiting}.` : '')
      + '\nКогда GPT снова станет доступен, ScanFlow распознает их сам.';
    for (const id of await adminIds()) {
      await sendOwnerAlert(id, 'ai_unavailable', text, OUTAGE_REPEAT_HOURS);
    }
  } catch (e) {
    logger.warn('AI outage alert failed', { error: (e as Error).message });
  }
}

export async function reportAiResumed(waitingCount: number): Promise<void> {
  try {
    const text = `▶ GPT снова работает.${waitingCount ? ` Распознаю накладные, которые ждали: ${waitingCount}.` : ''}`;
    for (const id of await adminIds()) {
      const stoppedAt = await lastOwnerAlertMs(id, 'ai_unavailable');
      if (stoppedAt == null) continue;
      const resumedAt = await lastOwnerAlertMs(id, 'ai_resumed');
      if (resumedAt != null && resumedAt >= stoppedAt) continue;
      await sendOwnerAlert(id, 'ai_resumed', text, 0);
    }
  } catch (e) {
    logger.warn('AI resumed alert failed', { error: (e as Error).message });
  }
}
