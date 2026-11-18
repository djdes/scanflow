/**
 * Dispatcher callback router — mounted at /api/dispatcher.
 * Endpoints are NOT under apiKeyAuth (the dispatcher is external and
 * doesn't have an X-API-Key); each route validates a per-task token
 * against invoices.dispatcher_token.
 *
 * GET  /api/dispatcher/photo/:invoiceId?token=<hex>[&page=N] — download original image/PDF
 * POST /api/dispatcher/result/:invoiceId                     — submit OCR JSON / error
 */
import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { invoiceRepo } from '../../database/repositories/invoiceRepo';
import { recognitionJobRepo } from '../../database/repositories/recognitionJobRepo';
import { kickRecognitionQueue } from '../../services/recognitionQueue';
import { supplierExtractJobRepo } from '../../database/repositories/supplierExtractJobRepo';
import { validateDispatcherToken, clearDispatcherState, validateSupplierJobToken } from '../../dispatcher/createTask';
import { logger } from '../../utils/logger';
import { ParsedInvoiceData, ParsedInvoiceItem } from '../../ocr/types';
import { NomenclatureMapper, type MappingResult } from '../../mapping/nomenclatureMapper';
import { evaluateInvoiceQuality } from '../../automation/qualityGate';
import { convertInvoiceLine } from '../../services/lineConversion';
import { makeSupplierKey } from '../../database/repositories/supplierMappingRepo';
import { onecNomenclatureRepo, type OnecNomenclatureRow } from '../../database/repositories/onecNomenclatureRepo';
import { mappingRepo } from '../../database/repositories/mappingRepo';
import { rejectionRepo } from '../../database/repositories/rejectionRepo';
import { getEngineFlags } from '../../services/engineFlags';
import { itemNameKey, extractAttrs, attrsConflict } from '../../mapping/nameKey';
import { buildPrompt, buildSupplierPrompt } from '../../ocr/claudeApiAnalyzer';
import { preprocessInvoiceImage } from '../../ocr/imagePreprocess';
import { emit as emitNotification, notifySupplierExtractError, emitElevatedPricesIfAny } from '../../notifications/events';
import { normalizeInvoiceNumber, suppliersMatch } from '../../utils/invoiceNumber';
import { resolveSupplierName } from '../../services/resolveSupplierName';
import { linkApprovedSupplier } from '../../services/supplierMatch';
import { snapshotRepo } from '../../database/repositories/snapshotRepo';
import { autoSendSberForInvoice } from '../../services/autoSendSber';
import { mergeBlockedByNumber } from '../../services/mergeDecision';
import { webhookConfigRepo } from '../../database/repositories/webhookConfigRepo';
import { config } from '../../config';

const router = Router();
let mapper: NomenclatureMapper | null = null;
export function setMapper(m: NomenclatureMapper): void { mapper = m; }

/** Resolve the supplier name to store: verified directory card by ИНН wins,
 *  else snap to an already-stored spelling (by ИНН, else fuzzy ≥70%) so OCR
 *  drift doesn't fork suppliers. See {@link resolveSupplierName}. */
async function resolveSupplier(
  rawSupplier: string | null | undefined,
  inn: string | null | undefined,
  ownerUserId: number | null,
): Promise<string | undefined> {
  return resolveSupplierName(rawSupplier, inn, ownerUserId);
}

function resolveCatalogIdx(
  idx: number | null | undefined,
  catalog: OnecNomenclatureRow[] | null,
): { guid: string; name: string; unit: string | null } | undefined {
  if (idx == null || !catalog || !Number.isInteger(idx) || idx < 1 || idx > catalog.length) return undefined;
  const row = catalog[idx - 1];
  if (!row) return undefined;
  return { guid: row.guid, name: row.name, unit: row.unit };
}

