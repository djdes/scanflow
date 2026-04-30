import { Router, Request, Response } from 'express';
import { userRepo } from '../../database/repositories/userRepo';
import { sendNotification, smtpConfigured } from '../../utils/mailer';
import { sendMessage, getMe, getUpdates } from '../../notifications/telegram/telegramClient';
import { ALL_NOTIFY_MODES, ALL_EVENT_TYPES, type NotifyMode, type EventType } from '../../notifications/types';
import { logger } from '../../utils/logger';

const router = Router();

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Telegram chat_id: digits, possibly negative (group chats); for our private
// chat usage it's a positive integer string. Accept either form to be lenient.
const CHAT_ID_RX = /^-?\d+$/;
// Telegram bot token shape: <bot_id>:<35-char-secret>. Examples differ in
// length, so we just check the basic shape <digits>:<at-least-30-chars>.
const BOT_TOKEN_RX = /^\d+:[A-Za-z0-9_-]{30,}$/;

router.get('/', (req: Request, res: Response) => {
  if (!req.user) { res.status(401).json({ error: 'Not authenticated' }); return; }

  const cfg = userRepo.getNotifyConfig(req.user.id);
  if (!cfg) { res.status(404).json({ error: 'User config not found' }); return; }

  const tg = userRepo.getTelegramConfig(req.user.id);

  res.json({
    data: {
      // Legacy email fields — kept in API for back-compat. UI ignores them.
      email: cfg.email,
      notify_mode: cfg.notify_mode,
      smtp_configured: smtpConfigured(),
      // Active fields
      notify_events: cfg.notify_events,
      telegram_chat_id: tg?.chat_id ?? null,
      telegram_bot_token_set: !!tg?.bot_token,
    },
  });
});

router.patch('/', (req: Request, res: Response) => {
  if (!req.user) { res.status(401).json({ error: 'Not authenticated' }); return; }
  const { email, notify_mode, notify_events, telegram_chat_id, telegram_bot_token } = req.body ?? {};

  const userUpdate: Record<string, unknown> = {};
  const tgUpdate: { chat_id?: string | null; bot_token?: string | null } = {};

  if (email !== undefined) {
    if (email !== null && (typeof email !== 'string' || !EMAIL_RX.test(email))) {
      res.status(400).json({ error: 'Invalid email' }); return;
    }
    userUpdate.email = email;
  }
  if (notify_mode !== undefined) {
    if (!ALL_NOTIFY_MODES.includes(notify_mode as NotifyMode)) {
      res.status(400).json({ error: `notify_mode must be one of: ${ALL_NOTIFY_MODES.join(', ')}` }); return;
    }
    userUpdate.notify_mode = notify_mode;
  }
  if (notify_events !== undefined) {
    if (!Array.isArray(notify_events)) { res.status(400).json({ error: 'notify_events must be an array' }); return; }
    for (const e of notify_events) {
      if (!ALL_EVENT_TYPES.includes(e as EventType)) {
        res.status(400).json({ error: `Unknown event type: ${e}` }); return;
      }
    }
    userUpdate.notify_events = notify_events;
  }
  if (telegram_chat_id !== undefined) {
    if (telegram_chat_id !== null && (typeof telegram_chat_id !== 'string' || !CHAT_ID_RX.test(telegram_chat_id))) {
      res.status(400).json({ error: 'telegram_chat_id must be a numeric string or null' }); return;
    }
    tgUpdate.chat_id = telegram_chat_id;
  }
  if (telegram_bot_token !== undefined) {
    if (telegram_bot_token !== null && (typeof telegram_bot_token !== 'string' || !BOT_TOKEN_RX.test(telegram_bot_token))) {
      res.status(400).json({ error: 'telegram_bot_token must match bot id:secret format' }); return;
    }
    tgUpdate.bot_token = telegram_bot_token;
  }

  const hasUserUpdates = Object.keys(userUpdate).length > 0;
  const hasTgUpdates = Object.keys(tgUpdate).length > 0;

  if (!hasUserUpdates && !hasTgUpdates) {
    res.status(400).json({ error: 'No fields to update' }); return;
  }

  if (hasUserUpdates) {
    userRepo.setNotifyConfig(req.user.id, userUpdate);
  }
  if (hasTgUpdates) {
    userRepo.setTelegramConfig(req.user.id, tgUpdate);
  }

  // Return fresh state (same shape as GET)
  const cfg = userRepo.getNotifyConfig(req.user.id);
  const tg = userRepo.getTelegramConfig(req.user.id);
  res.json({
    data: {
      email: cfg?.email ?? null,
      notify_mode: cfg?.notify_mode ?? 'digest_hourly',
      notify_events: cfg?.notify_events ?? [],
      smtp_configured: smtpConfigured(),
      telegram_chat_id: tg?.chat_id ?? null,
      telegram_bot_token_set: !!tg?.bot_token,
    },
  });
});

