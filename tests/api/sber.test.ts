import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { resetDb } from '../helpers/db';
import { sberTokenRepo } from '../../src/database/repositories/sberTokenRepo';

vi.mock('../../src/sber/oauth', async () => {
  return {
    exchangeCodeForToken: vi.fn(),
    buildAuthUrl: vi.fn(() => 'https://sbi.sberbank.ru:9443/oauth?state=X'),
    createOAuthState: vi.fn().mockResolvedValue('STATE-JWT'),
    verifyOAuthState: vi.fn().mockResolvedValue({ purpose: 'connect' }),
    refreshAccessToken: vi.fn(),
    getValidAccessToken: vi.fn(),
  };
});
vi.mock('../../src/sber/clientInfo', () => ({
  fetchClientInfo: vi.fn().mockResolvedValue({
    orgName: 'ООО Тест',
    accountNumber: '40702810940000099835',
  }),
}));

import sberRouter from '../../src/api/routes/sber';
import { exchangeCodeForToken } from '../../src/sber/oauth';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sber', sberRouter);
  return app;
}

describe('sber routes', () => {
  beforeEach(() => {
    resetDb();
    vi.mocked(exchangeCodeForToken).mockReset();
  });

  describe('GET /api/sber/authorize', () => {
    it('redirects to Sber OAuth url', async () => {
      const res = await request(makeApp()).get('/api/sber/authorize');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('sbi.sberbank.ru');
    });
  });

  describe('GET /api/sber/callback', () => {
    it('exchanges code, saves token, redirects with success', async () => {
      vi.mocked(exchangeCodeForToken).mockResolvedValue({ accessToken: 'a', refreshToken: 'r', expiresIn: 3600 });
      const res = await request(makeApp()).get('/api/sber/callback?code=CODE&state=STATE-JWT');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('sber=connected');
      expect(sberTokenRepo.get()?.access_token).toBe('a');
    });

    it('redirects with error on missing params', async () => {
      const res = await request(makeApp()).get('/api/sber/callback');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('sber=error');
    });
  });

  describe('POST /api/sber/seed-token', () => {
    it('saves token and reqs', async () => {
      const res = await request(makeApp())
        .post('/api/sber/seed-token')
        .send({
          access_token: 'a', refresh_token: 'r',
          account_number: '40702810940000099835',
          org_name: 'ООО Т',
          payer_inn: '7707083893',
          payer_kpp: '770701001',
          payer_bank_bic: '044525225',
          payer_bank_corr_account: '30101810400000000225',
        });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(sberTokenRepo.get()?.org_name).toBe('ООО Т');
    });

    it('rejects 20-digit account validation failure', async () => {
      const res = await request(makeApp())
        .post('/api/sber/seed-token')
        .send({ access_token: 'a', refresh_token: 'r', account_number: '407' });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/sber/status', () => {
    it('returns connected=false when no token', async () => {
      const res = await request(makeApp()).get('/api/sber/status');
      expect(res.body.connected).toBe(false);
    });

    it('returns connected=true with details', async () => {
      sberTokenRepo.upsert({
        access_token: 'a', refresh_token: 'r',
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
        account_number: '40702810940000099835',
        org_name: 'ООО Т',
        payer_inn: '7707083893',
        payer_kpp: '770701001',
        payer_bank_bic: '044525225',
        payer_bank_corr_account: '30101810400000000225',
      });
      const res = await request(makeApp()).get('/api/sber/status');
      expect(res.body).toMatchObject({
        connected: true,
        account_number: '40702810940000099835',
        org_name: 'ООО Т',
        token_expired: false,
        payer_complete: true,
      });
    });

    it('payer_complete=false when fields missing', async () => {
      sberTokenRepo.upsert({
        access_token: 'a', refresh_token: 'r',
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      });
      const res = await request(makeApp()).get('/api/sber/status');
      expect(res.body.payer_complete).toBe(false);
    });
  });

  describe('POST /api/sber/disconnect', () => {
    it('removes token', async () => {
      sberTokenRepo.upsert({ access_token: 'a', refresh_token: 'r', expires_at: '2099-01-01T00:00:00.000Z' });
      const res = await request(makeApp()).post('/api/sber/disconnect');
      expect(res.status).toBe(200);
      expect(sberTokenRepo.get()).toBeNull();
    });
  });

  describe('PATCH /api/sber/payer', () => {
    it('returns 404 when no connection', async () => {
      const res = await request(makeApp()).patch('/api/sber/payer').send({ payer_inn: '7707083893' });
      expect(res.status).toBe(404);
    });

    it('updates payer details', async () => {
      sberTokenRepo.upsert({ access_token: 'a', refresh_token: 'r', expires_at: '2099-01-01T00:00:00.000Z' });
      const res = await request(makeApp()).patch('/api/sber/payer').send({
        payer_inn: '7707083893',
        payer_bank_bic: '044525225',
        payer_bank_corr_account: '30101810400000000225',
      });
      expect(res.status).toBe(200);
      expect(sberTokenRepo.get()?.payer_inn).toBe('7707083893');
    });
  });
});
