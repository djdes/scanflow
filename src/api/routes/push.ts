import { Router, Request, Response } from 'express';
import { pushRepo } from '../../database/repositories/pushRepo';
import { isAllowedPushEndpoint } from '../../notifications/pushMessages';
import { sendPushToUser, vapidKeys } from '../../notifications/push';
import { logger } from '../../utils/logger';

/**
 * Уведомления на телефон (Web Push) для мобильного приложения /m/ (правило 48).
 * Подписка — устройства текущего входа; присылаем только в службы уведомлений
 * браузеров (isAllowedPushEndpoint), иначе адрес подписки во внутренней сети
 * стал бы запросом сервера туда.
 */
const router = Router();

const KEY_RE = /^[A-Za-z0-9_-]{16,200}={0,2}$/;

router.get('/key', async (_req: Request, res: Response) => {
  try {
    res.json({ data: { publicKey: (await vapidKeys()).publicKey } });
  } catch (err) {
    logger.error('push: VAPID key unavailable', { error: (err as Error).message });
    res.status(503).json({ error: 'Уведомления сейчас недоступны' });
  }
});

router.post('/subscribe', async (req: Request, res: Response) => {
  const { endpoint, keys } = (req.body ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof endpoint !== 'string' || endpoint.length > 2000 || !isAllowedPushEndpoint(endpoint)) {
    if (typeof endpoint === 'string') {
      let host = '';
      try { host = new URL(endpoint).host; } catch { /* не адрес */ }
      logger.warn('push: subscription endpoint rejected', { userId: req.user?.id, host });
    }
    res.status(400).json({ error: 'Этот браузер не поддерживает уведомления ScanFlow', code: 'endpoint_not_allowed' });
    return;
  }
  const p256dh = keys?.p256dh;
  const auth = keys?.auth;
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || !KEY_RE.test(p256dh) || !KEY_RE.test(auth)) {
    res.status(400).json({ error: 'Неверные ключи подписки' });
    return;
  }
  const userAgent = String(req.headers['user-agent'] ?? '').slice(0, 512) || null;
  await pushRepo.upsert(req.user!.id, { endpoint, p256dh, auth }, userAgent);
  res.status(201).json({ data: { subscribed: true } });
});

router.post('/unsubscribe', async (req: Request, res: Response) => {
  const endpoint = (req.body ?? {}).endpoint;
  if (typeof endpoint !== 'string' || !endpoint) {
    res.status(400).json({ error: 'Нет адреса подписки' });
    return;
  }
  const removed = await pushRepo.removeOwn(req.user!.id, endpoint);
  res.json({ data: { removed } });
});

router.post('/test', async (req: Request, res: Response) => {
  const sent = await sendPushToUser(req.user!.id, {
    title: 'Уведомления включены',
    body: 'Так придёт весть о прочитанной накладной.',
    url: '/m/',
    tag: 'test',
  });
  res.json({ data: { sent } });
});

export default router;
