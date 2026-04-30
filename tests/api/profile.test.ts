import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

let memEmail: string | null = 'test@example.com';
let memMode = 'digest_hourly';
let memEvents = ['photo_uploaded'];

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
  },
}));

vi.mock('../../src/utils/mailer', () => ({
  sendNotification: vi.fn(async () => {}),
  smtpConfigured: vi.fn(() => true),
}));

import profileRouter from '../../src/api/routes/profile';
import { sendNotification, smtpConfigured } from '../../src/utils/mailer';

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

describe('GET /api/profile', () => {
  beforeEach(() => {
    memEmail = 'test@example.com';
    memMode = 'digest_hourly';
    memEvents = ['photo_uploaded'];
    vi.clearAllMocks();
    (smtpConfigured as any).mockReturnValue(true);
  });

  it('returns current config', async () => {
    const res = await request(makeApp()).get('/api/profile');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      email: 'test@example.com',
      notify_mode: 'digest_hourly',
      notify_events: ['photo_uploaded'],
      smtp_configured: true,
    });
  });
});

describe('PATCH /api/profile', () => {
  beforeEach(() => {
    memEmail = 'test@example.com';
    memMode = 'digest_hourly';
    memEvents = ['photo_uploaded'];
    vi.clearAllMocks();
  });

  it('updates email when valid', async () => {
    const res = await request(makeApp()).patch('/api/profile').send({ email: 'new@x.com' });
    expect(res.status).toBe(200);
    expect(memEmail).toBe('new@x.com');
  });

  it('rejects invalid email', async () => {
    const res = await request(makeApp()).patch('/api/profile').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  it('allows clearing email with null', async () => {
    const res = await request(makeApp()).patch('/api/profile').send({ email: null });
    expect(res.status).toBe(200);
    expect(memEmail).toBeNull();
  });

  it('rejects invalid notify_mode', async () => {
    const res = await request(makeApp()).patch('/api/profile').send({ notify_mode: 'fake_mode' });
    expect(res.status).toBe(400);
  });

  it('rejects unknown event types', async () => {
    const res = await request(makeApp()).patch('/api/profile').send({ notify_events: ['photo_uploaded', 'fake_event'] });
    expect(res.status).toBe(400);
  });

  it('rejects empty body', async () => {
    const res = await request(makeApp()).patch('/api/profile').send({});
    expect(res.status).toBe(400);
  });
});

describe('POST /api/profile/test-email', () => {
  beforeEach(() => {
    memEmail = 'test@example.com';
    vi.clearAllMocks();
    (smtpConfigured as any).mockReturnValue(true);
  });

  it('sends a test email when email + smtp configured', async () => {
    const res = await request(makeApp()).post('/api/profile/test-email');
    expect(res.status).toBe(200);
    expect(sendNotification).toHaveBeenCalledOnce();
  });

  it('refuses if no email', async () => {
    memEmail = null;
    const res = await request(makeApp()).post('/api/profile/test-email');
    expect(res.status).toBe(400);
  });

  it('refuses if SMTP not configured', async () => {
    (smtpConfigured as any).mockReturnValue(false);
    const res = await request(makeApp()).post('/api/profile/test-email');
    expect(res.status).toBe(503);
  });
});
