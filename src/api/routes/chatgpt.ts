import { Router, Request, Response } from 'express';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { invoiceRepo } from '../../database/repositories/invoiceRepo';
import type { ChatgptConnection } from '../../database/repositories/chatgptConnectionRepo';
import type { ChatgptDeviceLogin } from '../../database/repositories/chatgptDeviceLoginRepo';
import { ChatgptAuthError } from '../../chatgpt/deviceAuth';
import {
  cancelChatgptLogin,
  chatgptStatus,
  disconnectChatgpt,
  pollChatgptLogin,
  startChatgptLogin,
  testChatgpt,
} from '../../chatgpt/connection';
import { DEFAULT_GPT_MODEL, isGptModel } from '../../ocr/gptVision';
import { kickAiResume } from '../../services/aiResume';

/**
 * /api/chatgpt — своё подключение подписки ChatGPT по коду (режим распознавания gpt).
 * Монтируется с apiKeyAuth + requireAdmin: платформенный конфиг, как PUT /api/settings/analyzer.
 * Токены не отдаются никогда — только аккаунт, тариф, сроки и ошибки.
 */
const router = Router();

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);

function loginView(login: ChatgptDeviceLogin | null) {
  return login
    ? { user_code: login.userCode, verification_url: login.verificationUrl, interval_sec: login.intervalSec, expires_at: iso(login.expiresMs) }
    : null;
}

function connectionView(connection: ChatgptConnection | null, login: ChatgptDeviceLogin | null) {
  return {
    connected: !!connection,
    status: connection?.status ?? null,
    account_email: connection?.accountEmail ?? null,
    plan_type: connection?.planType ?? null,
    connected_at: connection?.createdAt ?? null,
    access_expires_at: iso(connection?.accessExpiresMs),
    last_refresh_at: iso(connection?.lastRefreshMs),
    last_used_at: iso(connection?.lastUsedMs),
    rate_limited_until: connection?.rateLimitedUntilMs && connection.rateLimitedUntilMs > Date.now() ? iso(connection.rateLimitedUntilMs) : null,
    last_error: connection?.lastError ?? null,
    pending_login: loginView(login),
    proxy_configured: !!(config.openaiProxyUrl || config.anthropicProxyUrl),
  };
}

function fail(res: Response, err: unknown, action: string): void {
  const message = (err as Error).message;
  logger.warn(`ChatGPT ${action} failed`, { error: message });
  res.status(err instanceof ChatgptAuthError ? 502 : 500).json({ error: message });
}

router.get('/', async (_req: Request, res: Response) => {
  try {
    const { connection, pendingLogin } = await chatgptStatus();
    res.json({ data: connectionView(connection, pendingLogin) });
  } catch (err) {
    fail(res, err, 'status');
  }
});

// Начать вход по коду: админ вводит код на auth.openai.com/codex/device.
router.post('/login', async (req: Request, res: Response) => {
  try {
    const login = await startChatgptLogin(req.user?.id ?? null);
    res.json({ data: { pending_login: loginView(login) } });
  } catch (err) {
    fail(res, err, 'login start');
  }
});

// Один шаг проверки подтверждения; клиент зовёт с интервалом interval_sec.
// result: idle | pending | expired | connected (при connected — сразу состояние подключения).
router.post('/login/poll', async (_req: Request, res: Response) => {
  try {
    const result = await pollChatgptLogin();
    if (result.status === 'connected') {
      // Вошли заново — накладные, ждавшие GPT, распознаются сразу, не дожидаясь 5 минут.
      kickAiResume();
      res.json({ data: { result: 'connected', ...connectionView(result.connection, null) } });
      return;
    }
    res.json({ data: { result: result.status, pending_login: result.status === 'pending' ? loginView(result.login) : null } });
  } catch (err) {
    fail(res, err, 'login poll');
  }
});

router.delete('/login', async (_req: Request, res: Response) => {
  try {
    await cancelChatgptLogin();
    res.json({ success: true });
  } catch (err) {
    fail(res, err, 'login cancel');
  }
});

router.delete('/', async (_req: Request, res: Response) => {
  try {
    await disconnectChatgpt();
    res.json({ success: true });
  } catch (err) {
    fail(res, err, 'disconnect');
  }
});

// Короткий запрос к модели: токены, выход к chatgpt.com, лимиты.
router.post('/test', async (req: Request, res: Response) => {
  try {
    const requested = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
    const cfg = await invoiceRepo.getAnalyzerConfig();
    const model = isGptModel(requested) ? requested : (isGptModel(cfg.gpt_model) ? cfg.gpt_model as string : DEFAULT_GPT_MODEL);
    const result = await testChatgpt(model);
    // Связь есть (успешный запрос снимает и паузу лимита) — пора распознать ждущие.
    if (result.ok) kickAiResume();
    res.json({ data: result });
  } catch (err) {
    fail(res, err, 'test');
  }
});

export default router;
