import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { supplierRepo } from '../../database/repositories/supplierRepo';
import { invoiceRepo } from '../../database/repositories/invoiceRepo';
import { supplierExtractJobRepo } from '../../database/repositories/supplierExtractJobRepo';
import { lookupPartyByInn, DadataNotConfiguredError } from '../../sber/dadata';
import { analyzeImageWithClaudeApi } from '../../ocr/claudeApiAnalyzer';
import { dispatchSupplierExtract, DispatcherConfigError, DispatcherApiError } from '../../dispatcher/createTask';
import { notifySupplierExtractError } from '../../notifications/events';
import { config } from '../../config';
import { logger } from '../../utils/logger';

const router = Router();

// Multer for supplier-extraction uploads. Stores into the persistent
// supplierExtractDir (NOT os.tmpdir): in dispatcher mode the file must outlive
// the request so the external session can download it, and writing here avoids
// a cross-filesystem rename (EXDEV when /tmp is tmpfs). Not data/inbox/, so the
// file watcher never picks it up. Sync mode unlinks it after OCR.
const extractUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      try { fs.mkdirSync(config.supplierExtractDir, { recursive: true }); } catch { /* exists */ }
      cb(null, config.supplierExtractDir);
    },
    filename: (_req, file, cb) => {
      const suffix = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
      cb(null, `supplier-extract-${suffix}${path.extname(file.originalname)}`);
    },
  }),
  fileFilter: (_req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.webp', '.pdf'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error(`Unsupported file type: ${ext}`));
  },
  limits: { fileSize: 20 * 1024 * 1024 },
});

function contentTypeForExt(ext: string): string {
  const e = ext.toLowerCase();
  return e === '.pdf' ? 'application/pdf'
    : e === '.png' ? 'image/png'
    : e === '.webp' ? 'image/webp'
    : e === '.bmp' ? 'image/bmp'
    : e === '.tiff' || e === '.tif' ? 'image/tiff'
    : 'image/jpeg';
}

const INN_RE = /^([0-9]{10}|[0-9]{12})$/;
const BIC_RE = /^[0-9]{9}$/;
const ACC_RE = /^[0-9]{20}$/;

interface SupplierBody {
  inn?: string; name?: string; kpp?: string; account?: string;
  bank_bic?: string; bank_corr_account?: string; bank_name?: string;
  address?: string; verified?: number; source?: string; notes?: string;
}

function validateSupplier(body: SupplierBody | undefined): string | null {
  if (!body || typeof body !== 'object') return 'request body is missing or not application/json';
  if (!body.inn || !INN_RE.test(body.inn)) return 'inn must be 10 or 12 digits';
  if (!body.name || body.name.trim().length === 0) return 'name is required';
  if (!body.bank_bic || !BIC_RE.test(body.bank_bic)) return 'bank_bic must be 9 digits';
  if (body.account && !ACC_RE.test(body.account)) return 'account must be 20 digits';
  if (body.bank_corr_account && !ACC_RE.test(body.bank_corr_account)) return 'bank_corr_account must be 20 digits';
  return null;
}

router.get('/', async (req: Request, res: Response) => {
  const q = (req.query.q as string | undefined) || undefined;
  const verified = req.query.verified !== undefined ? Number(req.query.verified) : undefined;
  const limit = Math.min(parseInt((req.query.limit as string) || '100', 10), 500);
  const offset = parseInt((req.query.offset as string) || '0', 10);
  const suppliers = await supplierRepo.list({ q, verified, limit, offset });
  return res.json({ suppliers });
});

router.get('/:inn', async (req: Request, res: Response) => {
  const supplier = await supplierRepo.findByInn((req.params.inn as string));
  if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
  return res.json({ supplier });
});

router.post('/', async (req: Request, res: Response) => {
  const err = validateSupplier(req.body as SupplierBody);
  if (err) return res.status(400).json({ error: err });
  const body = req.body as Required<Pick<SupplierBody, 'inn' | 'name' | 'bank_bic'>> & SupplierBody;
  if (await supplierRepo.findByInn(body.inn)) {
    return res.status(409).json({ error: 'Supplier with this INN already exists' });
  }
  const supplier = await supplierRepo.create({
    inn: body.inn, name: body.name, bank_bic: body.bank_bic,
    kpp: body.kpp ?? null, account: body.account ?? null,
    bank_corr_account: body.bank_corr_account ?? null,
    bank_name: body.bank_name ?? null, address: body.address ?? null,
    verified: 1, // ручное создание = подтверждено
    source: body.source ?? 'manual',
    notes: body.notes ?? null,
  });
  return res.status(201).json({ supplier });
});

router.patch('/:inn', async (req: Request, res: Response) => {
  const existing = await supplierRepo.findByInn((req.params.inn as string));
  if (!existing) return res.status(404).json({ error: 'Supplier not found' });
  const body = req.body as SupplierBody;
  if (body.bank_bic && !BIC_RE.test(body.bank_bic)) return res.status(400).json({ error: 'bank_bic must be 9 digits' });
  if (body.account && !ACC_RE.test(body.account)) return res.status(400).json({ error: 'account must be 20 digits' });
  if (body.bank_corr_account && !ACC_RE.test(body.bank_corr_account)) return res.status(400).json({ error: 'bank_corr_account must be 20 digits' });
  await supplierRepo.update((req.params.inn as string), body);
  return res.json({ supplier: await supplierRepo.findByInn((req.params.inn as string)) });
});

router.delete('/:inn', async (req: Request, res: Response) => {
  await supplierRepo.delete((req.params.inn as string));
  return res.json({ success: true });
});