async function pickWithLlm(
  name: string,
  llmPicked: { guid: string; name: string; unit: string | null },
  ownerUserId: number,
  context: { supplierInn?: string | null; supplierName?: string | null },
): Promise<MappingResult | null> {
  const v2 = (await getEngineFlags()).mapping_v2;
  if (v2) {
    const confirmed = await mappingRepo.getConfirmed(name, ownerUserId).catch(() => undefined);
    if (confirmed?.onec_guid) {
      const onec = await onecNomenclatureRepo.getByGuid(confirmed.onec_guid, ownerUserId);
      if (onec) {
        void mappingRepo.touchUsage(confirmed.id, context.supplierName ?? null).catch(() => {});
        return {
          original_name: name, mapped_name: onec.name, onec_guid: onec.guid, confidence: 1,
          source: 'learned', mapping_id: confirmed.id,
          mapping_reason: 'По сопоставлению, подтверждённому человеком.',
          pack_size: confirmed.pack_size, pack_unit: confirmed.pack_unit,
        };
      }
    }
    const rejected = await rejectionRepo.guidsFor(ownerUserId, itemNameKey(name));
    const conflict = attrsConflict(extractAttrs(name), extractAttrs(llmPicked.name));
    if (rejected.has(llmPicked.guid) || conflict) {
      logger.info('dispatcher: LLM catalog pick rejected by v2 guards', {
        name, pick: llmPicked.name, rejected: rejected.has(llmPicked.guid), conflict,
      });
      return typeof mapper?.map === 'function' ? mapper.map(name, ownerUserId, context) : null;
    }
  }
  const existingMapping = await mappingRepo.getByScannedName(name, ownerUserId);
  const ordinary: MappingResult = {
    original_name: name,
    mapped_name: llmPicked.name,
    onec_guid: llmPicked.guid,
    confidence: 1,
    source: 'learned',
    mapping_id: existingMapping?.id ?? null,
    mapping_reason: 'По выбору ИИ из каталога 1С.',
    pack_size: existingMapping?.pack_size ?? null,
    pack_unit: existingMapping?.pack_unit ?? null,
  };
  const refined = typeof mapper?.refineWithUsage === 'function'
    ? await mapper.refineWithUsage(name, ordinary, ownerUserId)
    : ordinary;
  if (refined.source === 'onec_usage' || refined.confirmed_by_user) return refined;
  try {
    if (v2) {
      await mappingRepo.upsertLearned({ scanned_name: name, mapped_name_1c: llmPicked.name, onec_guid: llmPicked.guid, source: 'llm' }, ownerUserId);
    } else {
      await mappingRepo.upsert({ scanned_name: name, mapped_name_1c: llmPicked.name, onec_guid: llmPicked.guid, approved: false }, ownerUserId);
    }
  } catch (e) {
    logger.warn('dispatcher: failed to persist learned mapping', { name, error: (e as Error).message });
  }
  if (typeof mapper?.invalidateCache === 'function') mapper.invalidateCache(ownerUserId);
  return refined;
}

/**
 * Post-processing parity with fileWatcher step 8: auto-approve for 1C and/or
 * auto-send to Sber if the user enabled those toggles. No-op unless the
 * invoice is 'processed' and not a duplicate. Never throws.
 *
 * `ownerUserId` — компания владельца накладной: легаси-флаг автоотправки в 1С
 * лежит в пер-тенантной настройке вебхука, читать её можно только за своих.
 */
