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
import { supplierExtractJobRepo } from '../../database/repositories/supplierExtractJobRepo';
import { validateDispatcherToken, clearDispatcherState, validateSupplierJobToken } from '../../dispatcher/createTask';
import { logger } from '../../utils/logger';
import { ParsedInvoiceData, ParsedInvoiceItem } from '../../ocr/types';
import { NomenclatureMapper } from '../../mapping/nomenclatureMapper';
import { resolveAndApplyPackTransform } from '../../mapping/packTransform';
import { onecNomenclatureRepo } from '../../database/repositories/onecNomenclatureRepo';
import { buildPrompt, buildSupplierPrompt } from '../../ocr/claudeApiAnalyzer';
import { emit as emitNotification, notifySupplierExtractError } from '../../notifications/events';
import { canonicalizeSupplierName, normalizeInvoiceNumber } from '../../utils/invoiceNumber';
import { userRepo } from '../../database/repositories/userRepo';
import { getDb } from '../../database/db';
import { config } from '../../config';

const router = Router();
let mapper: NomenclatureMapper | null = null;
export function setMapper(m: NomenclatureMapper): void { mapper = m; }

/**
 * Post-processing parity with fileWatcher step 8: auto-approve for 1C and/or
 * auto-send to Sber if the user enabled those toggles. No-op unless the
 * invoice is 'processed' and not a duplicate. Never throws.
 */
async function runAutoSendHooks(targetInvoiceId: number): Promise<void> {
  try {
    const finalInv = await invoiceRepo.getById(targetInvoiceId);
    const cfg = await invoiceRepo.getAnalyzerConfig();
    const canAutoSend = !!finalInv && finalInv.status === 'processed' && finalInv.duplicate_of == null;
    if (!canAutoSend) return;

    const whCfg = await getDb()
      .prepare('SELECT auto_send_1c FROM webhook_config WHERE id = 1')
      .get<{ auto_send_1c: number }>();
    const wantAuto1c = (whCfg?.auto_send_1c === 1) || cfg.auto_send_1c;
    if (wantAuto1c) {
      await invoiceRepo.approveForOneC(targetInvoiceId);
      logger.info('dispatcher: auto-approved for 1C', { id: targetInvoiceId });
    }
    if (cfg.auto_send_sber) {
      await autoSendSber(targetInvoiceId);
    }
  } catch (e) {
    logger.warn('dispatcher: auto-send hooks failed', { id: targetInvoiceId, error: (e as Error).message });
  }
}

// Loopback POST to /send-sber (reuses the full endpoint logic: verified-supplier
// check, payer details, payment row, Sber API call). Admin api_key from DB.
async function autoSendSber(invoiceId: number): Promise<void> {
  try {
    const adminId = await userRepo.firstUserId();
    if (!adminId) { logger.warn('dispatcher auto-send Sber: no admin user', { invoiceId }); return; }
    const row = await getDb().prepare('SELECT api_key FROM users WHERE id = ?').get<{ api_key: string }>(adminId);
    const apiKey = row?.api_key;
    if (!apiKey) { logger.warn('dispatcher auto-send Sber: admin has no api_key', { invoiceId }); return; }
    const url = `http://127.0.0.1:${config.apiPort}/api/invoices/${invoiceId}/send-sber`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (res.ok) {
      const d = (await res.json().catch(() => ({}))) as { payment_number?: string };
      logger.info('dispatcher: auto-sent to Sber', { invoiceId, paymentNumber: d.payment_number ?? null });
    } else {
      const text = await res.text().catch(() => '');
      logger.warn('dispatcher: auto-send Sber rejected', { invoiceId, status: res.status, body: text.slice(0, 300) });
    }
  } catch (err) {
    logger.warn('dispatcher: auto-send Sber error', { invoiceId, error: (err as Error).message });
  }
}

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

// ─── Supplier-requisite extraction (suppliers page "Распознать с фото") ───
// Mirrors the invoice flow but targets supplier_extract_jobs + a lean prompt.

