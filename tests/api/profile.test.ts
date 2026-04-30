import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

let memEmail: string | null = 'test@example.com';
let memMode = 'digest_hourly';
let memEvents = ['photo_uploaded'];
let memTgChat: string | null = null;
let memTgToken: string | null = null;

vi.mock('../../src/database/repositories/userRepo', () => ({
  userRepo: {
    getNotifyConfig: vi.fn(() => ({
      email: memEmail,
      notify_mode: memMode,
      notify_events: memEvents,
    })),
    setNotifyConfig: vi.fn((_id, cfg) => {
      if ('email' in cfg) memEmail = cfg.email;
      if ('notify_mode' in cfg) memMode = cfg.notify_mode;
      if ('notify_events' in cfg) memEvents = cfg.notify_events;
    }),
    getTelegramConfig: vi.fn(() => ({ chat_id: memTgChat, bot_token: memTgToken })),
    setTelegramConfig: vi.fn((_id, cfg) => {
      if ('chat_id' in cfg) memTgChat = cfg.chat_id;
      if ('bot_token' in cfg) memTgToken = cfg.bot_token;
    }),
  },
}));

vi.mock('../../src/utils/mailer', () => ({
  sendNotification: vi.fn(async () => {}),
  smtpConfigured: vi.fn(() => true),
}));

vi.mock('../../src/notifications/telegram/telegramClient', () => ({
  sendMessage: vi.fn(async () => 999),
  editMessageText: vi.fn(async () => {}),
  MessageGoneError: class MessageGoneError extends Error {},
  getMe: vi.fn(async () => ({ id: 1, username: 'test_bot' })),
  getUpdates: vi.fn(async () => []),
}));

import profileRouter from '../../src/api/routes/profile';
import { sendMessage, getMe, getUpdates } from '../../src/notifications/telegram/telegramClient';

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 1, username: 'admin', role: 'admin' };
    next();
  });
  app.use('/api/profile', profileRouter);
  return app;
}

const VALID_TOKEN = '12345:ABCDEFGHIJKLMNOPQRSTUVWXYZ_-abcdef123';

describe('GET /api/profile', () => {
  beforeEach(() => {
    memEmail = 'test@example.com';
    memMode = 'digest_hourly';
    memEvents = ['photo_uploaded'];
    memTgChat = '111';
    memTgToken = VALID_TOKEN;
    vi.clearAllMocks();
  });

  it('returns telegram fields without exposing the bot token', async () => {
    const res = await request(makeApp()).get('/api/profile');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      telegram_chat_id: '111',
      telegram_bot_token_set: true,
    });
    expect(res.body.data.telegram_bot_token).toBeUndefined();
  });

  it('reports telegram_bot_token_set: false when token absent', async () => {
    memTgToken = null;
    const res = await request(makeApp()).get('/api/profile');
    expect(res.body.data.telegram_bot_token_set).toBe(false);
  });
});

describe('PATCH /api/profile (Telegram fields)', () => {
  beforeEach(() => {
    memTgChat = null;
    memTgToken = null;
    vi.clearAllMocks();
  });

  it('saves valid chat_id and token', async () => {
    const res = await request(makeApp())
      .patch('/api/profile')
      .send({ telegram_chat_id: '123456', telegram_bot_token: VALID_TOKEN });
    expect(res.status).toBe(200);
    expect(memTgChat).toBe('123456');
    expect(memTgToken).toBe(VALID_TOKEN);
  });

  it('accepts negative chat_id (group chat shape)', async () => {
    const res = await request(makeApp()).patch('/api/profile').send({ telegram_chat_id: '-1001234567' });
    expect(res.status).toBe(200);
  });

  it('rejects non-numeric chat_id', async () => {
    const res = await request(makeApp()).patch('/api/profile').send({ telegram_chat_id: 'not-a-number' });
    expect(res.status).toBe(400);
  });

  it('rejects malformed bot token', async () => {
    const res = await request(makeApp()).patch('/api/profile').send({ telegram_bot_token: 'garbage' });
    expect(res.status).toBe(400);
  });

  it('allows clearing telegram fields with null', async () => {
    memTgChat = '111';
    memTgToken = VALID_TOKEN;
    const res = await request(makeApp()).patch('/api/profile').send({
      telegram_chat_id: null,
      telegram_bot_token: null,
    });
    expect(res.status).toBe(200);
    expect(memTgChat).toBeNull();
    expect(memTgToken).toBeNull();
  });
});