// POST /api/suppliers/extract-from-photo — extract payee requisites from a
// photo/PDF. In dispatcher mode this is ASYNC: a job is created and dispatched
// to ProjectsFlow, and the route returns { jobId } immediately — the UI polls
// GET /extract-status/:jobId. In claude_api/hybrid mode it stays synchronous,
// returning { extracted } directly. Never saves a supplier (user confirms via
// POST /api/suppliers/merge).
router.post('/extract-from-photo', extractUpload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const tmpPath = req.file.path;
  const ext = path.extname(req.file.originalname).toLowerCase();
  const cfg = await invoiceRepo.getAnalyzerConfig();

  // ── Dispatcher mode: async via ProjectsFlow ──
  // The uploaded file already sits in the persistent supplierExtractDir (multer
  // storage), so it survives until the external session downloads it.
  if (cfg.mode === 'dispatcher') {
    let jobId: number | null = null;
    try {
      const token = crypto.randomBytes(32).toString('hex');
      jobId = await supplierExtractJobRepo.create({
        token,
        file_name: req.file.originalname,
        file_path: tmpPath,
        content_type: contentTypeForExt(ext),
      });
      await dispatchSupplierExtract(jobId, token, ext || '.jpg');
      logger.info('Supplier extract: dispatched', { jobId, fileName: req.file.originalname });
      return res.json({ jobId, async: true });
    } catch (err) {
      fs.promises.unlink(tmpPath).catch(() => { /* best-effort */ });
      // Dispatch failed before any task was created — finalise the job so it
      // doesn't sit in 'processing' until the 15-min stale sweep. The client
      // gets a clear status and offers a Retry (re-uploads the file → new job).
      if (jobId != null) await supplierExtractJobRepo.setError(jobId, (err as Error).message).catch(() => {});
      notifySupplierExtractError(req.file.originalname, (err as Error).message).catch(() => {});
      if (err instanceof DispatcherConfigError) return res.status(503).json({ error: err.message });
      if (err instanceof DispatcherApiError) return res.status(502).json({ error: err.message });
      logger.error('Supplier extract dispatch failed', { error: (err as Error).message });
      return res.status(500).json({ error: (err as Error).message });
    }
  }

  // ── claude_api / hybrid mode: synchronous Claude API (images only) ──
  try {
    if (ext === '.pdf') {
      return res.status(400).json({ error: 'PDF поддерживается только в режиме диспетчера. Загрузите фото (JPG/PNG).' });
    }
    const apiKey = cfg?.anthropic_api_key || config.anthropicApiKey;
    if (!apiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });
    const modelId = cfg?.claude_model || 'claude-sonnet-5';

    logger.info('Supplier extract: starting Claude OCR', { fileName: req.file.originalname, size: req.file.size });
    const result = await analyzeImageWithClaudeApi(tmpPath, apiKey, modelId);
    if (!result.success || !result.data) {
      return res.status(500).json({ error: result.error || 'Claude API failed' });
    }
    const d = result.data;
    res.json({
      extracted: {
        inn: d.supplier_inn ?? null,
        name: d.supplier ?? null,
        bank_bic: d.supplier_bik ?? null,
        account: d.supplier_account ?? null,
        bank_corr_account: d.supplier_corr_account ?? null,
        address: d.supplier_address ?? null,
        kpp: null,
        bank_name: null,
      },
    });
  } catch (err) {
    logger.error('Supplier extract failed', { error: (err as Error).message });
    res.status(500).json({ error: (err as Error).message });
  } finally {
    fs.promises.unlink(tmpPath).catch(() => { /* best-effort */ });
  }
});

// GET /api/suppliers/extract-status/:jobId — poll an async extraction job.
router.get('/extract-status/:jobId', async (req: Request, res: Response) => {
  const id = parseInt(req.params.jobId as string, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid job id' });
  const job = await supplierExtractJobRepo.getById(id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  if (job.status === 'done') {
    let extracted: unknown = null;
    try { extracted = JSON.parse(job.result_json || '{}'); } catch { extracted = {}; }
    return res.json({ status: 'done', extracted });
  }
  if (job.status === 'error') return res.json({ status: 'error', error: job.error || 'recognition failed' });
  return res.json({ status: 'processing' });
});

// POST /api/suppliers/merge — INSERT or merge-empty-fields. Returns mode.
router.post('/merge', async (req: Request, res: Response) => {
  const body = req.body as SupplierBody;
  const err = validateSupplier(body);
  if (err) return res.status(400).json({ error: err });
  const result = await supplierRepo.mergeEmpty({
    inn: body.inn!,
    name: body.name!,
    bank_bic: body.bank_bic!,
    kpp: body.kpp ?? null,
    account: body.account ?? null,
    bank_corr_account: body.bank_corr_account ?? null,
    bank_name: body.bank_name ?? null,
    address: body.address ?? null,
    verified: body.verified ?? 0,
    source: body.source ?? 'photo-extract',
    notes: body.notes ?? null,
  });
  return res.json(result);
});

router.post('/lookup-dadata', async (req: Request, res: Response) => {
  const inn = (req.body as { inn?: string }).inn;
  if (!inn || !INN_RE.test(inn)) return res.status(400).json({ error: 'inn must be 10 or 12 digits' });
  try {
    // Key from the Settings UI (analyzer_config) takes precedence; lookupPartyByInn
    // falls back to process.env.DADATA_API_KEY when this is null.
    const cfg = await invoiceRepo.getAnalyzerConfig();
    const party = await lookupPartyByInn(inn, cfg.dadata_api_key);
    if (!party) return res.json({ party: null });
    return res.json({ party });
  } catch (err) {
    if (err instanceof DadataNotConfiguredError) {
      return res.status(503).json({ error: 'DaData not configured' });
    }
    return res.status(502).json({ error: (err as Error).message });
  }
});

export default router;