interface SupplierRequisites {
  inn?: string | null; kpp?: string | null; name?: string | null;
  bank_bic?: string | null; account?: string | null;
  bank_corr_account?: string | null; bank_name?: string | null; address?: string | null;
}
interface SupplierResultBody { token?: string; success?: boolean; data?: SupplierRequisites; error?: string; }

// GET /api/dispatcher/prompt-supplier — lean payee-requisites prompt (plain text).
router.get('/prompt-supplier', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(buildSupplierPrompt());
});

// GET /api/dispatcher/photo-job/:jobId?token= — serve the job's document (image or PDF).
router.get('/photo-job/:jobId', async (req: Request, res: Response) => {
  const id = parseInt(req.params.jobId as string, 10);
  const token = (req.query.token as string | undefined) ?? '';
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid job id' });

  const job = await validateSupplierJobToken(id, token);
  if (!job) {
    logger.warn('dispatcher photo-job: token invalid or job not processing', { jobId: id });
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!fs.existsSync(job.file_path)) {
    logger.warn('dispatcher photo-job: file missing on disk', { jobId: id, path: job.file_path });
    return res.status(404).json({ error: 'document file missing' });
  }
  res.setHeader('Content-Type', job.content_type || contentTypeFor(job.file_path));
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(job.file_path).pipe(res);
});

