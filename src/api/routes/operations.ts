import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import multer from 'multer';
import { config } from '../../config';
import { requireAdmin } from '../middleware/auth';
import { automationRepo, AutomationSettings } from '../../database/repositories/automationRepo';
import { approvalRepo, ApprovalAction, ApprovalStatus, ApprovalRequestRow } from '../../database/repositories/approvalRepo';
import { operationsRepo, ExceptionRow, ReconciliationRow } from '../../database/repositories/operationsRepo';
import { evaluateInvoiceQuality } from '../../automation/qualityGate';
import { invoiceRepo } from '../../database/repositories/invoiceRepo';
import { getDb } from '../../database/db';
import { logger } from '../../utils/logger';
import { createClient } from '../../ocr/claudeApiAnalyzer';
import { parseBankStatement } from '../../operations/bankStatement';
import { bankStatementRepo } from '../../database/repositories/bankStatementRepo';
import { supplierRepo } from '../../database/repositories/supplierRepo';
import { lookupPartyByInn, DadataNotConfiguredError } from '../../sber/dadata';
import { approvalDelegateRepo } from '../../database/repositories/approvalDelegateRepo';
import { userRepo } from '../../database/repositories/userRepo';

const router = Router();
const statementUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

function numericIds(value: unknown, limit = 100): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item: unknown) => Number(item)).filter((item: number) => Number.isFinite(item) && item > 0))].slice(0, limit);
}

function ownerScopeFor(req: Request): number | null {
  return config.dataScopingEnabled && req.user?.role !== 'admin' ? (req.user?.id ?? -1) : null;
}

async function canAccessInvoice(req: Request, invoiceId: number): Promise<boolean> {
  const invoice = await invoiceRepo.getById(invoiceId);
  if (!invoice) return false;
  const owner = ownerScopeFor(req);
  return owner == null || invoice.owner_user_id === owner;
}

function exceptionReasons(row: ExceptionRow, settings: AutomationSettings): string[] {
  const reasons: string[] = [];
  if (row.status === 'error' || row.status === 'failed') reasons.push('Ошибка распознавания');
  if (row.duplicate_of != null || row.status === 'duplicate') reasons.push('Возможный дубликат');
  if (row.items_total_mismatch === 1) reasons.push('Расхождение итоговой суммы');
  if (row.unmapped_count > 0) reasons.push(`Не сопоставлено: ${row.unmapped_count}`);
  if (row.min_confidence != null && row.min_confidence < settings.min_mapping_confidence) reasons.push('Низкая точность сопоставления');
  if (row.elevated_count > 0) reasons.push(`Цена выше обычной: ${row.elevated_count}`);
  if (settings.require_verified_supplier && row.supplier_verified !== 1) reasons.push('Поставщик не подтверждён');
  if (row.pending_approvals > 0) reasons.push('Ожидает согласования');
  if (row.failed_approvals > 0) reasons.push('Ошибка исполнения согласования');
  if (row.onec_status === 'error') reasons.push(`Ошибка 1С${row.onec_error ? `: ${row.onec_error.slice(0, 120)}` : ''}`);
  if (row.onec_status === 'rejected') reasons.push(`Отклонено в 1С${row.onec_error ? `: ${row.onec_error.slice(0, 120)}` : ''}`);
  return reasons;
}

function classifyPayment(row: ReconciliationRow): { code: string; label: string; tone: string } {
  if (row.statement_id) return { code: 'paid', label: 'Оплачено по банковской выписке', tone: 'success' };
  const status = (row.payment_status || '').toLowerCase();
  const amountMismatch = row.payment_amount != null && row.total_sum != null
    && Math.abs(row.payment_amount - row.total_sum) > 1;
  if (!row.payment_id) {
    const overdue = row.due_date != null && row.due_date < new Date().toISOString().slice(0, 10);
    return overdue
      ? { code: 'overdue', label: 'Просрочено, платежа нет', tone: 'danger' }
      : { code: 'missing', label: 'Платёж не создан', tone: 'muted' };
  }
  if (amountMismatch) return { code: 'amount_mismatch', label: 'Сумма не совпадает', tone: 'warning' };
  if (['failed', 'error', 'rejected'].includes(status)) return { code: 'failed', label: 'Ошибка платежа', tone: 'danger' };
  if (['paid', 'executed', 'completed', 'success'].includes(status)) return { code: 'paid', label: 'Оплачено', tone: 'success' };
  return { code: 'pending', label: status === 'created' ? 'Черновик создан' : 'В обработке', tone: 'info' };
}

