import { Router, Request, Response } from 'express';
import { invoiceRepo } from '../../database/repositories/invoiceRepo';
import { queueRepo } from '../../database/repositories/queueRepo';
import { isWorkable } from '../../services/queue';
import { loadQueueList, loadQueueCard } from '../../services/queueList';
import {
  startQueueReocr,
  applyQueueReocr,
  revertQueueReocr,
  reocrView,
  reconcileInterruptedReocr,
  ReocrApplyError,
} from '../../services/queueReocr';
import { startQueueLlmMap } from '../../services/queueLlmMap';
import { queueJobStatus, cancelQueueJob, QueueJobBusyError, QueueStartError, type QueueJobKind } from '../../services/queueJobs';
import type { NomenclatureMapper } from '../../mapping/nomenclatureMapper';
import { logger } from '../../utils/logger';

/**
 * /api/queue — «Очередь в 1С» (агент A, дизайн 2026-09-29). Монтируется за apiKeyAuth.
 *
 *   GET  /                       очередь компании: готовность к 1С и что держит,
 *                                строки, Сбер, перераспознавание; итоги; фоновые задачи
 *   GET  /:id                    накладная: замечания по строкам, сравнение
 *                                перераспознавания с текущими строками
 *   GET  /:id/reocr              только перераспознавание накладной (со сравнением)
 *   POST /:id/reocr/apply        { fingerprint } — заменить строки перераспознанными
 *   POST /:id/reocr/revert       { fingerprint } — вернуть строки, какие были до применения
 *   POST /reocr                  { ids?, redo? } — перераспознать очередь (или выбранные) в фоне
 *   GET  /reocr/status           ход перераспознавания
 *   POST /reocr/cancel           остановить после текущей накладной
 *   POST /llm-map                { ids? } — подобрать позиции ИИ для очереди в фоне
 *   GET  /llm-map/status
 *   POST /llm-map/cancel
 *
 * Изоляция (правило 19): всё — только накладные вызывающего (owner_user_id =
 * req.user.id), чужая накладная → 404. Одобрение для 1С — существующий
 * POST /api/invoices/send-1c-batch (его правила не дублируем), правка строк —
 * маршруты /api/invoices/*.
 */
const router = Router();

let mapper: NomenclatureMapper | null = null;
export function setMapper(m: NomenclatureMapper): void {
  mapper = m;
}

function ownerOf(req: Request, res: Response): number | null {
  const id = req.user?.id;
  if (id == null) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  return id;
}

function parseId(raw: unknown): number | null {
  const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const MAX_IDS = 500;

/** { ids?: number[] } → undefined (вся очередь) | number[] | null (ошибка — ответ уже отправлен). */
function parseBodyIds(req: Request, res: Response): number[] | undefined | null {
  const raw = (req.body as { ids?: unknown } | undefined)?.ids;
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_IDS || !raw.every(v => Number.isSafeInteger(v) && (v as number) > 0)) {
    res.status(400).json({ error: `ids — массив от 1 до ${MAX_IDS} номеров накладных` });
    return null;
  }
  return raw as number[];
}

function sendStartError(res: Response, err: unknown): boolean {
  if (err instanceof QueueJobBusyError) {
    res.status(409).json({ error: err.message, busy: { kind: err.kind, own: err.own } });
    return true;
  }
  if (err instanceof QueueStartError) {
    res.status(err.status).json({ error: err.message });
    return true;
  }
  return false;
}

/** Строки 'running', оборванные перезапуском, — в ошибку до того, как их показать. */
async function reconcile(owner: number): Promise<void> {
  await reconcileInterruptedReocr(owner).catch(err => logger.warn('queue: reconcile failed', { error: (err as Error).message }));
}

// GET /api/queue
router.get('/', async (req: Request, res: Response) => {
  const owner = ownerOf(req, res);
  if (owner == null) return;
  await reconcile(owner);
  res.json(await loadQueueList(owner));
});

