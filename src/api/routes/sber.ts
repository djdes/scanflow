import { Router, Request, Response } from 'express';
import { logger } from '../../utils/logger';
import { sberTokenRepo } from '../../database/repositories/sberTokenRepo';
import {
  buildAuthUrl, createOAuthState, verifyOAuthState,
  exchangeCodeForToken,
} from '../../sber/oauth';
import { fetchClientInfo } from '../../sber/clientInfo';

const router = Router();

const ACC_RE = /^[0-9]{20}$/;
const BIC_RE = /^[0-9]{9}$/;
const INN_RE = /^([0-9]{10}|[0-9]{12})$/;

router.get('/authorize', async (_req: Request, res: Response) => {
  try {
    const state = await createOAuthState({ purpose: 'connect' });
    const url = buildAuthUrl(state);
    return res.redirect(url);
  } catch (err) {
    logger.error('[sber] authorize failed', { err: (err as Error).message });
    return res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  const error = req.query.error as string | undefined;

  const fail = (reason: string) => {
    return res.redirect(`/#/sber?sber=error&sber_error=${encodeURIComponent(reason)}`);
  };

  if (error) return fail(error);
  if (!code || !state) return fail('missing_params');

  const stateData = await verifyOAuthState(state);
  if (!stateData) return fail('invalid_state');

  try {
    const token = await exchangeCodeForToken(code);
    const expiresAt = new Date(Date.now() + token.expiresIn * 1000).toISOString();
    await sberTokenRepo.upsert({
      access_token: token.accessToken,
      refresh_token: token.refreshToken,
      expires_at: expiresAt,
    });
    try {
      const info = await fetchClientInfo(token.accessToken);
      await sberTokenRepo.updatePayerDetails({
        org_name: info.orgName,
        account_number: info.accountNumber,
      });
    } catch (infoErr) {
      logger.warn('[sber] client-info fetch failed (non-fatal)', { err: (infoErr as Error).message });
    }
    return res.redirect('/#/sber?sber=connected');
  } catch (err) {
    logger.error('[sber] callback failed', { err: (err as Error).message });
    return fail((err as Error).message);
  }
});

router.post('/seed-token', async (req: Request, res: Response) => {
  const {
    access_token, refresh_token, expires_at, account_number, org_name,
    payer_inn, payer_kpp, payer_bank_bic, payer_bank_corr_account,
  } = req.body as Record<string, string | undefined>;
  if (!access_token || !refresh_token) {
    return res.status(400).json({ error: 'access_token and refresh_token are required' });
  }
  if (account_number && !ACC_RE.test(account_number)) {
    return res.status(400).json({ error: 'account_number must be 20 digits' });
  }
  if (payer_bank_bic && !BIC_RE.test(payer_bank_bic)) {
    return res.status(400).json({ error: 'payer_bank_bic must be 9 digits' });
  }
  if (payer_bank_corr_account && !ACC_RE.test(payer_bank_corr_account)) {
    return res.status(400).json({ error: 'payer_bank_corr_account must be 20 digits' });
  }
  if (payer_inn && !INN_RE.test(payer_inn)) {
    return res.status(400).json({ error: 'payer_inn must be 10 or 12 digits' });
  }
  const expiresAt = expires_at
    ? new Date(expires_at).toISOString()
    : new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  await sberTokenRepo.upsert({
    access_token, refresh_token, expires_at: expiresAt,
    account_number: account_number ?? null,
    org_name: org_name ?? null,
    payer_inn: payer_inn ?? null,
    payer_kpp: payer_kpp ?? null,
    payer_bank_bic: payer_bank_bic ?? null,
    payer_bank_corr_account: payer_bank_corr_account ?? null,
  });
  return res.json({ success: true });
});

router.patch('/payer', async (req: Request, res: Response) => {
  const t = await sberTokenRepo.get();
  if (!t) return res.status(404).json({ error: 'Sber not connected' });
  const {
    payer_inn, payer_kpp, payer_bank_bic, payer_bank_corr_account,
    account_number, org_name,
  } = req.body as Record<string, string | undefined>;
  if (payer_bank_bic && !BIC_RE.test(payer_bank_bic)) {
    return res.status(400).json({ error: 'payer_bank_bic must be 9 digits' });
  }
  if (payer_bank_corr_account && !ACC_RE.test(payer_bank_corr_account)) {
    return res.status(400).json({ error: 'payer_bank_corr_account must be 20 digits' });
  }
  if (account_number && !ACC_RE.test(account_number)) {
    return res.status(400).json({ error: 'account_number must be 20 digits' });
  }
  if (payer_inn && !INN_RE.test(payer_inn)) {
    return res.status(400).json({ error: 'payer_inn must be 10 or 12 digits' });
  }
  await sberTokenRepo.updatePayerDetails({
    payer_inn, payer_kpp, payer_bank_bic, payer_bank_corr_account,
    account_number, org_name,
  });
  return res.json({ success: true });
});

router.get('/status', async (_req: Request, res: Response) => {
  const t = await sberTokenRepo.get();
  if (!t) return res.json({ connected: false });
  const tokenExpired = new Date(t.expires_at).getTime() < Date.now();
  const payerComplete = !!(
    t.account_number &&
    t.org_name &&
    t.payer_inn &&
    t.payer_bank_bic &&
    t.payer_bank_corr_account
  );
  return res.json({
    connected: true,
    account_number: t.account_number,
    org_name: t.org_name,
    payer_inn: t.payer_inn,
    payer_kpp: t.payer_kpp,
    payer_bank_bic: t.payer_bank_bic,
    payer_bank_corr_account: t.payer_bank_corr_account,
    token_expired: tokenExpired,
    payer_complete: payerComplete,
  });
});

router.post('/disconnect', async (_req: Request, res: Response) => {
  await sberTokenRepo.clear();
  return res.json({ success: true });
});

export default router;