function aggregateRootCauses(rows: Array<ExceptionRow & { reasons: string[] }>) {
  const counts = (values: string[]) => [...values.reduce((map, value) => map.set(value, (map.get(value) || 0) + 1), new Map<string, number>())]
    .map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  return {
    by_reason: counts(rows.flatMap(row => row.reasons)),
    by_supplier: counts(rows.map(row => row.supplier || 'Поставщик не определён')).slice(0, 10),
    by_document_type: counts(rows.map(row => row.invoice_type || 'Тип не определён')),
  };
}

// ownerUserId обязателен: справочник пер-тенантный, и подтверждать реквизиты
// можно только в карточке своей компании.
async function verifySupplier(inn: string, ownerUserId: number, dadataKey?: string | null): Promise<{ inn: string; status: 'verified' | 'not_found' | 'error'; risk?: string[]; error?: string }> {
  try {
    const supplier = await supplierRepo.findByInn(inn, ownerUserId);
    if (!supplier) return { inn, status: 'error', error: 'Поставщик отсутствует в справочнике' };
    const key = dadataKey === undefined ? (await invoiceRepo.getAnalyzerConfig()).dadata_api_key : dadataKey;
    const party = await lookupPartyByInn(inn, key);
    if (!party) return { inn, status: 'not_found' };
    const clean = (value: string | null) => (value || '').toLocaleLowerCase('ru-RU').replace(/[ё]/g, 'е').replace(/\s+/g, ' ').trim();
    const risk: string[] = [];
    if (party.name && supplier.name && clean(party.name) !== clean(supplier.name)) risk.push('Наименование отличается от ЕГРЮЛ/ЕГРИП');
    if (party.kpp && supplier.kpp && party.kpp !== supplier.kpp) risk.push('КПП отличается');
    if (party.address && supplier.address && clean(party.address) !== clean(supplier.address)) risk.push('Адрес отличается');
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(party)).digest('hex');
    await supplierRepo.update(inn, ownerUserId, {
      verified: 1,
      verification_source: 'dadata',
      verified_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
      verification_fingerprint: fingerprint,
      verification_risk: risk.length ? JSON.stringify(risk) : null,
    });
    return { inn, status: 'verified', risk };
  } catch (error) {
    return { inn, status: 'error', error: error instanceof DadataNotConfiguredError ? 'DaData не настроена' : (error as Error).message };
  }
}

async function executeApprovedAction(req: Request, approval: ApprovalRequestRow): Promise<void> {
  if (approval.action === '1c') {
    await invoiceRepo.approveForOneC(approval.invoice_id);
    return;
  }
  const apiKey = req.headers['x-api-key'];
  const response = await fetch(`http://127.0.0.1:${config.apiPort}/api/invoices/${approval.invoice_id}/send-sber`, {
    method: 'POST',
    headers: { 'X-API-Key': String(apiKey || ''), 'Content-Type': 'application/json', 'X-Approval-Execution': String(approval.id) },
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || `Sber HTTP ${response.status}`);
  }
}

async function canDecideApproval(req: Request, approval: ApprovalRequestRow): Promise<boolean> {
  if (req.user?.role === 'admin') return true;
  if (!req.user?.id || !(await canAccessInvoice(req, approval.invoice_id))) return false;
  const delegation = await approvalDelegateRepo.activeForUser(req.user.id);
  if (!delegation) return false;
  if (delegation.max_amount == null) return true;
  const invoice = await invoiceRepo.getById(approval.invoice_id);
  return Number(invoice?.total_sum || 0) <= delegation.max_amount;
}

