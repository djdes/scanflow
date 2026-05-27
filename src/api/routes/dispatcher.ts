/**
 * Dispatcher callback router — mounted at /api/dispatcher.
 * Endpoints are NOT under apiKeyAuth (the dispatcher is external and
 * doesn't have an X-API-Key); each route validates a per-task token
 * against invoices.dispatcher_token.
 *
 * GET  /api/dispatcher/photo/:invoiceId?token=<hex>   — download original JPG
 * POST /api/dispatcher/result/:invoiceId              — submit OCR JSON / error
 */
import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { invoiceRepo } from '../../database/repositories/invoiceRepo';
import { validateDispatcherToken, clearDispatcherState } from '../../dispatcher/createTask';
import { logger } from '../../utils/logger';
import { ParsedInvoiceData, ParsedInvoiceItem } from '../../ocr/types';
import { NomenclatureMapper } from '../../mapping/nomenclatureMapper';

const router = Router();
let mapper: NomenclatureMapper | null = null;
export function setMapper(m: NomenclatureMapper): void { mapper = m; }

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.png' ? 'image/png'
    : ext === '.webp' ? 'image/webp'
    : ext === '.bmp' ? 'image/bmp'
    : ext === '.tiff' || ext === '.tif' ? 'image/tiff'
    : 'image/jpeg';
}

router.get('/photo/:invoiceId', async (req: Request, res: Response) => {
  const id = parseInt(req.params.invoiceId as string, 10);
  const token = (req.query.token as string | undefined) ?? '';
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid invoice id' });

  const row = await validateDispatcherToken(id, token);
  if (!row) {
    logger.warn('dispatcher photo: token invalid or invoice not in ocr_processing', { invoiceId: id });
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!fs.existsSync(row.file_path)) {
    logger.warn('dispatcher photo: file missing on disk', { invoiceId: id, path: row.file_path });
    return res.status(404).json({ error: 'photo file missing' });
  }
  res.setHeader('Content-Type', contentTypeFor(row.file_path));
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(row.file_path).pipe(res);
});

interface DispatcherResultBody {
  token?: string;
  success?: boolean;
  data?: ParsedInvoiceData;
  error?: string;
}

router.post('/result/:invoiceId', async (req: Request, res: Response) => {
  const id = parseInt(req.params.invoiceId as string, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid invoice id' });

  const body = (req.body ?? {}) as DispatcherResultBody;
  const row = await validateDispatcherToken(id, body.token ?? '');
  if (!row) {
    logger.warn('dispatcher result: token invalid or already processed', { invoiceId: id });
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (body.success === false || body.error) {
    const msg = (body.error || 'dispatcher reported failure').slice(0, 1000);
    await invoiceRepo.updateStatus(id, 'error', msg);
    await clearDispatcherState(id);
    logger.warn('dispatcher result: error reported', { invoiceId: id, error: msg });
    return res.json({ ok: true, status: 'error' });
  }

  if (!body.success || !body.data || !Array.isArray(body.data.items)) {
    return res.status(400).json({ error: 'success=true requires data.items array' });
  }
  const data = body.data;

  // Defensive: if the dispatcher lost Cyrillic encoding somewhere, the payload
  // arrives full of U+FFFD (Unicode replacement char). Silently storing
  // ◇◇◇◇ in supplier/name is worse than failing loud — refuse.
  // IMPORTANT: do NOT clear state here. This is a transient client-side bug
  // (Windows bash `curl -d` corrupts UTF-8) — dispatcher should retry with
  // `curl --data-binary @file.json` and we want the token to stay valid for
  // that retry. Cron-sweep will mark it error after 15 min if no retry comes.
  const FFFD = '�';
  const checkFields = [data.supplier, data.supplier_address, data.invoice_type, ...data.items.map(i => i?.name ?? '')];
  const totalFFFD = checkFields.reduce((acc, v) => acc + (typeof v === 'string' ? (v.match(new RegExp(FFFD, 'g')) || []).length : 0), 0);
  if (totalFFFD >= 5) {
    logger.warn('dispatcher result: payload looks encoding-broken (≥5 U+FFFD chars) — token preserved for retry', { invoiceId: id, totalFFFD });
    return res.status(400).json({
      error: 'encoding-broken payload rejected',
      totalFFFD,
      hint: 'Use `curl --data-binary @file.json` (write JSON to file via Write tool first). `curl -d "..."` corrupts non-ASCII on Windows bash. Token is still valid — retry is allowed.',
    });
  }

  try {
    await invoiceRepo.updateInvoiceData(id, {
      invoice_type: data.invoice_type ?? undefined,
      invoice_number: data.invoice_number ?? undefined,
      invoice_date: data.invoice_date ?? undefined,
      supplier: data.supplier ?? undefined,
      supplier_inn: data.supplier_inn ?? undefined,
      supplier_bik: data.supplier_bik ?? undefined,
      supplier_account: data.supplier_account ?? undefined,
      supplier_corr_account: data.supplier_corr_account ?? undefined,
      supplier_address: data.supplier_address ?? undefined,
      total_sum: data.total_sum ?? undefined,
      vat_sum: data.vat_sum ?? undefined,
    });
    for (const it of data.items as ParsedInvoiceItem[]) {
      const inserted = await invoiceRepo.addItem({
        invoice_id: id,
        original_name: it.name ?? '',
        mapped_name: undefined,
        quantity: it.quantity ?? undefined,
        unit: it.unit ?? undefined,
        price: it.price ?? undefined,
        total: it.total ?? undefined,
        vat_rate: it.vat_rate ?? undefined,
        mapping_confidence: 0,
        onec_guid: undefined,
      });
      // Best-effort fuzzy mapping (same flow as ordinary OCR path)
      if (mapper && it.name) {
        try {
          const m = await mapper.map(it.name);
          if (m && m.onec_guid) {
            await invoiceRepo.updateItemMapping(inserted.id, m.onec_guid, m.mapped_name, m.confidence ?? 0);
          }
        } catch (err) {
          logger.warn('dispatcher result: mapping failed', { itemName: it.name, error: (err as Error).message });
        }
      }
    }
    await invoiceRepo.updateStatus(id, 'processed');
    await clearDispatcherState(id);
    logger.info('dispatcher result: invoice processed', { invoiceId: id, items: data.items.length });
    res.json({ ok: true, status: 'processed' });
  } catch (err) {
    logger.error('dispatcher result: write failed', { invoiceId: id, error: (err as Error).message });
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
