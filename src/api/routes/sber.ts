import { Router, Request, Response } from 'express';
import { logger } from '../../utils/logger';
import { requireAdmin } from '../middleware/auth';
import { sberTokenRepo } from '../../database/repositories/sberTokenRepo';
import {
  buildAuthUrl, createOAuthState, verifyOAuthState,
  exchangeCodeForToken,
} from '../../sber/oauth';
import { fetchClientInfo } from '../../sber/clientInfo';
import { logIntegrationEvent } from '../../integration/integrationLog';

const router = Router();

const ACC_RE = /^[0-9]{20}$/;
const BIC_RE = /^[0-9]{9}$/;
const INN_RE = /^([0-9]{10}|[0-9]{12})$/;

// Владелец подключения — всегда текущий пользователь. Значения по умолчанию нет:
// роуты под apiKeyAuth, запрос без пользователя сюда не доходит, а если дойдёт —
// пусть падает явно, а не работает с чужим банковским подключением.
function ownerOf(req: Request): number {
  const id = req.user?.id;
  if (id == null) throw new Error('sber route reached without an authenticated user');
  return id;
}

router.get('/authorize', requireAdmin, async (req: Request, res: Response) => {
  try {
    // Владелец кладётся в подписанное состояние OAuth: /callback приходит
    // редиректом от Сбера и своего req.user не имеет, а подпись HS256 не даёт
    // подменить компанию, на которую ляжет подключение.
    const state = await createOAuthState({ purpose: 'connect', owner_user_id: ownerOf(req) });
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

  // Владелец берётся из подписанного состояния, а не из запроса: редирект от
  // Сбера не аутентифицирован. Без владельца подключение класть некуда.
  const ownerUserId = typeof stateData.owner_user_id === 'number' ? stateData.owner_user_id : null;
  if (ownerUserId == null) return fail('state_without_owner');

  try {
    const token = await exchangeCodeForToken(code);
    const expiresAt = new Date(Date.now() + token.expiresIn * 1000).toISOString();
    await sberTokenRepo.upsert({
      access_token: token.accessToken,
      refresh_token: token.refreshToken,
      expires_at: expiresAt,
    }, ownerUserId);
    try {
      const info = await fetchClientInfo(token.accessToken);
      await sberTokenRepo.updatePayerDetails({
        org_name: info.orgName,
        account_number: info.accountNumber,
      }, ownerUserId);
    } catch (infoErr) {
      logger.warn('[sber] client-info fetch failed (non-fatal)', { err: (infoErr as Error).message });
    }
    void logIntegrationEvent({ integration: 'sber', event_type: 'config_changed', summary: 'Сбербанк подключён (OAuth)' });
    return res.redirect('/#/sber?sber=connected');
  } catch (err) {
    logger.error('[sber] callback failed', { err: (err as Error).message });
    return fail((err as Error).message);
  }
});

router.post('/seed-token', requireAdmin, async (req: Request, res: Response) => {
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
  }, ownerOf(req));
  void logIntegrationEvent({ integration: 'sber', event_type: 'config_changed', summary: 'Сбербанк подключён (токен вручную)' });
  return res.json({ success: true });
});

router.patch('/payer', requireAdmin, async (req: Request, res: Response) => {
  const t = await sberTokenRepo.get(ownerOf(req));
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
  }, ownerOf(req));
  return res.json({ success: true });
});

router.get('/status', async (req: Request, res: Response) => {
  const t = await sberTokenRepo.get(ownerOf(req));
  if (!t) return res.json({ connected: false });
  const tokenExpired = new Date(t.expires_at).getTime() < Date.now();
  const payerComplete = !!(
    t.account_number &&
    t.org_name &&
    t.payer_inn &&
    t.payer_bank_bic &&
    t.payer_bank_corr_account
  );
  // Non-admins (onboarding gate) only learn whether the platform Sber
  // connection is usable; the owner's bank/payer details are admin-only.
  if (req.user?.role !== 'admin') {
    return res.json({ connected: true, token_expired: tokenExpired, payer_complete: payerComplete });
  }
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

router.post('/disconnect', requireAdmin, async (req: Request, res: Response) => {
  await sberTokenRepo.clear(ownerOf(req));
  void logIntegrationEvent({ integration: 'sber', event_type: 'config_changed', summary: 'Сбербанк отключён' });
  return res.json({ success: true });
});

export default router;