async function runAutoSendHooks(targetInvoiceId: number, ownerUserId: number | null): Promise<void> {
  try {
    const finalInv = await invoiceRepo.getById(targetInvoiceId);
    const cfg = await invoiceRepo.getAnalyzerConfig();
    const quality = await evaluateInvoiceQuality(targetInvoiceId);
    const canAutoSend = !!finalInv && quality.allowed;
    if (!canAutoSend && (cfg.auto_send_1c || cfg.auto_send_sber)) {
      logger.info('dispatcher: autopilot quality gate held invoice', {
        id: targetInvoiceId,
        score: quality.score,
        reasons: quality.reasons.map(reason => reason.code),
      });
    }
    if (!canAutoSend) return;

    const legacyAuto1c = ownerUserId != null && await webhookConfigRepo.autoSend1cEnabled(ownerUserId);
    const wantAuto1c = legacyAuto1c || cfg.auto_send_1c;
    if (wantAuto1c) {
      await invoiceRepo.approveForOneC(targetInvoiceId);
      logger.info('dispatcher: auto-approved for 1C', { id: targetInvoiceId });
    }
    if (cfg.auto_send_sber) {
      await autoSendSberForInvoice(targetInvoiceId);
    }
  } catch (e) {
    logger.warn('dispatcher: auto-send hooks failed', { id: targetInvoiceId, error: (e as Error).message });
  }
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.pdf' ? 'application/pdf'
    : ext === '.png' ? 'image/png'
    : ext === '.webp' ? 'image/webp'
    : ext === '.bmp' ? 'image/bmp'
    : ext === '.tiff' || ext === '.tif' ? 'image/tiff'
    : 'image/jpeg';
}

function resolvePageFilePath(row: { file_name: string; file_path: string }, pageIndex: number): string {
  const names = (row.file_name || '')
    .split(',')
    .map(s => path.basename(s.trim()))
    .filter(Boolean);
  if (names.length > 0 && pageIndex >= 0 && pageIndex < names.length) {
    const name = names[pageIndex];
    const located = [config.processedDir, config.failedDir, config.inboxDir]
      .map(dir => path.join(dir, name))
      .find(p => fs.existsSync(p));
    if (located) return located;
  }
  return row.file_path;
}

// GET /api/dispatcher/prompt — serve the OCR system prompt as plain text.
// When ?invoiceId=<id>&token=<token> are supplied and llm_mapper_enabled is on,
// embeds the owner company's 1C nomenclature catalog so the dispatcher model
// returns catalog_idx in the same pass.
router.get('/prompt', async (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  const invoiceIdRaw = req.query.invoiceId as string | undefined;
  const token = (req.query.token as string | undefined) ?? '';
  if (invoiceIdRaw && token) {
    const id = parseInt(invoiceIdRaw, 10);
    if (Number.isFinite(id)) {
      const row = await validateDispatcherToken(id, token);
      if (row && row.owner_user_id != null && row.owner_user_id > 0) {
        const cfg = await invoiceRepo.getAnalyzerConfig();
        if (cfg.llm_mapper_enabled) {
          const items = await onecNomenclatureRepo.listItems({ ownerUserId: row.owner_user_id, excludeFolders: true });
          if (items.length > 0) {
            res.send(buildPrompt(items.map(c => ({ guid: c.guid, name: c.name, unit: c.unit }))));
            return;
          }
        }
      }
    }
  }
  res.send(buildPrompt());
});

