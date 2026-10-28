import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { hashPassword } from '../../src/auth/password';
import type { User, AdminUserListItem, UpdateUserFields } from '../../src/database/repositories/userRepo';

const memUsers: User[] = [];
let nextId = 1;

vi.mock('../../src/database/repositories/userRepo', () => {
  const repo = {
    async findByUsername(username: string): Promise<User | undefined> {
      return memUsers.find((u) => u.username.toLowerCase() === username.toLowerCase());
    },
    async findByEmail(email: string): Promise<User | undefined> {
      return memUsers.find((u) => (u.email || '').toLowerCase() === email.toLowerCase());
    },
    async findByLogin(login: string): Promise<User | undefined> {
      const trimmed = login.trim();
      if (!trimmed) return undefined;
      return (await this.findByUsername(trimmed)) ?? (await this.findByEmail(trimmed.toLowerCase()));
    },
    async findByApiKey(apiKey: string): Promise<User | undefined> {
      return memUsers.find((u) => u.api_key === apiKey);
    },
    async findById(id: number): Promise<User | undefined> {
      return memUsers.find((u) => u.id === id);
    },
    async count(): Promise<number> {
      return memUsers.length;
    },
    async countAdmins(): Promise<number> {
      return memUsers.filter((u) => u.role === 'admin' && !u.is_blocked).length;
    },
    async countSuperadmins(): Promise<number> {
      return memUsers.filter((u) => Boolean(u.is_superadmin) && !u.is_blocked).length;
    },
    async touchLastLogin(id: number): Promise<void> {
      const u = memUsers.find((x) => x.id === id);
      if (u) u.last_login_at = '2026-10-28 12:00:00';
    },
    async updateApiKey(id: number, apiKey: string): Promise<void> {
      const u = memUsers.find((x) => x.id === id);
      if (u) u.api_key = apiKey;
    },
    async setRole(id: number, role: string): Promise<void> {
      const u = memUsers.find((x) => x.id === id);
      if (u) u.role = role;
    },
    async create(data: {
      username: string;
      password_hash: string;
      api_key: string;
      role?: string;
      email?: string | null;
      company_name?: string | null;
      is_superadmin?: boolean | number;
      is_blocked?: boolean | number;
      tariff_plan?: string;
      tariff_limit?: number | null;
      tariff_expires_at?: string | null;
      units_all_kg?: boolean | number;
    }): Promise<number> {
      const id = nextId++;
      memUsers.push({
        id,
        username: data.username,
        password_hash: data.password_hash,
        api_key: data.api_key,
        role: data.role ?? 'user',
        email: data.email ?? null,
        company_name: data.company_name ?? null,
        is_superadmin: data.is_superadmin ? 1 : 0,
        is_blocked: data.is_blocked ? 1 : 0,
        tariff_plan: data.tariff_plan ?? 'beta',
        tariff_limit: data.tariff_limit ?? null,
        tariff_expires_at: data.tariff_expires_at ?? null,
        units_all_kg: data.units_all_kg ? 1 : 0,
        created_at: '2026-10-28 10:00:00',
        last_login_at: null,
        notify_mode: 'all',
        notify_events: '[]',
        telegram_chat_id: null,
        telegram_bot_token: null,
        sber_purpose_template: '',
      });
      return id;
    },
    async updateUser(id: number, fields: UpdateUserFields): Promise<void> {
      const u = memUsers.find((x) => x.id === id);
      if (!u) return;
      if (fields.username !== undefined) u.username = fields.username;
      if (fields.email !== undefined) u.email = fields.email;
      if (fields.company_name !== undefined) u.company_name = fields.company_name;
      if (fields.password_hash !== undefined) u.password_hash = fields.password_hash;
      if (fields.api_key !== undefined) u.api_key = fields.api_key;
      if (fields.role !== undefined) u.role = fields.role;
      if (fields.is_superadmin !== undefined) u.is_superadmin = fields.is_superadmin ? 1 : 0;
      if (fields.is_blocked !== undefined) u.is_blocked = fields.is_blocked ? 1 : 0;
      if (fields.tariff_plan !== undefined) u.tariff_plan = fields.tariff_plan;
      if (fields.tariff_limit !== undefined) u.tariff_limit = fields.tariff_limit;
      if (fields.tariff_expires_at !== undefined) u.tariff_expires_at = fields.tariff_expires_at;
      if (fields.units_all_kg !== undefined) u.units_all_kg = fields.units_all_kg ? 1 : 0;
      if (fields.telegram_chat_id !== undefined) u.telegram_chat_id = fields.telegram_chat_id;
      if (fields.telegram_bot_token !== undefined) u.telegram_bot_token = fields.telegram_bot_token;
      if (fields.sber_purpose_template !== undefined) u.sber_purpose_template = fields.sber_purpose_template;
    },
    async listAll(): Promise<AdminUserListItem[]> {
      return memUsers.map((u) => ({
        id: u.id,
        username: u.username,
        role: u.role,
        email: u.email,
        company_name: u.company_name ?? null,
        is_superadmin: Boolean(u.is_superadmin),
        is_blocked: Boolean(u.is_blocked),
        tariff_plan: u.tariff_plan ?? 'beta',
        tariff_limit: u.tariff_limit ?? null,
        tariff_expires_at: u.tariff_expires_at ?? null,
        units_all_kg: Boolean(u.units_all_kg),
        telegram_chat_id: u.telegram_chat_id,
        telegram_bot_token_set: Boolean(u.telegram_bot_token),
        sber_purpose_template: u.sber_purpose_template,
        invoice_count: 0,
        created_at: u.created_at,
        last_login_at: u.last_login_at,
      }));
    },
  };
  return { userRepo: repo };
});

