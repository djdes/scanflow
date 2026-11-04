import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const repo = vi.hoisted(() => ({ updatePasswordHash: vi.fn() }));
vi.mock('../../src/database/repositories/userRepo', () => ({ userRepo: repo }));
vi.mock('../../src/services/engineFlags', () => ({ getEngineFlags: vi.fn(async () => ({})) }));
vi.mock('../../src/services/companyUnits', () => ({ getCompanyAllKgSetting: vi.fn(), setCompanyAllKg: vi.fn() }));
vi.mock('../../src/utils/mailer', () => ({ sendNotification: vi.fn(), smtpConfigured: vi.fn(() => false) }));
vi.mock('../../src/notifications/telegram/telegramClient', () => ({ sendMessage: vi.fn(), getMe: vi.fn(), getUpdates: vi.fn() }));

import profileRouter from '../../src/api/routes/profile';
import { verifyPassword } from '../../src/auth/password';

function makeApp(user: { id: number; username: string; role: string } | null = { id: 7, username: 'zakupki', role: 'user' }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) req.user = user as never;
    next();
  });
  app.use('/api/profile', profileRouter);
  return app;
}

beforeEach(() => {
  vi.resetAllMocks();
  repo.updatePasswordHash.mockResolvedValue(undefined);
});

describe('POST /api/profile/password — смена своего пароля без старого', () => {
  it('сохраняет хэш нового пароля только своему пользователю', async () => {
    const res = await request(makeApp()).post('/api/profile/password').send({ password: 'новый-пароль-1' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { ok: true } });
    expect(repo.updatePasswordHash).toHaveBeenCalledTimes(1);
    const [id, hash] = repo.updatePasswordHash.mock.calls[0];
    expect(id).toBe(7);
    expect(hash).not.toContain('новый-пароль-1');
    expect(verifyPassword('новый-пароль-1', hash)).toBe(true);
  });

  it('id из тела запроса не учитывается — чужой пароль так не сменить', async () => {
    await request(makeApp()).post('/api/profile/password').send({ password: 'abcdef', user_id: 1, id: 1 });
    expect(repo.updatePasswordHash.mock.calls[0][0]).toBe(7);
  });

  it('короче 6 символов, пустой или не строка — 400, ничего не пишется', async () => {
    for (const password of ['12345', '', '      ', 123456, undefined]) {
      const res = await request(makeApp()).post('/api/profile/password').send({ password });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/не короче 6/);
    }
    expect(repo.updatePasswordHash).not.toHaveBeenCalled();
  });

  it('слишком длинный — 400 (scrypt на мегабайтной строке не гоняем)', async () => {
    const res = await request(makeApp()).post('/api/profile/password').send({ password: 'a'.repeat(201) });
    expect(res.status).toBe(400);
    expect(repo.updatePasswordHash).not.toHaveBeenCalled();
  });

  it('без входа — 401', async () => {
    const res = await request(makeApp(null)).post('/api/profile/password').send({ password: 'abcdef' });
    expect(res.status).toBe(401);
    expect(repo.updatePasswordHash).not.toHaveBeenCalled();
  });
});