router.get('/photo/:invoiceId', async (req: Request, res: Response) => {
  const id = parseInt(req.params.invoiceId as string, 10);
  const token = (req.query.token as string | undefined) ?? '';
  const pageRaw = req.query.page as string | undefined;
  const pageIndex = pageRaw != null ? parseInt(pageRaw, 10) : 0;
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid invoice id' });
  if (!Number.isFinite(pageIndex) || pageIndex < 0) return res.status(400).json({ error: 'invalid page index' });

  const row = await validateDispatcherToken(id, token);
  if (!row) {
    logger.warn('dispatcher photo: token invalid or invoice not in ocr_processing', { invoiceId: id });
    return res.status(401).json({ error: 'unauthorized' });
  }
  // The worker fetching the photo = it has STARTED this task. Stamp it so the
  // timeout sweep measures the 15-min "hung" clock from here, not from dispatch
  // time (a queued task can wait far longer than 15 min before the serial worker
  // reaches it). Stamp before the file check — an authorized fetch counts as a start.
  await invoiceRepo.markDispatcherFetched(id);
  const targetPath = resolvePageFilePath(row, pageIndex);
  if (!fs.existsSync(targetPath)) {
    logger.warn('dispatcher photo: file missing on disk', { invoiceId: id, pageIndex, path: targetPath });
    return res.status(404).json({ error: 'photo file missing' });
  }
  res.setHeader('Cache-Control', 'no-store');
  if (path.extname(targetPath).toLowerCase() === '.pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    fs.createReadStream(targetPath).pipe(res);
    return;
  }
  // Serve a pre-OCR-enhanced image (contrast/sharpen — see imagePreprocess.ts),
  // A/B-verified to materially improve recognition of dense rows. Sniff the JPEG
  // magic (FF D8) to pick Content-Type — a fallback to the original (webp/png)
  // keeps its own type. If preprocessing throws (e.g. the file vanished in the
  // existsSync→read race), fall back to streaming the original bytes — the OCR
  // path must always get SOME image.
  try {
    const photoBuf = await preprocessInvoiceImage(targetPath);
    const isJpeg = photoBuf.length > 2 && photoBuf[0] === 0xFF && photoBuf[1] === 0xD8;
    res.setHeader('Content-Type', isJpeg ? 'image/jpeg' : contentTypeFor(targetPath));
    res.send(photoBuf);
  } catch (err) {
    logger.warn('dispatcher photo: preprocess failed, serving original', { invoiceId: id, error: (err as Error).message });
    if (!fs.existsSync(targetPath)) {
      return res.status(404).json({ error: 'photo file missing' });
    }
    res.setHeader('Content-Type', contentTypeFor(targetPath));
    fs.createReadStream(targetPath).pipe(res);
  }
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
    notifySupplierExtractError(job.file_name, msg, job.owner_user_id ?? null).catch(() => {});
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
  let candidate: Awaited<ReturnType<typeof invoiceRepo.findRecentByNumber>> | null = null;
  // Страницы одной накладной — всегда одной компании (правило 19).
  const owner = (await invoiceRepo.getById(currentInvoiceId))?.owner_user_id ?? null;
  // A) match by invoice_number (within last 10 min)
  if (parsed.invoice_number) {
    const e = await invoiceRepo.findRecentByNumber(
      parsed.invoice_number,
      parsed.supplier ?? undefined,
      10,
      owner,
    );
    if (e && e.id !== currentInvoiceId) candidate = e;
  }
  // C) same supplier within 5 min AND current page has no invoice_number
  //    (page-2 of a multi-page where the number was only on page-1).
  if (!candidate && parsed.supplier && !parsed.invoice_number) {
    const e = await invoiceRepo.findRecentBySupplier(parsed.supplier, currentInvoiceId, 5, owner);
    if (e) candidate = e;
  }
  // D) no metadata at all → continuation of most recent in last 2 min.
  if (!candidate && !parsed.invoice_number && !parsed.supplier) {
    const e = await invoiceRepo.findMostRecentProcessedForContinuation(currentInvoiceId, 2, owner);
    if (e) candidate = e;
  }
  // Предохранитель: разные непустые номера → не мёржить (инцидент 287/288).
  if (candidate && mergeBlockedByNumber(parsed, candidate)) {
    logger.info('dispatcher: multi-page merge blocked, different invoice numbers', {
      currentId: currentInvoiceId, currentNumber: parsed.invoice_number,
      candidateId: candidate.id, candidateNumber: candidate.invoice_number,
    });
    return null;
  }
  return candidate;
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
  // Связь пишем ДО удаления — по ней резолвится ссылка из бота на страницу,
  // которой больше нет (см. spec 2026-08-04-merged-page-dead-link).
  await invoiceRepo.recordMerge(otherId, canonicalId);
  logger.info('Page folded into canonical invoice', { sourceId: otherId, targetId: canonicalId });
  await invoiceRepo.delete(otherId);
}

/**
 * Unified multi-page reconciliation for the dispatcher, run AFTER a page is
 * persisted standalone. Dispatcher OCRs each page as a separate PF task, so:
 *   - callbacks arrive UNORDERED (page 2 can finalise before page 1 exists);
 *   - callbacks lag the upload by MINUTES (OCR latency / queue).
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
    currentId, current.created_at, 30,
  );
  for (const y of candidates) {
    const grand = Math.max(current.total_sum ?? 0, y.total_sum ?? 0);
    const tol = Math.max(1, grand * 0.005);

    const supplierMatch = !!current.supplier && !!y.supplier && suppliersMatch(current.supplier, y.supplier);
    const numberMatch = !!cNormNum && cNormNum === normalizeInvoiceNumber(y.invoice_number);
    const rowContiguous =
      (cMinRow != null && cMinRow > 1 && y.max_row != null && Math.abs(cMinRow - (y.max_row + 1)) <= 1) ||
      (y.min_row != null && y.min_row > 1 && cMaxRow != null && Math.abs(y.min_row - (cMaxRow + 1)) <= 1);
    const cumulativeTotal =
      grand > 0 &&
      Math.abs(grand - (currentItemsSum + y.items_sum)) <= tol &&
      !(currentItemsSum >= grand - tol && y.items_sum >= grand - tol);

    const numberBlocked = mergeBlockedByNumber(current, y);
    const structuralOk = (numberMatch || rowContiguous) && !numberBlocked;
    const totalOk = cumulativeTotal && supplierMatch;
    if (!structuralOk && !totalOk) continue;

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
    await recognitionJobRepo.failByInvoice(id, msg, 60).catch(() => {});
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
  const FFFD = '\uFFFD';
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
    const mergeTarget = await findMultiPageTarget(id, data);
    const targetInvoiceId = mergeTarget?.id ?? id;
    const isMerge = !!mergeTarget;

    if (isMerge) {
      logger.info('dispatcher result: multi-page merge', {
        currentInvoiceId: id, targetInvoiceId, supplier: data.supplier, number: data.invoice_number,
      });
      await invoiceRepo.updateInvoiceData(targetInvoiceId, {
        invoice_number: mergeTarget.invoice_number ? undefined : (data.invoice_number ?? undefined),
        supplier: mergeTarget.supplier ? undefined : await resolveSupplier(data.supplier, data.supplier_inn, row.owner_user_id),
        total_sum: data.total_sum ?? undefined,
        vat_sum: data.vat_sum ?? undefined,
      });
    } else {
      await invoiceRepo.updateInvoiceData(id, {
        invoice_type: data.invoice_type ?? undefined,
        invoice_number: data.invoice_number ?? undefined,
        invoice_date: data.invoice_date ?? undefined,
        supplier: await resolveSupplier(data.supplier, data.supplier_inn, row.owner_user_id),
        supplier_inn: data.supplier_inn ?? undefined,
        supplier_kpp: data.supplier_kpp ?? undefined,
        supplier_bik: data.supplier_bik ?? undefined,
        supplier_account: data.supplier_account ?? undefined,
        supplier_corr_account: data.supplier_corr_account ?? undefined,
        supplier_address: data.supplier_address ?? undefined,
        total_sum: data.total_sum ?? undefined,
        vat_sum: data.vat_sum ?? undefined,
        ocr_engine: 'dispatcher_ralph',
      });
    }

    const mappingOwnerId = row.owner_user_id ?? -1;
    const analyzerCfg = await invoiceRepo.getAnalyzerConfig();
    const catalog = analyzerCfg.llm_mapper_enabled && mappingOwnerId > 0
      ? await onecNomenclatureRepo.listItems({ ownerUserId: mappingOwnerId, excludeFolders: true })
      : null;

    for (const it of data.items as ParsedInvoiceItem[]) {
      let transformedItem = {
        quantity: it.quantity ?? null,
        unit: it.unit ?? null,
        price: it.price ?? null,
        total: it.total ?? null,
      };
      let mapping: MappingResult | null = null;
      if (it.name) {
        try {
          const mappingContext = { supplierInn: data.supplier_inn, supplierName: data.supplier };
          const supplierOverride = typeof mapper?.mapSupplierOverride === 'function'
            ? await mapper.mapSupplierOverride(it.name, mappingOwnerId, mappingContext)
            : null;
          const llmPicked = resolveCatalogIdx(it.catalog_idx, catalog);
          if (supplierOverride) {
            mapping = supplierOverride;
          } else if (llmPicked) {
            mapping = await pickWithLlm(it.name, llmPicked, mappingOwnerId, mappingContext);
          } else if (typeof mapper?.map === 'function') {
            mapping = await mapper.map(it.name, mappingOwnerId, mappingContext);
          }
        } catch (err) {
          logger.warn('dispatcher result: mapping failed', { itemName: it.name, error: (err as Error).message });
        }
      }

      const conv = await convertInvoiceLine({
        ownerUserId: row.owner_user_id ?? null,
        supplierKey: makeSupplierKey(data.supplier_inn ?? null, data.supplier ?? null),
        name: it.name ?? '',
        raw: transformedItem,
        onecGuid: mapping?.onec_guid ?? null,
        mappedName: mapping?.mapped_name ?? null,
        mapping: mapping ? { mapping_id: mapping.mapping_id ?? null, pack_size: mapping.pack_size ?? null, pack_unit: mapping.pack_unit ?? null } : null,
        llmPackHint: it.pack_size ?? null,
      });
      transformedItem = { quantity: conv.quantity, unit: conv.unit, price: conv.price, total: conv.total };

      const inserted = await invoiceRepo.addItem({
        invoice_id: targetInvoiceId,
        original_name: it.name ?? '',
        mapped_name: mapping?.mapped_name ?? undefined,
        quantity: transformedItem.quantity ?? undefined,
        unit: transformedItem.unit ?? undefined,
        price: transformedItem.price ?? undefined,
        total: transformedItem.total ?? undefined,
        conversion: conv.conversion,
        vat_rate: it.vat_rate ?? undefined,
        mapping_confidence: mapping?.confidence ?? 0,
        mapping_reason: mapping?.mapping_reason ?? null,
        onec_guid: mapping?.onec_guid ?? undefined,
        row_no: it.row_no ?? null,
      });
      void inserted;
    }

    await invoiceRepo.recalculateTotal(targetInvoiceId);

    let finalTargetId = targetInvoiceId;
    let mergedAway = false;

    if (isMerge) {
      await foldPageInto(targetInvoiceId, id);
      mergedAway = true;
      await invoiceRepo.checkAndMarkDuplicate?.(targetInvoiceId);
    }

    if (!isMerge) {
      await snapshotRepo.record(id, 'recognized');
      await linkApprovedSupplier(id);
      await invoiceRepo.updateStatus(id, 'processed');

      const reconCanonical = await reconcileMultiPageSiblings(id);
      if (reconCanonical && reconCanonical !== id) {
        finalTargetId = reconCanonical;
        mergedAway = true;
      }

      const dupOriginal = await invoiceRepo.checkAndMarkDuplicate?.(finalTargetId);
      if (dupOriginal) {
        logger.info('dispatcher result: duplicate invoice detected', {
          invoiceId: finalTargetId,
          originalId: dupOriginal.id,
        });
      }

      if (!mergedAway && !dupOriginal) {
        const finalInvoice = await invoiceRepo.getById(id);
        if (finalInvoice) {
          emitNotification('invoice_recognized', {
            invoice_id: finalInvoice.id,
            invoice_number: finalInvoice.invoice_number,
            supplier: finalInvoice.supplier,
            total_sum: finalInvoice.total_sum,
          }, null).catch(() => {});
          emitElevatedPricesIfAny(finalInvoice.id).catch(() => {});
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

    await runAutoSendHooks(finalTargetId, row.owner_user_id);

    await clearDispatcherState(id);
    await recognitionJobRepo.completeByInvoice(id, finalTargetId).catch(() => {});
    kickRecognitionQueue();
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