vi.mock('../../src/services/companyHealth', () => ({
  listCompanyHealth: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/services/companyUnits', () => ({
  setCompanyAllKg: vi.fn().mockResolvedValue(undefined),
  invalidateCompanyUnits: vi.fn(),
}));

import { apiKeyAuth } from '../../src/api/middleware/auth';
import authRouter from '../../src/api/routes/auth';
import usersRouter from '../../src/api/routes/users';
import billingRouter from '../../src/api/routes/billing';
import { ensureRootSuperadmin, ROOT_SUPERADMIN_EMAIL } from '../../src/auth/seedAdmin';
import { userRepo } from '../../src/database/repositories/userRepo';

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);
app.use('/api/users', apiKeyAuth, usersRouter);
app.use('/api/billing', apiKeyAuth, billingRouter);

describe('Superadmin account, impersonation, access and tariffs', () => {
  beforeEach(() => {
    memUsers.length = 0;
    nextId = 1;
  });

  it('creates root superadmin admin@scanflow.ru when missing and promotes existing account when present', async () => {
    await userRepo.create({
      username: 'admin',
      email: 'owner@company.ru',
      password_hash: hashPassword('secret123'),
      api_key: 'admin-root-key',
      role: 'admin',
    });

    await ensureRootSuperadmin();

    const rootUser = await userRepo.findByEmail(ROOT_SUPERADMIN_EMAIL);
    expect(rootUser).toBeDefined();
    expect(rootUser?.role).toBe('admin');
    expect(Boolean(rootUser?.is_superadmin)).toBe(true);
    expect(rootUser?.tariff_plan).toBe('unlimited');
  });

  it('allows logging in by email (admin@scanflow.ru) or username, and rejects blocked users', async () => {
    const id = await userRepo.create({
      username: 'admin2',
      email: 'admin@scanflow.ru',
      password_hash: hashPassword('superpass123'),
      api_key: 'super-api-key-123',
      role: 'admin',
      is_superadmin: true,
    });

    const loginByEmail = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin@scanflow.ru', password: 'superpass123' });
    expect(loginByEmail.status).toBe(200);
    expect(loginByEmail.body).toMatchObject({
      apiKey: 'super-api-key-123',
      username: 'admin2',
      email: 'admin@scanflow.ru',
      role: 'admin',
      isSuperadmin: true,
    });

    const targetId = await userRepo.create({
      username: 'client1',
      email: 'client1@test.ru',
      password_hash: hashPassword('clientpass'),
      api_key: 'client-api-key-1',
      role: 'user',
    });

    const blockRes = await request(app)
      .patch(`/api/users/${targetId}`)
      .set('x-api-key', 'super-api-key-123')
      .send({ is_blocked: true });
    expect(blockRes.status).toBe(200);
    expect(blockRes.body.data.is_blocked).toBe(true);

    const blockedLogin = await request(app)
      .post('/api/auth/login')
      .send({ username: 'client1@test.ru', password: 'clientpass' });
    expect(blockedLogin.status).toBe(403);

    const blockedApi = await request(app)
      .get('/api/billing')
      .set('x-api-key', 'client-api-key-1');
    expect(blockedApi.status).toBe(403);

    const selfBlock = await request(app)
      .patch(`/api/users/${id}`)
      .set('x-api-key', 'super-api-key-123')
      .send({ is_blocked: true });
    expect(selfBlock.status).toBe(400);
  });

  it('supports creating users, editing credentials/tariffs/roles, and impersonating any user', async () => {
    await userRepo.create({
      username: 'admin',
      email: 'admin@scanflow.ru',
      password_hash: hashPassword('rootpass'),
      api_key: 'root-super-key',
      role: 'admin',
      is_superadmin: true,
    });

    const createRes = await request(app)
      .post('/api/users')
      .set('x-api-key', 'root-super-key')
      .send({
        username: 'newcompany',
        email: 'new@company.ru',
        company_name: 'ООО Новая Компания',
        role: 'user',
        tariff_plan: 'pro',
        tariff_limit: 2500,
        tariff_expires_at: '2026-12-31',
        units_all_kg: true,
      });
    expect(createRes.status).toBe(201);
    expect(createRes.body.generatedPassword).toBeTruthy();
    expect(createRes.body.data).toMatchObject({
      username: 'newcompany',
      email: 'new@company.ru',
      company_name: 'ООО Новая Компания',
      role: 'user',
      tariff_plan: 'pro',
      tariff_limit: 2500,
      units_all_kg: true,
    });

    const targetId = createRes.body.data.id;

    const patchRes = await request(app)
      .patch(`/api/users/${targetId}`)
      .set('x-api-key', 'root-super-key')
      .send({
        username: 'renamed_co',
        email: 'renamed@company.ru',
        password: 'newCustomPassword99',
        tariff_plan: 'business',
        tariff_limit: 15000,
      });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.data).toMatchObject({
      username: 'renamed_co',
      email: 'renamed@company.ru',
      tariff_plan: 'business',
      tariff_limit: 15000,
    });

    const loginRenamed = await request(app)
      .post('/api/auth/login')
      .send({ username: 'renamed@company.ru', password: 'newCustomPassword99' });
    expect(loginRenamed.status).toBe(200);
    expect(loginRenamed.body.username).toBe('renamed_co');

    const impRes = await request(app)
      .post(`/api/users/${targetId}/impersonate`)
      .set('x-api-key', 'root-super-key');
    expect(impRes.status).toBe(200);
    expect(impRes.body.data).toMatchObject({
      id: targetId,
      username: 'renamed_co',
      email: 'renamed@company.ru',
      role: 'user',
    });
    expect(impRes.body.data.apiKey).toBeTruthy();

    const billingRes = await request(app)
      .get('/api/billing')
      .set('x-api-key', impRes.body.data.apiKey);
    expect(billingRes.status).toBe(200);
    expect(billingRes.body.data.subscription).toMatchObject({
      planId: 'business',
      name: 'Бизнес',
      monthlyPriceKopecks: 499000,
      pageLimit: 15000,
    });
  });
});