describe('POST /api/profile/test-telegram', () => {
  beforeEach(() => {
    memTgChat = '111';
    memTgToken = VALID_TOKEN;
    vi.clearAllMocks();
  });

  it('sends test message when configured', async () => {
    const res = await request(makeApp()).post('/api/profile/test-telegram');
    expect(res.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it('refuses if chat_id missing', async () => {
    memTgChat = null;
    const res = await request(makeApp()).post('/api/profile/test-telegram');
    expect(res.status).toBe(400);
  });

  it('refuses if bot_token missing', async () => {
    memTgToken = null;
    const res = await request(makeApp()).post('/api/profile/test-telegram');
    expect(res.status).toBe(400);
  });

  it('returns 500 with details when Telegram rejects token', async () => {
    (sendMessage as any).mockRejectedValueOnce(new Error('Telegram API: 401 Unauthorized'));
    const res = await request(makeApp()).post('/api/profile/test-telegram');
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('Unauthorized');
  });
});

// Sanity check: the legacy /test-email endpoint still works (back-compat).
describe('POST /api/profile/test-email (legacy)', () => {
  beforeEach(() => {
    memEmail = 'test@example.com';
    vi.clearAllMocks();
  });
  it('still sends email when SMTP configured', async () => {
    const res = await request(makeApp()).post('/api/profile/test-email');
    expect(res.status).toBe(200);
  });
});

describe('POST /api/profile/lookup-telegram-chat-id', () => {
  beforeEach(() => {
    memTgChat = null;
    memTgToken = VALID_TOKEN;
    vi.clearAllMocks();
    (getMe as any).mockResolvedValue({ id: 1, username: 'test_bot' });
    (getUpdates as any).mockResolvedValue([]);
    (sendMessage as any).mockResolvedValue(999);
  });

  it('returns 400 if no token is set anywhere', async () => {
    memTgToken = null;
    const res = await request(makeApp()).post('/api/profile/lookup-telegram-chat-id').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not set');
  });

  it('returns 400 if body token has wrong shape', async () => {
    const res = await request(makeApp()).post('/api/profile/lookup-telegram-chat-id').send({
      telegram_bot_token: 'garbage',
    });
    expect(res.status).toBe(400);
  });

  it('returns 401 if Telegram says token is invalid', async () => {
    (getMe as any).mockRejectedValueOnce(new Error('Telegram API getMe failed: 401 Unauthorized'));
    const res = await request(makeApp()).post('/api/profile/lookup-telegram-chat-id').send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toContain('Invalid bot token');
  });

  it('returns 404 with bot_username when no updates exist', async () => {
    (getUpdates as any).mockResolvedValueOnce([]);
    const res = await request(makeApp()).post('/api/profile/lookup-telegram-chat-id').send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('no_updates');
    expect(res.body.bot_username).toBe('test_bot');
  });

  it('returns chat_id from the most recent private update', async () => {
    (getUpdates as any).mockResolvedValueOnce([
      { update_id: 1, message: { chat: { id: 100, type: 'private' } } },
      { update_id: 5, message: { chat: { id: 500, type: 'private' } } },
      { update_id: 3, message: { chat: { id: 300, type: 'private' } } },
    ]);
    const res = await request(makeApp()).post('/api/profile/lookup-telegram-chat-id').send({});
    expect(res.status).toBe(200);
    expect(res.body.data.chat_id).toBe('500');
    expect(res.body.data.bot_username).toBe('test_bot');
    expect(res.body.data.confirmation_sent).toBe(true);
    expect(sendMessage).toHaveBeenCalledOnce();
    const sendArgs = (sendMessage as any).mock.calls[0];
    expect(sendArgs[1]).toBe('500');
    expect(sendArgs[2]).toContain('Ваш Chat ID: 500');
  });

  it('skips group/supergroup/channel updates, returns private only', async () => {
    (getUpdates as any).mockResolvedValueOnce([
      { update_id: 1, message: { chat: { id: -100, type: 'group' } } },
      { update_id: 2, message: { chat: { id: -200, type: 'supergroup' } } },
      { update_id: 3, message: { chat: { id: 777, type: 'private' } } },
    ]);
    const res = await request(makeApp()).post('/api/profile/lookup-telegram-chat-id').send({});
    expect(res.status).toBe(200);
    expect(res.body.data.chat_id).toBe('777');
  });

  it('skips updates without message field', async () => {
    (getUpdates as any).mockResolvedValueOnce([
      { update_id: 1 },
      { update_id: 2, message: { chat: { id: 42, type: 'private' } } },
    ]);
    const res = await request(makeApp()).post('/api/profile/lookup-telegram-chat-id').send({});
    expect(res.status).toBe(200);
    expect(res.body.data.chat_id).toBe('42');
  });

  it('returns 200 with confirmation_sent=false if sendMessage fails', async () => {
    (getUpdates as any).mockResolvedValueOnce([
      { update_id: 1, message: { chat: { id: 555, type: 'private' } } },
    ]);
    (sendMessage as any).mockRejectedValueOnce(new Error('Telegram down'));
    const res = await request(makeApp()).post('/api/profile/lookup-telegram-chat-id').send({});
    expect(res.status).toBe(200);
    expect(res.body.data.chat_id).toBe('555');
    expect(res.body.data.confirmation_sent).toBe(false);
  });

  it('uses token from body when provided (overrides DB)', async () => {
    memTgToken = VALID_TOKEN; // DB has one
    const otherToken = '99999:OtherTokenXyzAbcdefghijklmnopqrstuv';
    (getUpdates as any).mockResolvedValueOnce([
      { update_id: 1, message: { chat: { id: 88, type: 'private' } } },
    ]);
    const res = await request(makeApp()).post('/api/profile/lookup-telegram-chat-id').send({
      telegram_bot_token: otherToken,
    });
    expect(res.status).toBe(200);
    expect((getMe as any).mock.calls[0][0]).toBe(otherToken);
  });
});
