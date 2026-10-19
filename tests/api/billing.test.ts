import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import billingRouter, { robokassaCallbackRouter } from '../../src/api/routes/billing';

const app = express();
app.use(express.json());
app.use('/api/billing', (req, _res, next) => {
  if (req.header('X-Test-User')) req.user = { id: Number(req.header('X-Test-User')) } as NonNullable<typeof req.user>;
  next();
}, billingRouter);
app.use('/api/payments/robokassa', robokassaCallbackRouter);

describe('billing preparation API', () => {
  it('requires authentication for overview and checkout', async () => {
    expect((await request(app).get('/api/billing')).status).toBe(401);
    expect((await request(app).post('/api/billing/checkout')).status).toBe(401);
  });
  it('returns truthful beta status without fabricated history or credentials', async () => {
    for (const owner of ['1', '2']) {
      const res = await request(app).get('/api/billing').set('X-Test-User', owner);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.data).toMatchObject({ mode: 'beta', payments: { enabled: false, connected: false }, history: [], documents: [],
        subscription: { planId: null, monthlyPriceKopecks: 0, nextPaymentAt: null, autoRenewal: false, pageLimit: null } });
      expect(res.body.data.plans.map((plan: { monthlyPriceKopecks: number }) => plan.monthlyPriceKopecks)).toEqual([0, 99000, 499000]);
      expect(JSON.stringify(res.body)).not.toMatch(/password|merchantLogin|api_key/i);
    }
  });
  it('rejects checkout regardless of client-provided plan, amount or paid status', async () => {
    const res = await request(app).post('/api/billing/checkout').set('X-Test-User', '1')
      .send({ planId: 'pro', amount: 1, status: 'paid', enabled: true });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('PAYMENTS_NOT_ENABLED');
    expect(res.body).not.toHaveProperty('url');
  });
  it('never acknowledges callbacks, including form-encoded POST and GET', async () => {
    const parameters = { InvId: '123', OutSum: '990.000000', SignatureValue: '0'.repeat(64) };
    for (const response of [
      await request(app).get('/api/payments/robokassa/result').query(parameters),
      await request(app).post('/api/payments/robokassa/result').type('form').send(parameters),
    ]) {
      expect(response.status).toBe(503);
      expect(response.text).toBe('PAYMENTS_NOT_ENABLED');
      expect(response.text).not.toContain('OK123');
    }
  });
  it('returns to the billing screen without trusting payment status or redirect input', async () => {
    for (const method of ['get', 'post'] as const) {
      for (const [path, state] of [['success', 'returned'], ['fail', 'cancelled']]) {
        const res = await request(app)[method](`/api/payments/robokassa/${path}`).query({ redirect: 'https://example.org', status: 'paid' });
        expect(res.status).toBe(303);
        expect(res.headers.location).toBe(`/app.html#/billing?payment=${state}`);
      }
    }
    const overview = await request(app).get('/api/billing').set('X-Test-User', '1');
    expect(overview.body.data.history).toEqual([]);
    expect(overview.body.data.subscription.planId).toBeNull();
  });
});
