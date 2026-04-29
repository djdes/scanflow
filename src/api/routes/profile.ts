import { Router, Request, Response } from 'express';
import { userRepo } from '../../database/repositories/userRepo';
import { sendNotification, smtpConfigured } from '../../utils/mailer';
import { ALL_NOTIFY_MODES, ALL_EVENT_TYPES, type NotifyMode, type EventType } from '../../notifications/types';
import { logger } from '../../utils/logger';

const router = Router();

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.get('/', (req: Request, res: Response) => {
  if (!req.user) { res.status(401).json({ error: 'Not authenticated' }); return; }
  const cfg = userRepo.getNotifyConfig(req.user.id);
  if (!cfg) { res.status(404).json({ error: 'User config not found' }); return; }
  res.json({
    data: {
      email: cfg.email,
      notify_mode: cfg.notify_mode,
      notify_events: cfg.notify_events,
      smtp_configured: smtpConfigured(),
    },
  });
});

router.patch('/', (req: Request, res: Response) => {
  if (!req.user) { res.status(401).json({ error: 'Not authenticated' }); return; }
  const { email, notify_mode, notify_events } = req.body ?? {};
  const update: Record<string, unknown> = {};

  if (email !== undefined) {
    if (email !== null && (typeof email !== 'string' || !EMAIL_RX.test(email))) {
      res.status(400).json({ error: 'Invalid email' }); return;
    }
    update.email = email; // null clears
  }
  if (notify_mode !== undefined) {
    if (!ALL_NOTIFY_MODES.includes(notify_mode as NotifyMode)) {
      res.status(400).json({ error: `notify_mode must be one of: ${ALL_NOTIFY_MODES.join(', ')}` }); return;
    }
    update.notify_mode = notify_mode;
  }
  if (notify_events !== undefined) {
    if (!Array.isArray(notify_events)) { res.status(400).json({ error: 'notify_events must be an array' }); return; }
    for (const e of notify_events) {
      if (!ALL_EVENT_TYPES.includes(e as EventType)) {
        res.status(400).json({ error: `Unknown event type: ${e}` }); return;
      }
    }
    update.notify_events = notify_events;
  }

  if (Object.keys(update).length === 0) {
    res.status(400).json({ error: 'No fields to update' }); return;
  }

  userRepo.setNotifyConfig(req.user.id, update);
  const fresh = userRepo.getNotifyConfig(req.user.id);
  res.json({ data: { ...fresh, smtp_configured: smtpConfigured() } });
});

router.post('/test-email', async (req: Request, res: Response) => {
  if (!req.user) { res.status(401).json({ error: 'Not authenticated' }); return; }
  const cfg = userRepo.getNotifyConfig(req.user.id);
  if (!cfg?.email) { res.status(400).json({ error: 'No email configured' }); return; }
  if (!smtpConfigured()) { res.status(503).json({ error: 'SMTP not configured on server' }); return; }
  try {
    await sendNotification(
      cfg.email,
      'Тестовое письмо',
      `<p>Это тестовое письмо от ScanFlow на адрес <b>${cfg.email}</b>.</p><p>Если вы получили это письмо — настройка уведомлений работает.</p>`,
    );
    res.json({ data: { ok: true } });
  } catch (err) {
    logger.warn('test-email failed', { error: (err as Error).message });
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
