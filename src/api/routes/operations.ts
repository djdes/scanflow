import { Router, Request, Response } from 'express';
import { config } from '../../config';
import { requireAdmin } from '../middleware/auth';
import { automationRepo, AutomationSettings } from '../../database/repositories/automationRepo';
import { approvalRepo, ApprovalAction, ApprovalStatus } from '../../database/repositories/approvalRepo';
import { operationsRepo, ExceptionRow, ReconciliationRow } from '../../database/repositories/operationsRepo';
import { evaluateInvoiceQuality } from '../../automation/qualityGate';
import { invoiceRepo } from '../../database/repositories/invoiceRepo';
import { getDb } from '../../database/db';
import { logger } from '../../utils/logger';
import { createClient } from '../../ocr/claudeApiAnalyzer';

const router = Router();

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
  return reasons;
}

function classifyPayment(row: ReconciliationRow): { code: string; label: string; tone: string } {
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

async function buildOverview(req: Request) {
  const owner = ownerScopeFor(req);
  const settings = await automationRepo.get();
  const [exceptionRows, approvals, reconciliationRows, suppliers, forecast] = await Promise.all([
    operationsRepo.exceptions(owner, settings.min_mapping_confidence, settings.require_verified_supplier),
    approvalRepo.list(100, undefined, owner),
    operationsRepo.reconciliation(owner),
    operationsRepo.supplierScores(owner),
    operationsRepo.forecast(owner),
  ]);
  const exceptions = exceptionRows.map(row => ({ ...row, reasons: exceptionReasons(row, settings) }))
    .filter(row => row.reasons.length > 0);
  const reconciliation = reconciliationRows.map(row => ({ ...row, reconciliation: classifyPayment(row) }));
  const paymentSummary = reconciliation.reduce((acc, row) => {
    const code = row.reconciliation.code;
    acc[code] = (acc[code] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  return {
    permissions: { manage: req.user?.role === 'admin' },
    settings,
    exceptions,
    approvals,
    reconciliation,
    payment_summary: paymentSummary,
    suppliers,
    forecast,
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

router.post('/approvals/:id/decision', requireAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const decision = req.body?.decision as 'approved' | 'rejected';
  if (!Number.isFinite(id) || !['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'decision must be approved or rejected' });
  const approval = await approvalRepo.getById(id);
  if (!approval) return res.status(404).json({ error: 'Approval request not found' });
  const changed = await approvalRepo.decide(id, decision, req.user?.id ?? null, req.body?.note);
  if (!changed) return res.status(409).json({ error: 'Approval request has already been decided' });
  if (decision === 'rejected') return res.json({ success: true });

  try {
    if (approval.action === '1c') {
      await invoiceRepo.approveForOneC(approval.invoice_id);
    } else {
      const apiKey = req.headers['x-api-key'];
      const response = await fetch(`http://127.0.0.1:${config.apiPort}/api/invoices/${approval.invoice_id}/send-sber`, {
        method: 'POST',
        headers: { 'X-API-Key': String(apiKey || ''), 'Content-Type': 'application/json', 'X-Approval-Execution': String(id) },
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || `Sber HTTP ${response.status}`);
      }
    }
    await approvalRepo.setExecutionError(id, null);
    res.json({ success: true, executed: true });
  } catch (error) {
    await approvalRepo.setExecutionError(id, (error as Error).message);
    res.status(502).json({ error: `Согласование сохранено, но выполнение не удалось: ${(error as Error).message}` });
  }
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
