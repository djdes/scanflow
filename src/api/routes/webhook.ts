import { Router, Request, Response } from 'express';
import { getDb } from '../../database/db';

interface WebhookConfig {
  id: number;
  url: string;
  enabled: number;
  auth_token: string | null;
  auto_send_1c: number;
}

const router = Router();

// GET /api/webhook/config
router.get('/config', (_req: Request, res: Response) => {
  const db = getDb();
  const config = db.prepare('SELECT * FROM webhook_config WHERE id = 1').get() as WebhookConfig | undefined;
  res.json({ data: config || { id: 1, url: '', enabled: 0, auth_token: null, auto_send_1c: 0 } });
});

// PUT /api/webhook/config
router.put('/config', (req: Request, res: Response) => {
  const db = getDb();
  const { url, enabled, auth_token, auto_send_1c } = req.body;

  const existing = db.prepare('SELECT * FROM webhook_config WHERE id = 1').get();
  if (existing) {
    db.prepare('UPDATE webhook_config SET url = ?, enabled = ?, auth_token = ?, auto_send_1c = ? WHERE id = 1')
      .run(url || '', enabled ? 1 : 0, auth_token || null, auto_send_1c ? 1 : 0);
  } else {
    db.prepare('INSERT INTO webhook_config (id, url, enabled, auth_token, auto_send_1c) VALUES (1, ?, ?, ?, ?)')
      .run(url || '', enabled ? 1 : 0, auth_token || null, auto_send_1c ? 1 : 0);
  }

  const updated = db.prepare('SELECT * FROM webhook_config WHERE id = 1').get();
  res.json({ data: updated });
});

// POST /api/webhook/test
router.post('/test', async (req: Request, res: Response) => {
  const db = getDb();
  const config = db.prepare('SELECT * FROM webhook_config WHERE id = 1').get() as WebhookConfig | undefined;

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
