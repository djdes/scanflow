import { sberTokenRepo } from '../database/repositories/sberTokenRepo';
import { sberPaymentRepo } from '../database/repositories/sberPaymentRepo';
import { getValidAccessToken, withSberToken, SberAuthError, REFRESH_TOKEN_TTL_DAYS } from '../sber/oauth';
import { getPaymentState, SberApiError, FINAL_BANK_STATUSES, bankStatusKind, bankStatusLabel } from '../sber/payments';
import { secretStatus, parseDbUtc } from '../sber/appCredentials';
import { sendOwnerAlert } from './ownerAlerts';
import { logIntegrationEvent } from '../integration/integrationLog';
import { logger } from '../utils/logger';

const SBER_PAGE = 'https://scanflow.ru/#/sber';

/**
 * Ночное обслуживание подключений к Сбербанку (дизайн 2026-09-29):
 *  • раз в сутки обновить пару токенов — refresh_token живёт 180 дней с
 *    последнего использования, так подключение не протухает, даже если месяцами
 *    не создавать платёжки;
 *  • не удалось — сообщить владельцу в Telegram (не чаще раза в сутки), а не
 *    молча ждать 403 при следующей оплате.
 * Действующий токен при неудаче не стирается: пара из личного кабинета живёт
 * 30 дней и продолжит работать, пока человек чинит причину.
 */
export async function keepSberTokensAlive(): Promise<{ refreshed: number; failed: number }> {
  let refreshed = 0;
  let failed = 0;
  for (const owner of await sberTokenRepo.listOwners()) {
    const row = await sberTokenRepo.get(owner);
    if (!row) continue;
    const last = parseDbUtc(row.last_refresh_at ?? null) ?? parseDbUtc(row.refresh_obtained_at ?? null);
    if (last && Date.now() - last.getTime() < 20 * 3_600_000) continue;
    try {
      await getValidAccessToken(owner, { force: true });
      refreshed++;
    } catch (err) {
      failed++;
      const msg = (err as Error).message;
      logger.warn('[sber] keep-alive refresh failed', { owner, error: msg });
      await sendOwnerAlert(owner, 'sber_auth',
        `⚠️ Сбербанк: не удалось обновить доступ.\n${msg}\n\nЧто сделать: ${SBER_PAGE}`, 24);
    }
  }
  if (refreshed || failed) logger.info('[sber] keep-alive done', { refreshed, failed });
  return { refreshed, failed };
}

/**
 * client_secret на 40 дней (введён в ScanFlow и не переведён в бессрочный):
 * предупредить за 5 дней. Сами не меняем — старый секрет после замены
 * перестаёт действовать, а тот же client_id может использовать другая программа.
 */
export async function warnSberSecretExpiry(): Promise<void> {
  const owners = await sberTokenRepo.listOwners();
  if (!owners.length) return;
  const st = await secretStatus();
  if (st.source !== 'db' || st.perpetual || st.days_left == null || st.days_left > 5) return;
  const when = st.days_left <= 0 ? 'истёк' : `истекает через ${st.days_left} дн.`;
  for (const owner of owners) {
    await sendOwnerAlert(owner, 'sber_secret',
      `⚠️ Сбербанк: client_secret приложения ${when}. Без него токены не обновятся.\n`
      + `Откройте ${SBER_PAGE} и нажмите «Сделать бессрочным» (или вставьте новый секрет из личного кабинета Sber API).`, 24);
  }
}

export interface PollResult { checked: number; changed: number; errors: number; skipped_owners: number }

/**
 * Опрос банковского статуса созданных черновиков: пока не «Исполнен» или не
 * окончательный отказ. Последовательно, с паузой — это фон, спешить некуда.
 * Отказ банка — сообщение владельцу (один раз на платёжку).
 */
export async function pollSberPaymentStatuses(opts: { ownerUserId?: number; minAgeMinutes?: number } = {}): Promise<PollResult> {
  const res: PollResult = { checked: 0, changed: 0, errors: 0, skipped_owners: 0 };
  const rows = await sberPaymentRepo.listToPoll([...FINAL_BANK_STATUSES], {
    ownerUserId: opts.ownerUserId, minAgeMinutes: opts.minAgeMinutes ?? 25, limit: 200,
  });
  const blocked = new Set<number>();
  for (const r of rows) {
    if (blocked.has(r.owner_user_id)) continue;
    try {
      const st = await withSberToken(r.owner_user_id, t => getPaymentState(t, r.external_id));
      res.checked++;
      await sberPaymentRepo.updateBankStatus(r.invoice_id, st.bankStatus, st.bankComment);
      if (st.bankStatus !== r.bank_status) {
        res.changed++;
        const label = bankStatusLabel(st.bankStatus);
        const kind = bankStatusKind(st.bankStatus);
        void logIntegrationEvent({
          integration: 'sber', event_type: 'payment_status', status: kind === 'failed' ? 'error' : 'ok',
          invoice_id: r.invoice_id,
          summary: `Платёжка по №${r.invoice_number ?? r.invoice_id}: ${label}`,
          detail: { bank_status: st.bankStatus, bank_comment: st.bankComment },
        });
        if (kind === 'failed') {
          await sendOwnerAlert(r.owner_user_id, `pay_fail:${r.invoice_id}`,
            `❌ Сбербанк: платёжка по накладной №${r.invoice_number ?? '—'} (${r.supplier ?? 'поставщик не указан'}, ${r.amount} ₽) — ${label}.`
            + (st.bankComment ? `\nКомментарий банка: ${st.bankComment}` : '')
            + `\nНакладная: https://scanflow.ru/#/invoices/${r.invoice_id}`, 24 * 365);
        }
      }
    } catch (err) {
      if (err instanceof SberApiError && err.status === 404) {
        await sberPaymentRepo.updateBankStatus(r.invoice_id, 'NOT_FOUND', null);
        res.changed++;
        continue;
      }
      if (err instanceof SberAuthError) {
        // Нет доступа — остальные платёжки этой компании опрашивать бессмысленно.
        blocked.add(r.owner_user_id);
        res.skipped_owners++;
        logger.warn('[sber] status poll: auth problem, owner skipped', { owner: r.owner_user_id, error: err.message });
        continue;
      }
      res.errors++;
      await sberPaymentRepo.markChecked(r.invoice_id).catch(() => {});
      logger.warn('[sber] status poll failed', { invoice_id: r.invoice_id, error: (err as Error).message });
    }
    await new Promise(r2 => setTimeout(r2, 300));
  }
  if (res.checked || res.errors) logger.info('[sber] payment status poll', res);
  return res;
}

/** Когда истечёт refresh_token (180 дней с получения), для показа на странице. */
export function refreshExpiresAt(refreshObtainedAt: string | null | undefined): string | null {
  const d = parseDbUtc(refreshObtainedAt ?? null);
  if (!d) return null;
  return new Date(d.getTime() + REFRESH_TOKEN_TTL_DAYS * 86_400_000).toISOString();
}
