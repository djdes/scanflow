import { Router, Request, Response } from 'express';
import { supplierRepo } from '../../database/repositories/supplierRepo';
import { lookupPartyByInn, DadataNotConfiguredError } from '../../sber/dadata';

const router = Router();

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

router.get('/', (req: Request, res: Response) => {
  const q = (req.query.q as string | undefined) || undefined;
  const verified = req.query.verified !== undefined ? Number(req.query.verified) : undefined;
  const limit = Math.min(parseInt((req.query.limit as string) || '100', 10), 500);
  const offset = parseInt((req.query.offset as string) || '0', 10);
  const suppliers = supplierRepo.list({ q, verified, limit, offset });
  return res.json({ suppliers });
});

router.get('/:inn', (req: Request, res: Response) => {
  const supplier = supplierRepo.findByInn((req.params.inn as string));
  if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
  return res.json({ supplier });
});

router.post('/', (req: Request, res: Response) => {
  const err = validateSupplier(req.body as SupplierBody);
  if (err) return res.status(400).json({ error: err });
  const body = req.body as Required<Pick<SupplierBody, 'inn' | 'name' | 'bank_bic'>> & SupplierBody;
  if (supplierRepo.findByInn(body.inn)) {
    return res.status(409).json({ error: 'Supplier with this INN already exists' });
  }
  const supplier = supplierRepo.create({
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

router.patch('/:inn', (req: Request, res: Response) => {
  const existing = supplierRepo.findByInn((req.params.inn as string));
  if (!existing) return res.status(404).json({ error: 'Supplier not found' });
  const body = req.body as SupplierBody;
  if (body.bank_bic && !BIC_RE.test(body.bank_bic)) return res.status(400).json({ error: 'bank_bic must be 9 digits' });
  if (body.account && !ACC_RE.test(body.account)) return res.status(400).json({ error: 'account must be 20 digits' });
  if (body.bank_corr_account && !ACC_RE.test(body.bank_corr_account)) return res.status(400).json({ error: 'bank_corr_account must be 20 digits' });
  supplierRepo.update((req.params.inn as string), body);
  return res.json({ supplier: supplierRepo.findByInn((req.params.inn as string)) });
});

router.delete('/:inn', (req: Request, res: Response) => {
  supplierRepo.delete((req.params.inn as string));
  return res.json({ success: true });
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
