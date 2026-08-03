import { config } from '../config';
import { automationRepo } from '../database/repositories/automationRepo';
import { approvalRepo } from '../database/repositories/approvalRepo';
import type { Invoice } from '../database/repositories/invoiceRepo';

/**
 * Массовая отправка накладных в 1С / Сбер.
 *
 * Стратегия — loopback: делаем внутренний HTTP-POST на уже существующий
 * одиночный роут (`/:id/send`, `/:id/send-sber`) под ключом владельца,
 * переиспользуя ВСЮ его валидацию, ничего в нём не меняя (как
 * src/services/autoSendSber.ts). Одиночные роуты — критический денежный путь,
 * трогать их ради bulk нельзя.
 *
 * «Пропустить + отчёт»: заведомо неотправляемые (не processed / уже одобрено /
 * выше лимита / неверифицированный поставщик / уже оплачено / …) не роняют
 * пачку, а попадают в `skipped` с причиной. Approval-запросы в bulk НЕ создаём —
 * over_threshold отсекается pre-check'ом ДО loopback.
 */
export interface BulkResult {
  sent: number;
  skipped: Array<{ id: number; reason: string }>;
  total: number;
}

async function loopbackPost(path: string, apiKey: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${config.apiPort}${path}`, {
    method: 'POST',
    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

export async function bulkSend1c(invoices: Invoice[], apiKey: string): Promise<BulkResult> {
  const threshold = (await automationRepo.get()).payment_approval_threshold;
  const skipped: Array<{ id: number; reason: string }> = [];
  let sent = 0;

  for (const inv of invoices) {
    if (inv.status !== 'processed') { skipped.push({ id: inv.id, reason: 'not_processed' }); continue; }
    if (inv.approved_for_1c) { skipped.push({ id: inv.id, reason: 'already_approved' }); continue; }
    // over_threshold — отсекаем ДО loopback, чтобы одиночный роут не создал
    // approval-запрос (в bulk их не плодим).
    if (threshold != null && (inv.total_sum ?? 0) > threshold && !(await approvalRepo.hasApproved(inv.id, '1c'))) {
      skipped.push({ id: inv.id, reason: 'over_threshold' }); continue;
    }
    const { status } = await loopbackPost(`/api/invoices/${inv.id}/send`, apiKey);
    if (status === 200) sent++;
    else if (status === 400) skipped.push({ id: inv.id, reason: 'not_processed' });
    else skipped.push({ id: inv.id, reason: 'error' });
  }
  return { sent, skipped, total: invoices.length };
}

export async function bulkSendSber(invoices: Invoice[], apiKey: string): Promise<BulkResult> {
  const threshold = (await automationRepo.get()).payment_approval_threshold;
  const skipped: Array<{ id: number; reason: string }> = [];
  let sent = 0;

  for (const inv of invoices) {
    if (threshold != null && (inv.total_sum ?? 0) > threshold && !(await approvalRepo.hasApproved(inv.id, 'sber'))) {
      skipped.push({ id: inv.id, reason: 'over_threshold' }); continue;
    }
    const { status, json } = await loopbackPost(`/api/invoices/${inv.id}/send-sber`, apiKey);
    if (status === 200 && json.success) { sent++; continue; }
    if (status === 409 && json.needs_supplier_confirmation) { skipped.push({ id: inv.id, reason: 'supplier_unverified' }); continue; }
    if (status === 409 && json.needs_approval) { skipped.push({ id: inv.id, reason: 'over_threshold' }); continue; }
    // Чек-лист сверенных реквизитов не закрыт. Проверяем ДО общего 409, иначе
    // причина попала бы в отчёт как «уже оплачено» и сбивала бы с толку.
    if (status === 409 && Array.isArray(json.attrs_unchecked)) {
      skipped.push({ id: inv.id, reason: 'attrs_unchecked' }); continue;
    }
    if (status === 409) { skipped.push({ id: inv.id, reason: 'already_paid' }); continue; }
    if (status === 400) {
      const err = String(json.error ?? '');
      const reason = err.includes('supplier_inn') ? 'no_inn'
        : err.includes('total_sum') ? 'no_total'
        : err.includes('not connected') ? 'sber_not_connected'
        : err.includes('payer details') ? 'payer_incomplete'
        : err.includes('владелец') ? 'no_owner'
        : 'invalid';
      skipped.push({ id: inv.id, reason }); continue;
    }
    if (status === 502) { skipped.push({ id: inv.id, reason: 'api_error' }); continue; }
    skipped.push({ id: inv.id, reason: 'error' });
  }
  return { sent, skipped, total: invoices.length };
}