function jobRoutes(kind: QueueJobKind, path: string, start: (owner: number, req: Request, ids: number[] | undefined) => Promise<unknown>): void {
  router.get(`/${path}/status`, async (req: Request, res: Response) => {
    const owner = ownerOf(req, res);
    if (owner == null) return;
    res.json({ data: queueJobStatus(owner, kind) });
  });

  router.post(`/${path}`, async (req: Request, res: Response) => {
    const owner = ownerOf(req, res);
    if (owner == null) return;
    const ids = parseBodyIds(req, res);
    if (ids === null) return;
    try {
      const started = await start(owner, req, ids);
      // 202: задача идёт в фоне (каждая накладная — до пары минут), ход — GET /status.
      res.status(202).json({ data: started });
    } catch (err) {
      if (!sendStartError(res, err)) throw err;
    }
  });

  router.post(`/${path}/cancel`, async (req: Request, res: Response) => {
    const owner = ownerOf(req, res);
    if (owner == null) return;
    res.json({ data: { cancelled: cancelQueueJob(owner, kind) } });
  });
}

jobRoutes('reocr', 'reocr', async (owner, req, ids) => {
  if (!mapper) throw new QueueStartError(500, 'Mapper not initialized');
  const redo = (req.body as { redo?: unknown } | undefined)?.redo === true;
  const r = await startQueueReocr({ ownerUserId: owner, startedBy: req.user?.id ?? null, invoiceIds: ids ?? null, redo, mapper });
  logger.info('Queue re-OCR requested', { owner, planned: r.planned, selected: ids?.length ?? null, redo });
  return r;
});

jobRoutes('llm_map', 'llm-map', async (owner, req, ids) => {
  const r = await startQueueLlmMap({ ownerUserId: owner, startedBy: req.user?.id ?? null, invoiceIds: ids ?? null });
  logger.info('Queue LLM mapping requested', { owner, planned: r.planned, selected: ids?.length ?? null });
  return r;
});

/** Накладная вызывающего или null (404 уже отправлен). */
async function loadOwnedInvoice(req: Request, res: Response, owner: number) {
  const id = parseId(req.params.id);
  const inv = id != null ? await invoiceRepo.getById(id) : undefined;
  if (!inv || inv.owner_user_id !== owner) {
    res.status(404).json({ error: 'Invoice not found' });
    return null;
  }
  return inv;
}

// GET /api/queue/:id
router.get('/:id', async (req: Request, res: Response) => {
  const owner = ownerOf(req, res);
  if (owner == null) return;
  const inv = await loadOwnedInvoice(req, res, owner);
  if (!inv) return;
  // Открытие владельцем = прочитано (как карточка /api/invoices/:id).
  if (inv.read_at == null) await invoiceRepo.setRead(inv.id, true);
  await reconcile(owner);
  res.json({ data: await loadQueueCard(owner, inv) });
});

// GET /api/queue/:id/reocr
router.get('/:id/reocr', async (req: Request, res: Response) => {
  const owner = ownerOf(req, res);
  if (owner == null) return;
  const inv = await loadOwnedInvoice(req, res, owner);
  if (!inv) return;
  await reconcile(owner);
  const [lines, row] = await Promise.all([
    queueRepo.invoiceLines(owner, inv.id),
    queueRepo.latestReocr(owner, inv.id),
  ]);
  res.json({ data: reocrView(row, lines, { withDiff: true, workable: isWorkable(inv) }) });
});

function lineAction(path: string, action: typeof applyQueueReocr): void {
  router.post(`/:id/reocr/${path}`, async (req: Request, res: Response) => {
    const owner = ownerOf(req, res);
    if (owner == null) return;
    const inv = await loadOwnedInvoice(req, res, owner);
    if (!inv) return;
    const fingerprint = (req.body as { fingerprint?: unknown } | undefined)?.fingerprint;
    if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) {
      return res.status(400).json({ error: 'fingerprint — отпечаток строк из карточки (обновите страницу)' });
    }
    try {
      const r = await action({ ownerUserId: owner, invoiceId: inv.id, userId: req.user?.id ?? null, fingerprint });
      return res.json({ data: { deleted: r.deleted, inserted: r.inserted, total_sum: r.invoice?.total_sum ?? null, items_total_mismatch: r.invoice?.items_total_mismatch ?? 0 } });
    } catch (err) {
      if (err instanceof ReocrApplyError) return res.status(err.status).json({ error: err.message, code: err.code });
      throw err;
    }
  });
}

// POST /api/queue/:id/reocr/apply — { fingerprint }
lineAction('apply', applyQueueReocr);
// POST /api/queue/:id/reocr/revert — { fingerprint }
lineAction('revert', revertQueueReocr);

export default router;
