import { Router, Request, Response } from 'express';
import multer from 'multer';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { supplierRepo } from '../../database/repositories/supplierRepo';
import { invoiceRepo } from '../../database/repositories/invoiceRepo';
import { lookupPartyByInn, DadataNotConfiguredError } from '../../sber/dadata';
import { analyzeImageWithClaudeApi } from '../../ocr/claudeApiAnalyzer';
import { config } from '../../config';
import { logger } from '../../utils/logger';

const router = Router();

// Multer for supplier-extraction uploads — stores to OS tempdir so the file
// watcher never sees it (different dir than data/inbox/).
const extractUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, file, cb) => {
      const suffix = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
      cb(null, `supplier-extract-${suffix}${path.extname(file.originalname)}`);
    },
  }),
  fileFilter: (_req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error(`Unsupported file type: ${ext}`));
  },
  limits: { fileSize: 20 * 1024 * 1024 },
});

const INN_RE = /^([0-9]{10}|[0-9]{12})$/;
const BIC_RE = /^[0-9]{9}$/;
const ACC_RE = /^[0-9]{20}$/;

interface SupplierBody {
  inn?: string; name?: string; kpp?: string; account?: string;
  bank_bic?: string; bank_corr_account?: string; bank_name?: string;
  address?: string; verified?: number; source?: string; notes?: string;
}

function validateSupplier(body: SupplierBody): string | null {
  if (!body.inn || !INN_RE.test(body.inn)) return 'inn must be 10 or 12 digits';
  if (!body.name || body.name.length === 0) return 'name is required';
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

// POST /api/suppliers/extract-from-photo — accept image, run Claude API
// invoice analyzer, return parsed supplier fields. Does NOT save anything.
// UI shows result as a preview card; user confirms via POST /api/suppliers/merge.
router.post('/extract-from-photo', extractUpload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const filePath = req.file.path;
  try {
    // Resolve API key (same logic as invoice route — DB row first, then env).
    const cfg = await invoiceRepo.getAnalyzerConfig();
    const apiKey = cfg?.anthropic_api_key || config.anthropicApiKey;
    if (!apiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });
    const modelId = cfg?.claude_model || 'claude-sonnet-4-6';

    logger.info('Supplier extract: starting Claude OCR', { fileName: req.file.originalname, size: req.file.size });
    const result = await analyzeImageWithClaudeApi(filePath, apiKey, modelId);
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
      raw: {
        invoice_type: d.invoice_type,
        invoice_number: d.invoice_number,
        invoice_date: d.invoice_date,
      },
    });
  } catch (err) {
    logger.error('Supplier extract failed', { error: (err as Error).message });
    res.status(500).json({ error: (err as Error).message });
  } finally {
    fs.promises.unlink(filePath).catch(() => { /* best-effort */ });
  }
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
    const party = await lookupPartyByInn(inn);
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
