import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth';
import { invoiceRepo } from '../../database/repositories/invoiceRepo';
import { goldenRepo, GOLDEN_RUN_MAX_INVOICES } from '../../database/repositories/goldenRepo';
import {
  startGoldenRun,
  activeGoldenRunId,
  reconcileInterruptedGoldenRuns,
  GoldenRunBusyError,
  GoldenRunConfigError,
} from '../../golden/goldenRunner';
import { logger } from '../../utils/logger';
import { isXmlInvoice } from '../../xml';

/**
 * /api/golden — эталонные накладные (п.17 пакета v2). Монтируется за apiKeyAuth.
 *
 *   PATCH /invoices/:id  {golden:boolean} — отметить/снять эталон. Только
 *                        владелец накладной (чужая → 404, как в invoices.ts).
 *   POST  /run           {limit?, invoice_ids?} — admin: запустить прогон в фоне.
 *   GET   /runs          — admin: последние 20 прогонов.
 *   GET   /runs/:id      — admin: прогон целиком (результаты по накладным).
 *
 * Изоляция (правило 19): прогон берёт ТОЛЬКО эталоны вызывающего и показывает
 * только его прогоны — роль admin открывает запуск (платформенная операция:
 * вызовы Claude за счёт общего ключа), но не чужие накладные.
 */
const router = Router();

const DEFAULT_RUN_LIMIT = 10;
const RUNS_LIST_LIMIT = 20;

function parseId(raw: unknown): number | null {
  const n = typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseJson(text: string | null | undefined): unknown {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// PATCH /api/golden/invoices/:id — { golden: boolean }
router.patch('/invoices/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (id == null) return res.status(400).json({ error: 'invalid id' });
  const golden = (req.body as { golden?: unknown } | undefined)?.golden;
  if (typeof golden !== 'boolean') return res.status(400).json({ error: 'golden must be boolean' });

  const invoice = await invoiceRepo.getById(id);
  // 404, а не 403 — чтобы не подтверждать существование чужой накладной.
  if (!invoice || invoice.owner_user_id !== req.user?.id) {
    return res.status(404).json({ error: 'Invoice not found' });
  }
  // Эталон проверяет распознавание фото; документ из XML не распознаётся.
  if (golden && isXmlInvoice(invoice)) {
    return res.status(409).json({ error: 'Накладная загружена из XML — распознавания нет, эталоном она быть не может' });
  }

  await goldenRepo.setGolden(id, golden);
  const state = await goldenRepo.getGoldenState(id);
  logger.info('Golden flag changed', { invoiceId: id, golden, by: req.user?.id });
  return res.json({ data: { id, golden: state?.golden ?? golden, golden_at: state?.golden_at ?? null } });
});

// POST /api/golden/run — { limit?: number (1..50, по умолчанию 10), invoice_ids?: number[] }
router.post('/run', requireAdmin, async (req: Request, res: Response) => {
  const ownerUserId = req.user!.id;
  const body = (req.body ?? {}) as { limit?: unknown; invoice_ids?: unknown };

  let limit = DEFAULT_RUN_LIMIT;
  if (body.limit !== undefined && body.limit !== null) {
    const n = Number(body.limit);
    if (!Number.isFinite(n) || n < 1) {
      return res.status(400).json({ error: `limit must be a number from 1 to ${GOLDEN_RUN_MAX_INVOICES}` });
    }
    limit = Math.min(GOLDEN_RUN_MAX_INVOICES, Math.floor(n));
  }

  let invoiceIds: number[] | null = null;
  if (body.invoice_ids !== undefined && body.invoice_ids !== null) {
    if (!Array.isArray(body.invoice_ids)
      || body.invoice_ids.length > GOLDEN_RUN_MAX_INVOICES
      || !body.invoice_ids.every(v => Number.isInteger(v) && (v as number) > 0)) {
      return res.status(400).json({ error: `invoice_ids must be an array of up to ${GOLDEN_RUN_MAX_INVOICES} invoice ids` });
    }
    invoiceIds = body.invoice_ids as number[];
  }

  const busy = activeGoldenRunId();
  if (busy !== null) {
    return res.status(409).json({ error: 'Прогон эталонов уже идёт — дождитесь окончания', run_id: busy || null });
  }

  await reconcileInterruptedGoldenRuns();
  const ids = await goldenRepo.listGoldenInvoiceIds(ownerUserId, { limit, invoiceIds });
  if (ids.length === 0) {
    return res.status(400).json({
      error: invoiceIds
        ? 'Среди указанных накладных нет ваших эталонов'
        : 'Эталонов пока нет — отметьте проверенные накладные кнопкой «☆ В эталоны»',
    });
  }

  try {
    const { runId, model } = await startGoldenRun({ ownerUserId, startedBy: ownerUserId, invoiceIds: ids });
    logger.info('Golden run requested', { runId, by: ownerUserId, invoices: ids.length, model });
    // 202: прогон идёт в фоне (каждая накладная — минуты), статус — GET /runs/:id.
    return res.status(202).json({ run_id: runId, invoice_count: ids.length, model });
  } catch (err) {
    if (err instanceof GoldenRunBusyError) {
      return res.status(409).json({ error: err.message, run_id: err.runId || null });
    }
    if (err instanceof GoldenRunConfigError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }
});

// GET /api/golden/runs — последние прогоны вызывающего
router.get('/runs', requireAdmin, async (req: Request, res: Response) => {
  const ownerUserId = req.user!.id;
  await reconcileInterruptedGoldenRuns();
  const [runs, goldenCount] = await Promise.all([
    goldenRepo.listRuns(ownerUserId, RUNS_LIST_LIMIT),
    goldenRepo.countGolden(ownerUserId),
  ]);
  const active = activeGoldenRunId();
  return res.json({
    data: runs.map(r => ({
      id: r.id,
      started_at: r.started_at,
      finished_at: r.finished_at,
      status: r.status,
      model: r.model,
      summary: parseJson(r.summary),
    })),
    golden_count: goldenCount,
    active_run_id: active || null,
  });
});

// GET /api/golden/runs/:id — прогон с результатами по каждой накладной
router.get('/runs/:id', requireAdmin, async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (id == null) return res.status(400).json({ error: 'invalid id' });
  const run = await goldenRepo.getRun(id);
  if (!run || run.owner_user_id !== req.user?.id) {
    return res.status(404).json({ error: 'Run not found' });
  }
  return res.json({
    data: {
      id: run.id,
      started_at: run.started_at,
      finished_at: run.finished_at,
      status: run.status,
      model: run.model,
      summary: parseJson(run.summary),
      results: parseJson(run.results) ?? [],
    },
  });
});

export default router;
