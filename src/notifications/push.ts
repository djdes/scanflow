import webpush from 'web-push';
import { logger } from '../utils/logger';
import { pushRepo } from '../database/repositories/pushRepo';
import { invoiceRepo } from '../database/repositories/invoiceRepo';
import { openSecret, sealSecret } from '../sber/secretBox';
import type { PushMessage } from './pushMessages';

/**
 * Уведомления на телефон (Web Push) — третий канал рядом с Telegram и почтой
 * (events.emit, те же переключатели и тот же лимит в час). Ключ VAPID сервера
 * создаётся сам при первом обращении и хранится в push_vapid_keys (закрытая
 * часть зашифрована от JWT_SECRET); env VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY его
 * заменяют, VAPID_SUBJECT — адрес для связи в подписи, PUSH_PROXY_URL — прокси. Содержимое уведомления шифруется для устройства: служба браузера
 * (Google, Apple, Mozilla, Microsoft) его не видит.
 */

const PURPOSE = 'web-push-vapid';
// Уведомление, которое за 12 часов не дошло (телефон выключен), уже не нужно.
const TTL_SECONDS = 12 * 60 * 60;

interface VapidKeys { publicKey: string; privateKey: string }
let cached: VapidKeys | null = null;

/** Ключ VAPID: env → база → создать. Бросает, только если хранить негде (нет JWT_SECRET/БД). */
export async function vapidKeys(): Promise<VapidKeys> {
  if (cached) return cached;
  const envPublic = process.env.VAPID_PUBLIC_KEY?.trim();
  const envPrivate = process.env.VAPID_PRIVATE_KEY?.trim();
  if (envPublic && envPrivate) {
    cached = { publicKey: envPublic, privateKey: envPrivate };
    return cached;
  }
  let row = await pushRepo.getVapid();
  if (!row) {
    const fresh = webpush.generateVAPIDKeys();
    await pushRepo.insertVapidIfAbsent(fresh.publicKey, sealSecret(fresh.privateKey, PURPOSE));
    row = await pushRepo.getVapid();
    if (!row) throw new Error('VAPID key was not stored');
  }
  cached = { publicKey: row.public_key, privateKey: openSecret(row.private_key_enc, PURPOSE) };
  return cached;
}

/** Только для тестов: забыть ключ из памяти. */
export function resetVapidCache(): void { cached = null; }

function subject(): string {
  return process.env.VAPID_SUBJECT?.trim() || 'https://scanflow.ru';
}

/** Службы уведомлений обычно доступны напрямую; если нет — env PUSH_PROXY_URL. */
function proxy(): string | undefined {
  return process.env.PUSH_PROXY_URL?.trim() || undefined;
}

/**
 * Отправить уведомление на все телефоны пользователя. Никогда не бросает
 * (правило 9): уведомления не должны ломать распознавание. Возвращает, на
 * сколько устройств ушло.
 */
export async function sendPushToUser(userId: number, message: PushMessage): Promise<number> {
  try {
    const subs = await pushRepo.listForUser(userId);
    if (!subs.length) return 0;
    const keys = await vapidKeys();
    let badge = message.badge;
    if (badge == null) {
      try { badge = Number((await invoiceRepo.workflowStats(userId)).attention) || 0; } catch { badge = undefined; }
    }
    const body = JSON.stringify({ ...message, badge });
    let delivered = 0;
    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body,
          { vapidDetails: { subject: subject(), publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: TTL_SECONDS, proxy: proxy() },
        );
        delivered++;
        await pushRepo.markSuccess(sub.id).catch(() => {});
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          // Устройство отписалось или приложение удалено — подписка больше не нужна.
          await pushRepo.removeById(sub.id).catch(() => {});
          logger.info('push: subscription gone, removed', { userId, subscriptionId: sub.id, status });
        } else {
          logger.warn('push: send failed', { userId, subscriptionId: sub.id, status, error: (err as Error).message });
        }
      }
    }
    return delivered;
  } catch (err) {
    logger.error('push: unexpected error', { userId, error: (err as Error).message });
    return 0;
  }
}