async function buildOverview(req: Request) {
  const owner = ownerScopeFor(req);
  const settings = await automationRepo.get();
  const [exceptionRows, approvals, reconciliationRows, suppliers, forecast, reports, delegation] = await Promise.all([
    operationsRepo.exceptions(owner, settings.min_mapping_confidence, settings.require_verified_supplier),
    approvalRepo.list(100, undefined, owner),
    operationsRepo.reconciliation(owner),
    operationsRepo.supplierScores(owner),
    operationsRepo.forecast(owner),
    operationsRepo.reports(owner),
    req.user?.role === 'admin' || !req.user?.id ? Promise.resolve(null) : approvalDelegateRepo.activeForUser(req.user.id),
  ]);
  const [delegates, approvalUsers] = req.user?.role === 'admin'
    ? await Promise.all([approvalDelegateRepo.list(), userRepo.listAll()])
    : [[], []];
  const exceptions = exceptionRows.map(row => ({ ...row, reasons: exceptionReasons(row, settings) }))
    .filter(row => row.reasons.length > 0);
  const reconciliation = reconciliationRows.map(row => ({ ...row, reconciliation: classifyPayment(row) }));
  const paymentSummary = reconciliation.reduce((acc, row) => {
    const code = row.reconciliation.code;
    acc[code] = (acc[code] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const calendar = await operationsRepo.calendar(owner, settings.payment_cash_balance);
  return {
    permissions: { manage: req.user?.role === 'admin', approve: req.user?.role === 'admin' || !!delegation, approval_limit: delegation?.max_amount ?? null },
    settings,
    exceptions,
    approvals,
    reconciliation,
    payment_summary: paymentSummary,
    suppliers,
    forecast,
    calendar,
    reports,
    root_causes: aggregateRootCauses(exceptions),
    approval_delegates: delegates,
    approval_users: approvalUsers.map(user => ({ id: user.id, username: user.username, role: user.role })),
  };
}

router.get('/overview', async (req: Request, res: Response) => {
  try {
    res.json({ data: await buildOverview(req) });
  } catch (error) {
    logger.error('Operations overview failed', { error: (error as Error).message });
    res.status(500).json({ error: (error as Error).message });
  }
});

router.put('/autopilot', requireAdmin, async (req: Request, res: Response) => {
  const body = (req.body || {}) as Partial<AutomationSettings>;
  const patch: Partial<AutomationSettings> = {};
  for (const key of ['auto_send_1c', 'auto_send_sber', 'require_all_mapped', 'block_total_mismatch', 'require_verified_supplier'] as const) {
    if (typeof body[key] === 'boolean') patch[key] = body[key];
  }
  if (body.min_mapping_confidence !== undefined) {
    const value = Number(body.min_mapping_confidence);
    if (!Number.isFinite(value) || value < 0 || value > 1) return res.status(400).json({ error: 'min_mapping_confidence must be between 0 and 1' });
    patch.min_mapping_confidence = value;
  }
  for (const key of ['max_total', 'payment_approval_threshold'] as const) {
    if (body[key] !== undefined) {
      const value = body[key] == null || body[key] === 0 ? null : Number(body[key]);
      if (value != null && (!Number.isFinite(value) || value < 0)) return res.status(400).json({ error: `${key} must be a positive number or null` });
      patch[key] = value;
    }
  }
  if (body.payment_cash_balance !== undefined) {
    const value = body.payment_cash_balance == null ? null : Number(body.payment_cash_balance);
    if (value != null && (!Number.isFinite(value) || value < 0)) return res.status(400).json({ error: 'payment_cash_balance must be zero, a positive number or null' });
    patch.payment_cash_balance = value;
  }
  res.json({ data: await automationRepo.update(patch) });
});

router.get('/quality/:invoiceId', async (req: Request, res: Response) => {
  const invoiceId = Number(req.params.invoiceId);
  if (!Number.isFinite(invoiceId) || !(await canAccessInvoice(req, invoiceId))) return res.status(404).json({ error: 'Invoice not found' });
  res.json({ data: await evaluateInvoiceQuality(invoiceId) });
});

router.get('/approvals', async (req: Request, res: Response) => {
  const status = typeof req.query.status === 'string' && ['pending', 'approved', 'rejected'].includes(req.query.status)
    ? req.query.status as ApprovalStatus
    : undefined;
  res.json({ data: await approvalRepo.list(200, status, ownerScopeFor(req)) });
});

router.post('/approvals', async (req: Request, res: Response) => {
  const invoiceId = Number(req.body?.invoice_id);
  const action = req.body?.action as ApprovalAction;
  if (!Number.isFinite(invoiceId) || !['sber', '1c'].includes(action)) return res.status(400).json({ error: 'invoice_id and action are required' });
  if (!(await canAccessInvoice(req, invoiceId))) return res.status(404).json({ error: 'Invoice not found' });
  const quality = await evaluateInvoiceQuality(invoiceId);
  const row = await approvalRepo.create(invoiceId, action, req.user?.id ?? null, req.body?.note);
  res.status(201).json({ data: row, quality });
});

router.post('/approvals/:id/decision', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const decision = req.body?.decision as 'approved' | 'rejected';
  if (!Number.isFinite(id) || !['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'decision must be approved or rejected' });
  const approval = await approvalRepo.getById(id);
  if (!approval) return res.status(404).json({ error: 'Approval request not found' });
  if (!(await canDecideApproval(req, approval))) return res.status(403).json({ error: 'Нет права согласовать эту сумму' });
  const changed = await approvalRepo.decide(id, decision, req.user?.id ?? null, req.body?.note);
  if (!changed) return res.status(409).json({ error: 'Approval request has already been decided' });
  if (decision === 'rejected') return res.json({ success: true });

  try {
    await executeApprovedAction(req, approval);
    await approvalRepo.setExecutionError(id, null);
    res.json({ success: true, executed: true });
  } catch (error) {
    await approvalRepo.setExecutionError(id, (error as Error).message);
    res.status(502).json({ error: `Согласование сохранено, но выполнение не удалось: ${(error as Error).message}` });
  }
});

router.post('/approvals/batch', async (req: Request, res: Response) => {
  const invoiceIds = numericIds(req.body?.invoice_ids);
  const action = req.body?.action as ApprovalAction;
  if (invoiceIds.length === 0 || !['sber', '1c'].includes(action)) return res.status(400).json({ error: 'invoice_ids and action are required' });
  const batchId = crypto.randomUUID();
  const results: Array<{ invoice_id: number; approval_id?: number; error?: string }> = [];
  for (const invoiceId of invoiceIds) {
    if (!(await canAccessInvoice(req, invoiceId))) { results.push({ invoice_id: invoiceId, error: 'Нет доступа к документу' }); continue; }
    try {
      const row = await approvalRepo.create(invoiceId, action, req.user?.id ?? null, req.body?.note, batchId);
      results.push({ invoice_id: invoiceId, approval_id: row.id });
    } catch (error) {
      results.push({ invoice_id: invoiceId, error: (error as Error).message });
    }
  }
  res.status(201).json({ data: { batch_id: batchId, results } });
});

router.post('/approval-batches/decision', async (req: Request, res: Response) => {
  const ids = numericIds(req.body?.approval_ids);
  const decision = req.body?.decision as 'approved' | 'rejected';
  if (ids.length === 0 || !['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'approval_ids and decision are required' });
  const results: Array<{ approval_id: number; executed?: boolean; error?: string }> = [];
  for (const id of ids) {
    const approval = await approvalRepo.getById(id);
    if (!approval) { results.push({ approval_id: id, error: 'Запрос не найден' }); continue; }
    if (!(await canDecideApproval(req, approval))) { results.push({ approval_id: id, error: 'Нет права согласовать эту сумму' }); continue; }
    const changed = await approvalRepo.decide(id, decision, req.user?.id ?? null, req.body?.note);
    if (!changed) { results.push({ approval_id: id, error: 'Решение уже принято' }); continue; }
    if (decision === 'rejected') { results.push({ approval_id: id, executed: false }); continue; }
    try {
      await executeApprovedAction(req, approval);
      await approvalRepo.setExecutionError(id, null);
      results.push({ approval_id: id, executed: true });
    } catch (error) {
      await approvalRepo.setExecutionError(id, (error as Error).message);
      results.push({ approval_id: id, error: (error as Error).message });
    }
  }
  res.json({ data: { results } });
});

router.post('/exceptions/bulk', async (req: Request, res: Response) => {
  const invoiceIds = numericIds(req.body?.invoice_ids);
  const action = String(req.body?.action || '');
  if (invoiceIds.length === 0 || !['request_1c', 'request_sber', 'approve_1c', 'release_duplicate', 'verify_supplier'].includes(action)) {
    return res.status(400).json({ error: 'Некорректное массовое действие' });
  }
  if (action === 'approve_1c' && req.user?.role !== 'admin') return res.status(403).json({ error: 'Требуется роль администратора' });
  const batchId = crypto.randomUUID();
  const results: Array<{ invoice_id: number; success: boolean; error?: string }> = [];
  for (const invoiceId of invoiceIds) {
    if (!(await canAccessInvoice(req, invoiceId))) { results.push({ invoice_id: invoiceId, success: false, error: 'Нет доступа' }); continue; }
    try {
      if (action === 'release_duplicate') {
        await getDb().prepare(`UPDATE invoices SET duplicate_of = NULL, duplicate_score = NULL, duplicate_reasons = NULL,
          status = CASE WHEN status = 'duplicate' THEN 'processed' ELSE status END WHERE id = ?`).run(invoiceId);
      } else if (action === 'verify_supplier') {
        const invoice = await invoiceRepo.getById(invoiceId);
        const inn = String(invoice?.supplier_inn || '');
        if (!/^\d{10}(\d{2})?$/.test(inn)) throw new Error('У поставщика нет корректного ИНН');
        const verified = await verifySupplier(inn, req.user?.id ?? -1);
        if (verified.status !== 'verified') throw new Error(verified.error || 'Поставщик не найден');
      } else {
        const approval = await approvalRepo.create(invoiceId, action === 'request_sber' ? 'sber' : '1c', req.user?.id ?? null, req.body?.note, batchId);
        if (action === 'approve_1c') {
          await approvalRepo.decide(approval.id, 'approved', req.user?.id ?? null, 'Массовое решение');
          await executeApprovedAction(req, approval);
        }
      }
      results.push({ invoice_id: invoiceId, success: true });
    } catch (error) {
      results.push({ invoice_id: invoiceId, success: false, error: (error as Error).message });
    }
  }
  res.json({ data: { batch_id: batchId, results } });
});

router.post('/bank-statement/import', statementUpload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ error: 'Выберите CSV-файл выписки' });
  try {
    const entries = parseBankStatement(req.file.buffer);
    const result = await bankStatementRepo.import(entries, req.user?.id ?? -1, ownerScopeFor(req));
    res.status(201).json({ data: { ...result, parsed: entries.length } });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

router.get('/bank-statement', async (req: Request, res: Response) => {
  res.json({ data: await bankStatementRepo.list(ownerScopeFor(req)) });
});

router.patch('/calendar/:invoiceId', async (req: Request, res: Response) => {
  const invoiceId = Number(req.params.invoiceId);
  if (!Number.isFinite(invoiceId) || !(await canAccessInvoice(req, invoiceId))) return res.status(404).json({ error: 'Документ не найден' });
  const dueDate = req.body?.payment_due_date == null || req.body.payment_due_date === '' ? null : String(req.body.payment_due_date);
  const priority = String(req.body?.payment_priority || 'normal');
  const holdReason = String(req.body?.payment_hold_reason || '').trim().slice(0, 512) || null;
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return res.status(400).json({ error: 'Дата должна быть в формате ГГГГ-ММ-ДД' });
  if (!['low', 'normal', 'high', 'critical'].includes(priority)) return res.status(400).json({ error: 'Некорректный приоритет' });
  await getDb().prepare('UPDATE invoices SET payment_due_date = ?, payment_priority = ?, payment_hold_reason = ? WHERE id = ?')
    .run(dueDate, priority, holdReason, invoiceId);
  res.json({ success: true });
});

router.post('/suppliers/verify', requireAdmin, async (req: Request, res: Response) => {
  const rawInns: string[] = Array.isArray(req.body?.inns) ? req.body.inns.map((value: unknown) => String(value).replace(/\D/g, '')) : [];
  const inns = [...new Set(rawInns)].filter((inn: string) => /^\d{10}(\d{2})?$/.test(inn)).slice(0, 100);
  if (inns.length === 0) return res.status(400).json({ error: 'Передайте список ИНН' });
  const key = (await invoiceRepo.getAnalyzerConfig()).dadata_api_key;
  const results: Awaited<ReturnType<typeof verifySupplier>>[] = [];
  for (let offset = 0; offset < inns.length; offset += 4) {
    results.push(...await Promise.all(inns.slice(offset, offset + 4).map(inn => verifySupplier(inn, req.user?.id ?? -1, key))));
  }
  res.json({ data: { results } });
});

router.post('/approval-delegates', requireAdmin, async (req: Request, res: Response) => {
  const delegateUserId = Number(req.body?.delegate_user_id);
  const maxAmount = req.body?.max_amount == null || req.body.max_amount === '' ? null : Number(req.body.max_amount);
  const validUntil = req.body?.valid_until == null || req.body.valid_until === '' ? null : String(req.body.valid_until);
  if (!Number.isFinite(delegateUserId) || delegateUserId === req.user?.id || (maxAmount != null && (!Number.isFinite(maxAmount) || maxAmount < 0))) {
    return res.status(400).json({ error: 'Некорректный заместитель или лимит' });
  }
  if (validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) return res.status(400).json({ error: 'Дата должна быть ГГГГ-ММ-ДД' });
  const user = await userRepo.findById(delegateUserId);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  res.status(201).json({ data: await approvalDelegateRepo.create(req.user?.id ?? -1, delegateUserId, maxAmount, validUntil) });
});

router.delete('/approval-delegates/:id', requireAdmin, async (req: Request, res: Response) => {
  const revoked = await approvalDelegateRepo.revoke(Number(req.params.id));
  if (!revoked) return res.status(404).json({ error: 'Активное делегирование не найдено' });
  res.json({ success: true });
});

router.get('/reports', async (req: Request, res: Response) => {
  const owner = ownerScopeFor(req);
  const settings = await automationRepo.get();
  const [reports, rows] = await Promise.all([
    operationsRepo.reports(owner),
    operationsRepo.exceptions(owner, settings.min_mapping_confidence, settings.require_verified_supplier),
  ]);
  const exceptions = rows.map(row => ({ ...row, reasons: exceptionReasons(row, settings) })).filter(row => row.reasons.length > 0);
  res.json({ data: { ...reports, root_causes: aggregateRootCauses(exceptions) } });
});

router.patch('/suppliers/:inn/terms', requireAdmin, async (req: Request, res: Response) => {
  const days = Number(req.body?.payment_terms_days);
  const inn = String(req.params.inn);
  if (!/^\d{10}(\d{2})?$/.test(inn) || !Number.isInteger(days) || days < 0 || days > 365) {
    return res.status(400).json({ error: 'ИНН или срок оплаты некорректен' });
  }
  await getDb().prepare('UPDATE suppliers SET payment_terms_days = ?, updated_at = NOW() WHERE inn = ?').run(days, inn);
  res.json({ success: true });
});

router.post('/assistant', async (req: Request, res: Response) => {
  const question = String(req.body?.question || '').trim().slice(0, 500);
  if (!question) return res.status(400).json({ error: 'Введите вопрос' });
  const data = await buildOverview(req);
  const q = question.toLocaleLowerCase('ru-RU');
  let answer: string;
  let links: Array<{ label: string; href: string }> = [];
  if (/прогноз|расход|сколько.*(плат|денег)/.test(q)) {
    const f = data.forecast;
    answer = `Открытые обязательства: ${f.outstanding.toLocaleString('ru-RU')} ₽. Просрочено ${f.overdue.toLocaleString('ru-RU')} ₽, в ближайшие 7 дней — ${f.days7.toLocaleString('ru-RU')} ₽, затем до 30 дней — ${f.days30.toLocaleString('ru-RU')} ₽.`;
  } else if (/ошиб|исключ|проблем/.test(q)) {
    answer = data.exceptions.length === 0
      ? 'Активных исключений нет: документы проходят текущие правила качества.'
      : `Активных исключений: ${data.exceptions.length}. Самое свежее — ${data.exceptions[0].reasons.join(', ')} у накладной №${data.exceptions[0].invoice_number || data.exceptions[0].id}.`;
    links = data.exceptions.slice(0, 3).map(row => ({ label: `Накладная №${row.invoice_number || row.id}`, href: `#/invoices/${row.id}` }));
  } else if (/дублик/.test(q)) {
    const duplicates = data.exceptions.filter(row => row.duplicate_of != null || row.status === 'duplicate');
    answer = duplicates.length ? `Найдено документов с признаком дубликата: ${duplicates.length}.` : 'Сейчас документов с признаком дубликата нет.';
    links = duplicates.slice(0, 3).map(row => ({ label: `Проверить №${row.invoice_number || row.id}`, href: `#/invoices/${row.id}` }));
  } else if (/поставщик|контрагент|рейтинг/.test(q)) {
    const best = data.suppliers.slice().sort((a, b) => (b.score || 0) - (a.score || 0))[0];
    const risk = data.suppliers.slice().sort((a, b) => (a.score || 0) - (b.score || 0))[0];
    answer = best && risk ? `Лучший текущий рейтинг: ${best.supplier} — ${best.score}/100. Больше всего внимания требует ${risk.supplier} — ${risk.score}/100.` : 'Пока недостаточно данных для рейтинга поставщиков.';
    links = [{ label: 'Открыть поставщиков', href: '#/suppliers' }];
  } else if (/соглас|одобр/.test(q)) {
    const pending = data.approvals.filter(row => row.status === 'pending');
    answer = pending.length ? `Ожидают решения ${pending.length} запросов на согласование.` : 'Запросов, ожидающих согласования, нет.';
  } else if (/плат|сбер|неопла|долг/.test(q)) {
    const summary = data.payment_summary;
    answer = `Сверка: оплачено ${summary.paid || 0}, черновиков/в обработке ${summary.pending || 0}, без платежа ${summary.missing || 0}, просрочено ${summary.overdue || 0}, ошибок ${summary.failed || 0}.`;
  } else {
    answer = 'Я могу показать прогноз расходов, неоплаченные документы, исключения, дубликаты, согласования и рейтинг поставщиков. Например: «что нужно оплатить за 7 дней?»';
  }
  // Claude receives only pre-aggregated operational context — never SQL,
  // credentials or raw OCR text. The deterministic answer above is the safe
  // fallback if the model or proxy is temporarily unavailable.
  try {
    const analyzer = await invoiceRepo.getAnalyzerConfig();
    const apiKey = analyzer.anthropic_api_key || config.anthropicApiKey;
    if (apiKey) {
      const context = {
        forecast: data.forecast,
        payment_summary: data.payment_summary,
        exceptions: data.exceptions.slice(0, 10).map(row => ({ id: row.id, number: row.invoice_number, supplier: row.supplier, total: row.total_sum, reasons: row.reasons })),
        pending_approvals: data.approvals.filter(row => row.status === 'pending').length,
        suppliers: data.suppliers.slice(0, 10).map(row => ({ name: row.supplier, score: row.score, spend: row.total_spend, errors: row.errors, overdue: row.overdue })),
      };
      const response = await createClient(apiKey).messages.create({
        model: analyzer.claude_model,
        max_tokens: 450,
        system: 'Ты операционный помощник ScanFlow. Отвечай по-русски, кратко и конкретно, используя только переданный агрегированный контекст. Не выдумывай платежи, статусы или документы. Не предлагай выполнять действия от имени пользователя.',
        messages: [{ role: 'user', content: `Контекст: ${JSON.stringify(context)}\n\nВопрос: ${question}` }],
      }, { signal: AbortSignal.timeout(25_000) });
      const text = response.content.find(block => block.type === 'text');
      if (text?.type === 'text' && text.text.trim()) answer = text.text.trim();
    }
  } catch (error) {
    logger.warn('Operations assistant model fallback', { error: (error as Error).message });
  }
  res.json({ data: { answer, links, generated_at: new Date().toISOString() } });
});

export default router;
