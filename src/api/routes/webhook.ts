import { Router, Request, Response } from 'express';
import { webhookConfigRepo } from '../../database/repositories/webhookConfigRepo';
import { logIntegrationEvent } from '../../integration/integrationLog';

const router = Router();

// Вебхук пер-тенантный: URL и Authorization-токен ведут в базу 1С конкретной
// компании. Роутер смонтирован под apiKeyAuth + requireAdmin, так что req.user
// всегда есть — бросаем, если вдруг нет, вместо молчаливого дефолта.
function ownerOf(req: Request): number {
  const id = req.user?.id;
  if (id == null) throw new Error('webhook route reached without an authenticated user');
  return id;
}

// GET /api/webhook/config
router.get('/config', async (req: Request, res: Response) => {
  const config = await webhookConfigRepo.get(ownerOf(req));
  res.json({ data: config || { id: 0, url: '', enabled: 0, auth_token: null, auto_send_1c: 0 } });
});

// PUT /api/webhook/config
router.put('/config', async (req: Request, res: Response) => {
  const ownerUserId = ownerOf(req);
  const { url, enabled, auth_token, auto_send_1c } = req.body;

  await webhookConfigRepo.upsert({
    url: url || '',
    enabled: enabled ? 1 : 0,
    auth_token: auth_token || null,
    auto_send_1c: auto_send_1c ? 1 : 0,
  }, ownerUserId);

  const updated = await webhookConfigRepo.get(ownerUserId);
  void logIntegrationEvent({
    integration: 'webhook', event_type: 'config_changed',
    summary: `Изменены настройки вебхука 1С: ${enabled ? 'включён' : 'выключен'}`,
  });
  res.json({ data: updated });
});

// POST /api/webhook/test
router.post('/test', async (req: Request, res: Response) => {
  const config = await webhookConfigRepo.get(ownerOf(req));

  if (!config || !config.url) {
    res.status(400).json({ error: 'Webhook URL not configured' });
    return;
  }

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.auth_token) {
      headers['Authorization'] = `Bearer ${config.auth_token}`;
    }

    const testPayload = {
      test: true,
      timestamp: new Date().toISOString(),
      message: 'Test webhook from 1C-JPGExchange',
    };

    const response = await fetch(config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(testPayload),
      // Match the production send path's bounded behavior (integration/webhook.ts)
      // so a slow/unresponsive URL can't hold the request open indefinitely.
      signal: AbortSignal.timeout(30_000),
    });

    res.json({
      success: response.ok,
      status: response.status,
      statusText: response.statusText,
    });
  } catch (err) {
    res.status(500).json({ error: 'Webhook test failed', details: (err as Error).message });
  }
});

export default router;