// Legacy: kept for back-compat. Sends a test email if SMTP is set up. UI no
// longer surfaces this — Telegram replaced email — but the endpoint stays
// alive so older bookmarks / scripts don't 404.
router.post('/test-email', async (req: Request, res: Response) => {
  if (!req.user) { res.status(401).json({ error: 'Not authenticated' }); return; }
  const cfg = userRepo.getNotifyConfig(req.user.id);
  if (!cfg?.email) { res.status(400).json({ error: 'No email configured' }); return; }
  if (!smtpConfigured()) { res.status(503).json({ error: 'SMTP not configured on server' }); return; }
  try {
    await sendNotification(
      cfg.email,
      'Тестовое письмо',
      `<p>Это тестовое письмо от ScanFlow на адрес <b>${cfg.email}</b>.</p>`,
    );
    res.json({ data: { ok: true } });
  } catch (err) {
    logger.warn('test-email failed', { error: (err as Error).message });
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/test-telegram', async (req: Request, res: Response) => {
  if (!req.user) { res.status(401).json({ error: 'Not authenticated' }); return; }
  const tg = userRepo.getTelegramConfig(req.user.id);
  if (!tg?.chat_id || !tg?.bot_token) {
    res.status(400).json({ error: 'Telegram not configured (chat_id and bot_token required)' });
    return;
  }
  try {
    await sendMessage(
      tg.bot_token,
      tg.chat_id,
      '🧪 Тестовое сообщение от ScanFlow.\n\nЕсли вы это видите — настройка Telegram-уведомлений работает.',
    );
    res.json({ data: { ok: true } });
  } catch (err) {
    logger.warn('test-telegram failed', { error: (err as Error).message });
    res.status(500).json({ error: (err as Error).message });
  }
});

// Confirmation message sent to the chat after we successfully find chat_id.
// Plain text — no parse_mode (matches telegramClient convention).
const CHAT_ID_CONFIRMATION_TEMPLATE =
  '✅ Готово!\n\n' +
  'Ваш Chat ID: {chatId}\n\n' +
  'Скопируйте это число и вставьте в поле «Chat ID» в дашборде ScanFlow, ' +
  'затем нажмите «Сохранить».\n\n' +
  'После этого вы будете получать уведомления о накладных прямо в этот чат.';

// POST /api/profile/lookup-telegram-chat-id
//
// Helper for users who don't want to dig through raw getUpdates JSON. The flow is:
//   1. User types Bot Token (or has it saved in DB).
//   2. User opens their bot in Telegram and writes /start (sends any message).
//   3. User clicks "Найти" in the dashboard.
//   4. We call getMe to validate token + get bot's @username (for the t.me link).
//   5. We call getUpdates and pick the most recent private chat.
//   6. We send the confirmation message containing chat_id to that chat.
//   7. Frontend receives chat_id and pre-fills the Chat ID input.
//
// The user still has to click "Сохранить" — we don't auto-persist. That keeps the
// click-Save habit consistent with the rest of the form.
router.post('/lookup-telegram-chat-id', async (req: Request, res: Response) => {
  if (!req.user) { res.status(401).json({ error: 'Not authenticated' }); return; }

  // Token may come from request body (user just typed it but hasn't saved yet)
  // or from DB (already saved). Body takes precedence.
  const tokenFromBody = req.body?.telegram_bot_token;
  if (tokenFromBody !== undefined && tokenFromBody !== null) {
    if (typeof tokenFromBody !== 'string' || !BOT_TOKEN_RX.test(tokenFromBody)) {
      res.status(400).json({ error: 'telegram_bot_token must match bot id:secret format' });
      return;
    }
  }
  const tg = userRepo.getTelegramConfig(req.user.id);
  const token = (tokenFromBody as string | undefined) || tg?.bot_token || null;
  if (!token) {
    res.status(400).json({ error: 'Telegram bot token is not set' });
    return;
  }

  // Step 1: getMe validates the token and gives us the bot's @username
  // (we use it for the t.me deep-link in error responses).
  let botUsername: string;
  try {
    const me = await getMe(token);
    botUsername = me.username;
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('401') && msg.includes('Unauthorized')) {
      res.status(401).json({ error: 'Invalid bot token: Unauthorized' });
      return;
    }
    logger.warn('lookup: getMe failed', { error: msg });
    res.status(500).json({ error: `Telegram API failed: ${msg}` });
    return;
  }

  // Step 2: getUpdates and find the most recent private chat
  let updates;
  try {
    updates = await getUpdates(token);
  } catch (err) {
    const msg = (err as Error).message;
    logger.warn('lookup: getUpdates failed', { error: msg });
    res.status(500).json({ error: `Telegram API failed: ${msg}` });
    return;
  }

  const privateChats = updates
    .filter(u => u.message?.chat?.type === 'private' && u.message.chat.id != null)
    .map(u => ({ chat_id: String(u.message!.chat.id), update_id: u.update_id }))
    .sort((a, b) => b.update_id - a.update_id);

  if (privateChats.length === 0) {
    res.status(404).json({
      error: 'no_updates',
      bot_username: botUsername,
      message: 'Напишите боту /start и попробуйте снова',
    });
    return;
  }

  const chatId = privateChats[0].chat_id;

  // Step 3: send the confirmation message. If this fails, the user still has the
  // chat_id in our response — don't fail the whole call.
  let confirmationSent = false;
  try {
    await sendMessage(
      token,
      chatId,
      CHAT_ID_CONFIRMATION_TEMPLATE.replace('{chatId}', chatId),
    );
    confirmationSent = true;
  } catch (err) {
    logger.warn('lookup: confirmation send failed', {
      chatId,
      botUsername,
      error: (err as Error).message,
    });
  }

  res.json({
    data: {
      chat_id: chatId,
      bot_username: botUsername,
      confirmation_sent: confirmationSent,
    },
  });
});

export default router;
