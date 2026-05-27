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
import { resolveAndApplyPackTransform } from '../../mapping/packTransform';
import { onecNomenclatureRepo } from '../../database/repositories/onecNomenclatureRepo';
import { buildPrompt } from '../../ocr/claudeApiAnalyzer';

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

// GET /api/dispatcher/prompt — serve the OCR system prompt as plain text.
// The dispatcher Claude Code session fetches this URL and uses it verbatim
// when analysing the photo. We can't embed the full prompt in the PF task
// description because PF has a 5000-char limit on description.
router.get('/prompt', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(buildPrompt());
});

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

/**
 * Find an existing invoice that the CURRENT one is a continuation of
 * (multi-page invoice — one PDF/scan split across multiple upload events).
 * Mirrors fileWatcher's strategies A/C/D, the ones that cover dispatcher's
 * upload paths. Strategy B (mobile camera `photo_N_*` filenames) and B2
 * (row_no continuation) are not ported — they're edge cases.
 *
 * Returns the existing invoice row if a match is found, else null.
 */
async function findMultiPageTarget(
  currentInvoiceId: number,
  parsed: ParsedInvoiceData,
): Promise<{ id: number; invoice_number: string | null; supplier: string | null; total_sum: number | null; vat_sum: number | null } | null> {
  // A) match by invoice_number (within last 10 min)
  if (parsed.invoice_number) {
    const e = await invoiceRepo.findRecentByNumber(
      parsed.invoice_number,
      parsed.supplier ?? undefined,
      10,
    );
    if (e && e.id !== currentInvoiceId) return e;
  }
  // C) same supplier within 5 min AND current page has no invoice_number
  //    (page-2 of a multi-page where the number was only on page-1).
  if (parsed.supplier && !parsed.invoice_number) {
    const e = await invoiceRepo.findRecentBySupplier(parsed.supplier, currentInvoiceId, 5);
    if (e) return e;
  }
  // D) no metadata at all → continuation of most recent in last 2 min.
  if (!parsed.invoice_number && !parsed.supplier) {
    const e = await invoiceRepo.findMostRecentProcessedForContinuation(currentInvoiceId, 2);
    if (e) return e;
  }
  return null;
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
    // Multi-page merge: if this is a continuation of a recently-processed
    // invoice, append items to that target instead of leaving an orphan row.
    const mergeTarget = await findMultiPageTarget(id, data);
    const targetInvoiceId = mergeTarget?.id ?? id;
    const isMerge = !!mergeTarget;

    if (isMerge) {
      logger.info('dispatcher result: multi-page merge', {
        currentInvoiceId: id, targetInvoiceId, supplier: data.supplier, number: data.invoice_number,
      });
      // Backfill missing header fields onto the existing invoice. Don't
      // overwrite — first page is canonical for everything except total_sum
      // (which only appears on the LAST page).
      await invoiceRepo.updateInvoiceData(targetInvoiceId, {
        invoice_number: mergeTarget.invoice_number ? undefined : (data.invoice_number ?? undefined),
        supplier: mergeTarget.supplier ? undefined : (data.supplier ?? undefined),
        total_sum: data.total_sum != null ? data.total_sum : (mergeTarget.total_sum == null ? undefined : undefined),
        vat_sum: data.vat_sum != null ? data.vat_sum : (mergeTarget.vat_sum == null ? undefined : undefined),
      });
      // Items will be appended to targetInvoiceId below. Mark the current
      // row as duplicate so it's hidden from the dashboard and not re-pickable.
      await invoiceRepo.updateStatus(id, 'duplicate');
    } else {
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
    }
    for (const it of data.items as ParsedInvoiceItem[]) {
      // 1) Resolve mapping (1C catalog match) + apply pack-size transform.
      //    Dispatcher returns qty/unit/price AS WRITTEN on the invoice
      //    (e.g. "5 кор × 7.5кг"). resolveAndApplyPackTransform expands
      //    that to canonical 1C unit (e.g. 37.5 кг × 1010₽/кг) using the
      //    pack_size hint Claude extracted from the name ("9-12", "1/12",
      //    "*48", etc.) OR the learned mapping in nomenclature_mappings.
      let transformedItem = {
        quantity: it.quantity ?? null,
        unit: it.unit ?? null,
        price: it.price ?? null,
        total: it.total ?? null,
      };
      let mapping: Awaited<ReturnType<NomenclatureMapper['map']>> | null = null;
      if (mapper && it.name) {
        try {
          mapping = await mapper.map(it.name);
        } catch (err) {
          logger.warn('dispatcher result: mapping failed', { itemName: it.name, error: (err as Error).message });
        }
      }
      if (mapping && mapping.onec_guid) {
        const onec = await onecNomenclatureRepo.getByGuid(mapping.onec_guid);
        const hintedPackSize = it.pack_size ?? mapping.pack_size;
        const hintedPackUnit = it.pack_size ? 'шт' : mapping.pack_unit;
        const r = resolveAndApplyPackTransform(
          transformedItem,
          it.name ?? '',
          hintedPackSize,
          hintedPackUnit,
          mapping.mapped_name,
          onec?.unit ?? null,
        );
        transformedItem = r.item;
      }

      // 2) Persist the (possibly transformed) item — onto target invoice
      //    (which is `id` when standalone, `mergeTarget.id` when multi-page).
      const inserted = await invoiceRepo.addItem({
        invoice_id: targetInvoiceId,
        original_name: it.name ?? '',
        mapped_name: mapping?.mapped_name ?? undefined,
        quantity: transformedItem.quantity ?? undefined,
        unit: transformedItem.unit ?? undefined,
        price: transformedItem.price ?? undefined,
        total: transformedItem.total ?? undefined,
        vat_rate: it.vat_rate ?? undefined,
        mapping_confidence: mapping?.confidence ?? 0,
        onec_guid: mapping?.onec_guid ?? undefined,
      });
      void inserted; // for await/lint
    }
    if (!isMerge) {
      await invoiceRepo.updateStatus(id, 'processed');
    }
    await clearDispatcherState(id);
    logger.info('dispatcher result: invoice processed', {
      invoiceId: id, targetInvoiceId, items: data.items.length, merged: isMerge,
    });
    res.json({ ok: true, status: isMerge ? 'merged' : 'processed', targetInvoiceId });
  } catch (err) {
    logger.error('dispatcher result: write failed', { invoiceId: id, error: (err as Error).message });
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