// POST /api/dispatcher/supplier-result/:jobId — store extracted requisites.
router.post('/supplier-result/:jobId', async (req: Request, res: Response) => {
  const id = parseInt(req.params.jobId as string, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid job id' });

  const body = (req.body ?? {}) as SupplierResultBody;
  const job = await validateSupplierJobToken(id, body.token ?? '');
  if (!job) {
    logger.warn('dispatcher supplier-result: token invalid or already processed', { jobId: id });
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (body.success === false || body.error) {
    const msg = (body.error || 'dispatcher reported failure').slice(0, 1000);
    await supplierExtractJobRepo.setError(id, msg);
    fs.promises.unlink(job.file_path).catch(() => { /* best-effort */ });
    logger.warn('dispatcher supplier-result: error reported', { jobId: id, error: msg });
    notifySupplierExtractError(job.file_name, msg).catch(() => {});
    return res.json({ ok: true, status: 'error' });
  }
  if (!body.success || !body.data || typeof body.data !== 'object') {
    return res.status(400).json({ error: 'success=true requires data object' });
  }

  const d = body.data;
  const extracted = {
    inn: d.inn ?? null,
    kpp: d.kpp ?? null,
    name: d.name ?? null,
    bank_bic: d.bank_bic ?? null,
    account: d.account ?? null,
    bank_corr_account: d.bank_corr_account ?? null,
    bank_name: d.bank_name ?? null,
    address: d.address ?? null,
  };
  await supplierExtractJobRepo.setResult(id, JSON.stringify(extracted));
  fs.promises.unlink(job.file_path).catch(() => { /* best-effort */ });
  logger.info('dispatcher supplier-result: requisites stored', { jobId: id, inn: extracted.inn });
  res.json({ ok: true, status: 'done' });
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

/**
 * Fold a merged-away page into the canonical invoice: carry its photo(s) over
 * (file_name is a comma-separated list the detail view renders as a gallery),
 * then DELETE the now-empty row. We delete rather than mark 'duplicate' because
 * a continuation page is not a user-facing duplicate — its content already
 * lives on the canonical, so a leftover row is just noise. invoiceRepo.delete()
 * removes DB rows only (the route layer owns file deletion), so the page image
 * stays on disk and is served under the canonical invoice.
 */
async function foldPageInto(canonicalId: number, otherId: number): Promise<void> {
  const other = await invoiceRepo.getById(otherId);
  const files = (other?.file_name ?? '').split(',').map(s => s.trim()).filter(Boolean);
  for (const f of files) await invoiceRepo.appendFileName(canonicalId, f);
  await invoiceRepo.delete(otherId);
}

/**
 * Unified multi-page reconciliation for the dispatcher, run AFTER a page is
 * persisted standalone. Dispatcher OCRs each page as a separate PF task, so:
 *   - callbacks arrive UNORDERED (page 2 can finalise before page 1 exists);
 *   - callbacks lag the upload by MINUTES (OCR latency / queue).
 * The lag is why a NOW()-anchored window fails — by the time page 2 calls back,
 * page 1's created_at is already "old". So we anchor on upload-time proximity
 * (findSiblingPagesNearUpload) which stays tight regardless of OCR latency.
 *
 * Among same-upload-batch same-supplier siblings, three self-guarding signals
 * decide that two pages belong to ONE invoice (any one suffices):
 *   1. NUMBER — same normalised invoice_number.
 *   2. ROW_NO — contiguous line numbers (one page's rows start right after the
 *      other's end). A page whose items start at row > 1 is, by definition, a
 *      continuation: e.g. a page with only item #17 needs the page holding
 *      rows 1–16. This is the strongest structural signal and needs no total.
 *   3. CUMULATIVE TOTAL — max(totals) ≈ Σ(all items): the last page prints the
 *      running grand total.
 * Each signal is self-guarding (two distinct invoices share none of them), so a
 * wide proximity window can't cause a false merge.
 *
 * Canonical page (kept) = the one with a date, else a number, else more items /
 * the lower starting row. The other becomes its duplicate. Returns the
 * canonical id when a merge happened, else null.
 */
async function reconcileMultiPageSiblings(currentId: number): Promise<number | null> {
  const current = await invoiceRepo.getById(currentId);
  if (!current || !current.supplier || !current.created_at) return null;
  const currentItems = await invoiceRepo.getItems(currentId);
  const currentItemsSum = currentItems.reduce((s, it) => s + (it.total ?? 0), 0);
  const cRows = currentItems.map(it => it.row_no).filter((n): n is number => n != null);
  const cMinRow = cRows.length ? Math.min(...cRows) : null;
  const cMaxRow = cRows.length ? Math.max(...cRows) : null;
  const cNormNum = normalizeInvoiceNumber(current.invoice_number);

  const candidates = await invoiceRepo.findSiblingPagesNearUpload(
    current.supplier, currentId, current.created_at, 30,
  );
  for (const y of candidates) {
    const grand = Math.max(current.total_sum ?? 0, y.total_sum ?? 0);
    const tol = Math.max(1, grand * 0.005);

    const numberMatch = !!cNormNum && cNormNum === normalizeInvoiceNumber(y.invoice_number);
    const rowContiguous =
      (cMinRow != null && y.max_row != null && Math.abs(cMinRow - (y.max_row + 1)) <= 1) ||
      (y.min_row != null && cMaxRow != null && Math.abs(y.min_row - (cMaxRow + 1)) <= 1);
    const cumulativeTotal =
      grand > 0 &&
      Math.abs(grand - (currentItemsSum + y.items_sum)) <= tol &&
      // each page is only PART of the whole (else one is already complete)
      !(currentItemsSum >= grand - tol && y.items_sum >= grand - tol);

    if (!numberMatch && !rowContiguous && !cumulativeTotal) continue;

    // Pick canonical: prefer date, then number, then more items, then lower start row.
    const yHasDate = !!y.invoice_date, cHasDate = !!current.invoice_date;
    const yHasNum = !!y.invoice_number, cHasNum = !!current.invoice_number;
    let canonicalId: number;
    if (yHasDate !== cHasDate) canonicalId = yHasDate ? y.id : currentId;
    else if (yHasNum !== cHasNum) canonicalId = yHasNum ? y.id : currentId;
    else if (y.items_count !== currentItems.length) canonicalId = y.items_count > currentItems.length ? y.id : currentId;
    else canonicalId = (y.min_row ?? 1) <= (cMinRow ?? 1) ? y.id : currentId;
    const otherId = canonicalId === y.id ? currentId : y.id;

    await invoiceRepo.moveItemsToInvoice(otherId, canonicalId);
    if (grand > 0) await invoiceRepo.updateInvoiceData(canonicalId, { total_sum: grand });
    await foldPageInto(canonicalId, otherId);
    await invoiceRepo.recalculateTotal(canonicalId);
    logger.info('dispatcher result: multi-page sibling merge', {
      canonicalId, otherId, signal: numberMatch ? 'number' : rowContiguous ? 'row_no' : 'cumulative_total',
    });
    return canonicalId;
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
    const errInv = await invoiceRepo.getById(id);
    emitNotification('recognition_error', {
      invoice_id: id,
      invoice_number: errInv?.invoice_number ?? null,
      supplier: errInv?.supplier ?? null,
      total_sum: errInv?.total_sum ?? null,
      error_message: msg,
    }, null).catch(() => {});
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
        supplier: mergeTarget.supplier ? undefined : (data.supplier ? canonicalizeSupplierName(data.supplier) : undefined),
        total_sum: data.total_sum != null ? data.total_sum : (mergeTarget.total_sum == null ? undefined : undefined),
        vat_sum: data.vat_sum != null ? data.vat_sum : (mergeTarget.vat_sum == null ? undefined : undefined),
      });
      // Items appended to targetInvoiceId below; the current row is folded into
      // the target (photo carried over + row deleted) after the items loop.
    } else {
      await invoiceRepo.updateInvoiceData(id, {
        invoice_type: data.invoice_type ?? undefined,
        invoice_number: data.invoice_number ?? undefined,
        invoice_date: data.invoice_date ?? undefined,
        supplier: data.supplier ? canonicalizeSupplierName(data.supplier) : undefined,
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
        row_no: it.row_no ?? null,
      });
      void inserted; // for await/lint
    }
    // Recalculate total + items_total_mismatch flag (must-not-break #3 —
    // cross-validate Σitems.total ≈ total_sum). Runs for BOTH the merge target
    // (sum now includes appended page) and standalone. Without it, a Claude
    // OCR blunder (e.g. "165 229,2" → 1652292) would slip in unvalidated.
    await invoiceRepo.recalculateTotal(targetInvoiceId);

    let finalTargetId = targetInvoiceId;
    let mergedAway = false; // true when THIS page was folded into another

    if (isMerge) {
      // Forward merge: carry this page's photo to the target and delete its row.
      await foldPageInto(targetInvoiceId, id);
      mergedAway = true;
    }

    if (!isMerge) {
      await invoiceRepo.updateStatus(id, 'processed');

      // Multi-page reconciliation against same-upload-batch siblings (number /
      // row_no continuity / cumulative total). Handles unordered, latency-lagged
      // dispatcher callbacks. May make THIS page the canonical (absorbing a
      // sibling) or turn it into a duplicate of one.
      const reconCanonical = await reconcileMultiPageSiblings(id);
      if (reconCanonical && reconCanonical !== id) {
        finalTargetId = reconCanonical;
        mergedAway = true;
      }

      // Telegram notifications (background context → recipient = first user).
      // Skip when this page merged away or absorbed siblings silently — the
      // canonical page is what the user already saw / will see.
      if (!mergedAway) {
        const finalInvoice = await invoiceRepo.getById(id);
        if (finalInvoice) {
          emitNotification('invoice_recognized', {
            invoice_id: finalInvoice.id,
            invoice_number: finalInvoice.invoice_number,
            supplier: finalInvoice.supplier,
            total_sum: finalInvoice.total_sum,
          }, null).catch(() => {});
          if (finalInvoice.items_total_mismatch === 1) {
            const finalItems = await invoiceRepo.getItems(finalInvoice.id);
            const itemsTotal = finalItems.reduce((s, it) => s + (it.total ?? 0), 0);
            emitNotification('suspicious_total', {
              invoice_id: finalInvoice.id,
              invoice_number: finalInvoice.invoice_number,
              supplier: finalInvoice.supplier,
              total_sum: finalInvoice.total_sum,
              items_total: itemsTotal,
            }, null).catch(() => {});
          }
        }
      }
    }

    // Auto-send hooks (1C approve + Sber), mirroring fileWatcher step 8.
    await runAutoSendHooks(finalTargetId);

    await clearDispatcherState(id);
    logger.info('dispatcher result: invoice processed', {
      invoiceId: id, targetInvoiceId: finalTargetId, items: data.items.length, merged: isMerge || mergedAway,
    });
    res.json({ ok: true, status: (isMerge || mergedAway) ? 'merged' : 'processed', targetInvoiceId: finalTargetId });
  } catch (err) {
    logger.error('dispatcher result: write failed', { invoiceId: id, error: (err as Error).message });
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
