import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { invoiceRepo, type Invoice } from '../../database/repositories/invoiceRepo';
import { mappingRepo } from '../../database/repositories/mappingRepo';
import { onecNomenclatureRepo } from '../../database/repositories/onecNomenclatureRepo';
import { getDb } from '../../database/db';
import { sendToWebhook } from '../../integration/webhook';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { canonicalizeSupplierName, suppliersMatch } from '../../utils/invoiceNumber';
import { NomenclatureMapper } from '../../mapping/nomenclatureMapper';
import { resolveAndApplyPackTransform } from '../../mapping/packTransform';
import { sanitizeItemVatPerItem } from '../../parser/itemSanitizer';
import { mapItemsWithClaudeApi, CatalogEntry } from '../../ocr/claudeApiAnalyzer';
import { coerceToOnec1cUnit } from '../../mapping/packTransform';
import { emit as emitNotification } from '../../notifications/events';
import { logIntegrationEvent } from '../../integration/integrationLog';
import { randomUUID } from 'node:crypto';
import { sberTokenRepo } from '../../database/repositories/sberTokenRepo';
import { supplierRepo } from '../../database/repositories/supplierRepo';
import { sberPaymentRepo } from '../../database/repositories/sberPaymentRepo';
import { userRepo } from '../../database/repositories/userRepo';
import { syncStateRepo } from '../../database/repositories/syncStateRepo';
import { getValidAccessToken } from '../../sber/oauth';
import { createPaymentOrder, SberApiError } from '../../sber/payments';
import { renderPurpose } from '../../sber/purposeTemplate';
import { redact } from '../../sber/redact';
import { enrichInvoiceWithSupplier } from '../../services/enrichSupplier';
import { bulkSend1c, bulkSendSber } from '../../services/bulkSend';
import { requireAdmin } from '../middleware/auth';
import { automationRepo } from '../../database/repositories/automationRepo';
import { approvalRepo } from '../../database/repositories/approvalRepo';
import { makeSupplierKey, supplierMappingRepo } from '../../database/repositories/supplierMappingRepo';
import { ocrCorrectionRepo, supplierCorrectionKey } from '../../database/repositories/ocrCorrectionRepo';

/**
 * Attach Sber payment status to a batch of invoices (for the list view —
 * a single SQL roundtrip instead of N + 1 queries to sber_payments).
 *
 * Adds `sber_payment_status` ('created' | 'failed' | 'pending' | null) and
 * `sber_payment_number` so the frontend can render a status icon next to
 * each row without opening the invoice.
 */
async function attachSberStatus<T extends { id: number }>(invoices: T[]): Promise<(T & { sber_payment_status: string | null; sber_payment_number: string | null })[]> {
  if (invoices.length === 0) return [] as (T & { sber_payment_status: string | null; sber_payment_number: string | null })[];
  const ids = invoices.map(i => i.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = await getDb().prepare(
    `SELECT invoice_id, status, sber_payment_number
     FROM sber_payments WHERE invoice_id IN (${placeholders})`
  ).all<{ invoice_id: number; status: string; sber_payment_number: string | null }>(...ids);
  const map = new Map(rows.map(r => [r.invoice_id, r]));
  return invoices.map(inv => {
    const p = map.get(inv.id);
    return {
      ...inv,
      sber_payment_status: p?.status ?? null,
      sber_payment_number: p?.sber_payment_number ?? null,
    };
  });
}

/**
 * Attach the count of elevated-price line items to a batch of invoices (for the
 * list view) — one SQL roundtrip instead of N+1 queries.
 *
 * An item is "elevated" by the SAME rule the detail endpoint uses (see
 * GET /:id below): it has a median price stat with samples >= 3, its unit
 * matches the stat's price_unit, its price is positive, and that price is
 * more than 10% above the median. Keeping the definition identical means the
 * list badge and the detail page's "повышенная цена" never disagree.
 *
 * Adds `elevated_price_count` (0 when none) so the frontend can render a badge.
 */
async function attachElevatedPriceCount<T extends { id: number }>(invoices: T[]): Promise<(T & { elevated_price_count: number })[]> {
  if (invoices.length === 0) return [] as (T & { elevated_price_count: number })[];
  const ids = invoices.map(i => i.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = await getDb().prepare(
    `SELECT ii.invoice_id AS invoice_id, COUNT(*) AS c
       FROM invoice_items ii
       JOIN invoices i ON i.id = ii.invoice_id
       JOIN nomenclature_price_stat_cards ps
         ON ps.onec_guid = ii.onec_guid AND ps.owner_user_id = i.owner_user_id
      WHERE ii.invoice_id IN (${placeholders})
        AND ps.samples >= 3
        AND ps.median_price > 0
        AND ii.unit = ps.price_unit
        AND ii.price > 0
        AND ii.price > ps.median_price * 1.10
      GROUP BY ii.invoice_id`
  ).all<{ invoice_id: number; c: number }>(...ids);
  const map = new Map(rows.map(r => [r.invoice_id, Number(r.c)]));
  return invoices.map(inv => ({ ...inv, elevated_price_count: map.get(inv.id) ?? 0 }));
}

let mapper: NomenclatureMapper | null = null;
export function setMapper(m: NomenclatureMapper): void {
  mapper = m;
}

// Injected by server.ts at startup. Used by /:id/rescan to drive the
// FileWatcher's reprocessInvoice() — keeps the OCR/Claude/mapping pipeline
// in one place instead of duplicating it across watcher + routes.
let fileWatcher: import('../../watcher/fileWatcher').FileWatcher | null = null;
export function setFileWatcher(fw: import('../../watcher/fileWatcher').FileWatcher): void {
  fileWatcher = fw;
}

// Multipart upload for "дофоткать страницы". Saves straight into processedDir —
// NOT the watched inbox — so the chokidar watcher can never race markProcessing
// and ingest the page as a SEPARATE invoice. addPageToInvoice reads it in place
// (processedDir is already where the photo endpoint serves from).
const addPagesUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, config.processedDir),
    filename: (_req, file, cb) => {
      const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
      cb(null, `upload-${uniqueSuffix}${path.extname(file.originalname)}`);
    },
  }),
  fileFilter: (_req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.webp'];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  },
  limits: { fileSize: 20 * 1024 * 1024 },
});

const router = Router();

// ── Multi-tenant ownership guard ────────────────────────────────────────────
// Runs for every :id / :invoiceId route below.
// Isolation is unconditional: a company may only reach its own invoices, and the
// admin role does NOT bypass it. A request without an authenticated user is left
// to the auth middleware to reject.
async function invoiceOwnershipGuard(
  req: Request, res: Response, next: NextFunction, value: string,
): Promise<void> {
  try {
    if (req.user == null) { next(); return; }
    const id = parseInt(value, 10);
    if (!Number.isFinite(id)) { next(); return; }
    const inv = await invoiceRepo.getById(id);
    if (inv && inv.owner_user_id !== req.user?.id) {
      res.status(404).json({ error: 'Invoice not found' });
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
}
router.param('id', invoiceOwnershipGuard);
router.param('invoiceId', invoiceOwnershipGuard);

// Owner filter for list/stats. Always the caller's own id — isolation is
// unconditional and the admin role grants NO cross-company data access.
//
// admin remains privileged for PLATFORM configuration (analyzer settings, models,
// webhook, debug) — that is enforced by requireAdmin on those routes and is
// orthogonal to who owns a company's invoices.
function ownerScopeFor(req: Request): number | undefined {
  return req.user?.id;
}

function deleteStoredInvoiceFiles(fileNameList: string | null | undefined): void {
  if (!fileNameList) return;

  const roots = [config.processedDir, config.failedDir, config.inboxDir].map(dir => path.resolve(dir));
  for (const rawName of fileNameList.split(',')) {
    const trimmed = rawName.trim();
    if (!trimmed) continue;

    // Filenames are generated by the server, but legacy rows are still DB data:
    // never let a path component turn invoice deletion into an arbitrary unlink.
    const fileName = path.basename(trimmed);
    if (fileName !== trimmed) {
      logger.warn('Skipping unsafe invoice filename during delete', { fileName: trimmed });
      continue;
    }

    for (const root of roots) {
      const filePath = path.resolve(root, fileName);
      if (path.dirname(filePath) !== root) continue;
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (err) {
        logger.warn('Failed to delete stored invoice file', {
          fileName,
          error: (err as Error).message,
        });
      }
    }
  }
}

// GET /api/invoices/stats — dashboard statistics (must be before /:id)
router.get('/stats', async (req: Request, res: Response) => {
  const db = getDb();
  const uid = ownerScopeFor(req);
  const ownerWhere = uid != null ? ` WHERE owner_user_id = ${Number(uid)}` : '';
  const byStatus = await db.prepare(`SELECT status, COUNT(*) as count FROM invoices${ownerWhere} GROUP BY status`).all();
  const totalRow = await db.prepare(`SELECT COUNT(*) as count FROM invoices${ownerWhere}`).get<{ count: number }>();

  const unreadWhere = uid != null
    ? ` WHERE owner_user_id = ${Number(uid)} AND read_at IS NULL`
    : ' WHERE read_at IS NULL';
  const unreadRow = await db.prepare(`SELECT COUNT(*) as count FROM invoices${unreadWhere}`).get<{ count: number }>();

  // Sum of invoices NOT sent to Sber in the last 30 days (payable backlog)
  const sberUnsent = await db.prepare(
    `SELECT COUNT(*) as count, COALESCE(SUM(i.total_sum), 0) as total_sum
     FROM invoices i
     LEFT JOIN sber_payments sp ON sp.invoice_id = i.id
     WHERE i.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
       AND sp.id IS NULL
       AND i.paid_externally = 0
       AND i.status IN ('processed', 'sent_to_1c')${uid != null ? ` AND i.owner_user_id = ${Number(uid)}` : ''}`
  ).get<{ count: number; total_sum: number }>();

  res.json({
    data: {
      byStatus,
      total: totalRow?.count ?? 0,
      unreadCount: unreadRow?.count ?? 0,
      sberUnsent: {
        count: sberUnsent?.count ?? 0,
        totalSum: sberUnsent?.total_sum ?? 0,
      },
    },
  });
});

// GET /api/invoices — list all invoices
router.get('/', async (req: Request, res: Response) => {
  // По имени файла — для async upload polling.
  const fileName = req.query.file_name as string | undefined;
  if (fileName) {
    const invoice = await invoiceRepo.findByFileName(fileName);
    // Respect ownership: a non-admin polling by filename only sees their own.
    const visible = invoice
      && invoice.owner_user_id === req.user?.id
      ? invoice : null;
    const enriched = visible ? [await enrichInvoiceWithSupplier(visible)] : [];
    res.json({ data: enriched, count: enriched.length });
    return;
  }

  const status = req.query.status as string | undefined;
  const limit = parseInt(req.query.limit as string) || 100;
  const offset = parseInt(req.query.offset as string) || 0;
  const q = typeof req.query.q === 'string' ? req.query.q : undefined;
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const from = typeof req.query.from === 'string' && dateRe.test(req.query.from) ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' && dateRe.test(req.query.to) ? req.query.to : undefined;

  // Пер-колоночные фильтры. Строки режем по длине (в SQL уходят как LIKE-параметры),
  // числа пропускаем только конечные, sber — строго из белого списка значений.
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, 128) : undefined;
  const num = (v: unknown): number | undefined => {
    if (typeof v !== 'string' || !v.trim()) return undefined;
    const n = Number(v.replace(',', '.'));
    return Number.isFinite(n) ? n : undefined;
  };
  const number = str(req.query.number);
  const supplier = str(req.query.supplier);
  const sumFrom = num(req.query.sum_from);
  const sumTo = num(req.query.sum_to);
  const sber = req.query.sber === 'paid' || req.query.sber === 'unpaid' ? req.query.sber : undefined;

  const rawInvoices = await invoiceRepo.getAll(status, limit, offset, ownerScopeFor(req), {
    q, from, to, number, supplier, sumFrom, sumTo, sber,
  });
  const enriched = await Promise.all(rawInvoices.map(enrichInvoiceWithSupplier));
  const withSber = await attachSberStatus(enriched);
  const invoices = await attachElevatedPriceCount(withSber);
  res.json({ data: invoices, count: invoices.length });
});

// GET /api/invoices/pending?limit=100&offset=0 — invoices ready for 1C.
// Default limit 100, hard max 500 (enforced in repo). 1C polls this; without
// paging a backlog of thousands would blow up memory + response size.
router.get('/pending', async (req: Request, res: Response) => {
  const limitRaw = parseInt(req.query.limit as string, 10);
  const offsetRaw = parseInt(req.query.offset as string, 10);
  const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;
  const offset = Number.isFinite(offsetRaw) ? offsetRaw : undefined;
  const { rows, total } = await invoiceRepo.getPendingWithItems({
    limit,
    offset,
    ownerUserId: ownerScopeFor(req),
  });
  // Enrich each invoice's supplier fields from the verified suppliers table —
  // this is what 1С actually receives and uses to find/create контрагент.
  const enriched = await Promise.all(rows.map(async r => ({ ...(await enrichInvoiceWithSupplier(r)), items: r.items })));
  res.json({ data: enriched, count: enriched.length, total, limit: limit ?? 100, offset: offset ?? 0 });
});

// GET /api/invoices/:id/neighbours — prev/next invoice for in-detail navigation.
// Returns {prev, next} each with {id, invoice_number, supplier, invoice_date} or null.
router.get('/:id/neighbours', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
  const neighbours = await invoiceRepo.getNeighbours(id, ownerScopeFor(req));
  res.json({ data: neighbours });
});

// GET /api/invoices/:id/photos — list photo files for an invoice
router.get('/:id/photos', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const invoice = await invoiceRepo.getById(id);

  if (!invoice) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }

  const fileNames = (invoice.file_name || '')
    .split(',')
    .map(f => f.trim())
    .filter(f => f.length > 0);

  const photos = fileNames.map(filename => ({
    filename,
    url: `/api/invoices/${id}/photos/${encodeURIComponent(filename)}`,
  }));

  res.json({ data: photos });
});

// GET /api/invoices/:id/photos/:filename — serve photo file.
router.get('/:id/photos/:filename', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const invoice = await invoiceRepo.getById(id);

  if (!invoice) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }

  const requestedFile = req.params.filename as string;

  // Validate file belongs to this invoice
  const fileNames = (invoice.file_name || '')
    .split(',')
    .map(f => f.trim());

  if (!fileNames.includes(requestedFile)) {
    res.status(404).json({ error: 'File not found for this invoice' });
    return;
  }

  // Path-traversal protection: use basename only
  const safeFilename = path.basename(requestedFile);

  // Look in processed → failed → inbox (priority order). Errored invoices keep
  // their photo in failedDir (see fileWatcher error path), and that's exactly
  // when the user needs to open the photo to fix the data by hand. Serving only
  // from processedDir 404'd every error-invoice photo even though it's on disk.
  let filePath: string | null = null;
  for (const dir of [config.processedDir, config.failedDir, config.inboxDir]) {
    const candidate = path.join(dir, safeFilename);
    if (fs.existsSync(candidate)) {
      filePath = candidate;
      break;
    }
  }

  if (!filePath) {
    res.status(404).json({ error: 'File not found on disk' });
    return;
  }

  res.sendFile(filePath);
});

// GET /api/invoices/:id — single invoice with items.
// Supplier fields enriched from verified `suppliers` row when ИНН matches.
router.get('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const raw = await invoiceRepo.getWithItems(id);
  if (!raw) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }
  // Открытие детали владельцем помечает накладную прочитанной (идемпотентно —
  // setRead(true) не перетирает уже стоящий read_at). Внутренние вызовы без
  // req.user и чужой доступ (его и так режет invoiceOwnershipGuard) read-статус
  // компании не трогают.
  if (req.user?.id != null && raw.owner_user_id === req.user.id && raw.read_at == null) {
    await invoiceRepo.setRead(id, true);
    raw.read_at = new Date().toISOString();
  }
  const enriched = { ...(await enrichInvoiceWithSupplier(raw)), items: raw.items };
  enriched.items = enriched.items.map((item: any) => {
    const hasStats = item.median_price != null && item.median_samples != null && item.median_samples >= 3;
    const unitsMatch = item.unit && item.median_price_unit && item.unit === item.median_price_unit;
    const priceValid = typeof item.price === 'number' && item.price > 0;

    let price_deviation_pct: number | null = null;
    if (hasStats && unitsMatch && priceValid && item.median_price > 0) {
      price_deviation_pct = ((item.price - item.median_price) / item.median_price) * 100;
    }

    return {
      ...item,
      median_price: hasStats ? item.median_price : null,
      median_price_unit: hasStats ? item.median_price_unit : null,
      median_samples: hasStats ? item.median_samples : null,
      price_deviation_pct,
    };
  });

  (enriched as typeof enriched & { possible_siblings: unknown }).possible_siblings =
    await invoiceRepo.findSiblings(id);

  res.json({ data: enriched });
});

// PATCH /api/invoices/:id — отредактировать header-поля накладной.
// Используется UI-формой «Реквизиты накладной» когда юзеру нужно дозаполнить
// или поправить распознанные данные перед отправкой в 1С / Сбербанк.
//
// Принимает любой subset полей. Поля, переданные как пустая строка, сбрасываются
// в null. Поля, не переданные, остаются как были. Items не трогаются — для них
// есть отдельный PATCH /:invoiceId/items/:itemId.
router.patch('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
  const invoice = await invoiceRepo.getById(id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (invoice.owner_user_id !== req.user?.id) {
    return res.status(404).json({ error: 'Invoice not found' });
  }

  const body = req.body as Record<string, unknown>;
  const update: Record<string, unknown> = {};

  // Validation regexes (по той же модели что в /api/sber/seed-token и /api/suppliers).
  const INN_RE = /^([0-9]{10}|[0-9]{12})$/;
  const KPP_RE = /^[0-9]{9}$/;
  const BIC_RE = /^[0-9]{9}$/;
  const ACC_RE = /^[0-9]{20}$/;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  // Helper: переводит '' и null в null, undefined пропускает (нет в update),
  // строку trim-ит. Используется для всех текстовых полей.
  const trimOrNull = (v: unknown): string | null | undefined => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (typeof v !== 'string') return undefined;
    const t = v.trim();
    return t === '' ? null : t;
  };

  // Numeric helper (total_sum, vat_sum)
  const toFinite = (v: unknown): number | null | undefined => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v));
    if (!isFinite(n)) return undefined;  // skip — invalid
    return n;
  };

  // Validate + collect
  const invoice_number = trimOrNull(body.invoice_number);
  if (invoice_number !== undefined) update.invoice_number = invoice_number;

  const invoiceType = trimOrNull(body.invoice_type);
  const invoiceTypes = ['счет_на_оплату', 'торг_12', 'упд', 'счет_фактура', 'акт', 'кассовый_чек', 'авансовый_отчет', 'прочее'];
  if (invoiceType !== undefined) {
    if (invoiceType !== null && !invoiceTypes.includes(invoiceType)) return res.status(400).json({ error: 'unsupported invoice_type' });
    update.invoice_type = invoiceType;
  }

  const invoice_date = trimOrNull(body.invoice_date);
  if (invoice_date !== undefined) {
    if (invoice_date !== null && !DATE_RE.test(invoice_date)) {
      return res.status(400).json({ error: 'invoice_date must be YYYY-MM-DD' });
    }
    update.invoice_date = invoice_date;
  }

  const supplier = trimOrNull(body.supplier);
  if (supplier !== undefined) update.supplier = supplier;

  const supplier_inn = trimOrNull(body.supplier_inn);
  if (supplier_inn !== undefined) {
    if (supplier_inn !== null && !INN_RE.test(supplier_inn)) {
      return res.status(400).json({ error: 'supplier_inn must be 10 or 12 digits' });
    }
    update.supplier_inn = supplier_inn;
  }

  const supplier_kpp = trimOrNull(body.supplier_kpp);
  if (supplier_kpp !== undefined) {
    if (supplier_kpp !== null && !KPP_RE.test(supplier_kpp)) {
      return res.status(400).json({ error: 'supplier_kpp must be 9 digits' });
    }
    update.supplier_kpp = supplier_kpp;
  }

  const supplier_bik = trimOrNull(body.supplier_bik);
  if (supplier_bik !== undefined) {
    if (supplier_bik !== null && !BIC_RE.test(supplier_bik)) {
      return res.status(400).json({ error: 'supplier_bik must be 9 digits' });
    }
    update.supplier_bik = supplier_bik;
  }

  const supplier_account = trimOrNull(body.supplier_account);
  if (supplier_account !== undefined) {
    if (supplier_account !== null && !ACC_RE.test(supplier_account)) {
      return res.status(400).json({ error: 'supplier_account must be 20 digits' });
    }
    update.supplier_account = supplier_account;
  }

  const supplier_corr_account = trimOrNull(body.supplier_corr_account);
  if (supplier_corr_account !== undefined) {
    if (supplier_corr_account !== null && !ACC_RE.test(supplier_corr_account)) {
      return res.status(400).json({ error: 'supplier_corr_account must be 20 digits' });
    }
    update.supplier_corr_account = supplier_corr_account;
  }

  const supplier_address = trimOrNull(body.supplier_address);
  if (supplier_address !== undefined) update.supplier_address = supplier_address;

  const total_sum = toFinite(body.total_sum);
  if (total_sum !== undefined) update.total_sum = total_sum;

  const vat_sum = toFinite(body.vat_sum);
  if (vat_sum !== undefined) update.vat_sum = vat_sum;

  if (Object.keys(update).length === 0) {
    return res.status(400).json({ error: 'No editable fields in request body' });
  }

  await invoiceRepo.updateInvoiceData(id, update);
  // Выученные исправления OCR пер-тенантные: учимся только в области владельца
  // накладной. У «ничьей» накладной учить некого — правка применяется, но в
  // общую память распознавания не попадает (иначе досталась бы чужой компании).
  const correctionOwnerId = invoice.owner_user_id;
  if (correctionOwnerId != null) {
    const correctionSupplierKey = supplierCorrectionKey(invoice);
    for (const [field, corrected] of Object.entries(update)) {
      const original = (invoice as unknown as Record<string, unknown>)[field];
      await ocrCorrectionRepo.remember(correctionSupplierKey, field, original, corrected, correctionOwnerId);
    }
  }
  const updated = await invoiceRepo.getById(id);
  return res.json({ data: updated ? await enrichInvoiceWithSupplier(updated) : null });
});

// POST /api/invoices/:id/send — approve invoice for 1C pickup.
//
// Approval workflow (user-controlled):
//   1. User reviews invoice in dashboard
//   2. Clicks "Отправить в 1С" → this endpoint → approved_for_1c = 1
//   3. 1C external processing calls GET /api/invoices/pending → sees this invoice
//   4. 1C creates ПриходнаяНакладная document, then calls POST /:id/confirm
//   5. Confirm endpoint sets status = sent_to_1c
//
// Does NOT call the old webhook (which was never configured in production).
// The webhook path was replaced by this explicit pull/approval model.
router.post('/:id/send', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const invoice = await invoiceRepo.getById(id);

  if (!invoice) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }

  if (invoice.status !== 'processed') {
    res.status(400).json({
      error: `Invoice must be in "processed" status, current: "${invoice.status}"`
    });
    return;
  }

  const onecAutomation = await automationRepo.get();
  if (onecAutomation.payment_approval_threshold != null
      && (invoice.total_sum ?? 0) > onecAutomation.payment_approval_threshold
      && !(await approvalRepo.hasApproved(id, '1c'))) {
    const approval = await approvalRepo.create(id, '1c', req.user?.id ?? null, 'Автоматически создано по лимиту суммы');
    return res.status(409).json({
      error: `Накладная выше лимита ${onecAutomation.payment_approval_threshold.toFixed(2)} ₽ и ожидает согласования`,
      needs_approval: true,
      approval_id: approval.id,
    });
  }

  // Also try the legacy webhook if configured — backward compat for anyone
  // who has a webhook URL set up. If no webhook is configured, this is a no-op.
  try {
    await sendToWebhook(id);
  } catch {
    // Webhook is optional; ignore failures
  }

  // Primary flow: mark as approved so 1C picks it up on next /pending call
  await invoiceRepo.approveForOneC(id);

  const invForNotif = await invoiceRepo.getById(id);
  if (invForNotif) {
    emitNotification('approved_for_1c', {
      invoice_id: invForNotif.id,
      invoice_number: invForNotif.invoice_number,
      supplier: invForNotif.supplier,
      total_sum: invForNotif.total_sum,
    }, req.user?.id ?? null).catch(() => {});
  }

  void logIntegrationEvent({
    integration: '1c', event_type: 'approved', invoice_id: id,
    summary: `Накладная №${invForNotif?.invoice_number ?? id} одобрена для отправки в 1С`,
  });

  // If this invoice introduces new (unmatched) nomenclature, flag the catalog
  // for re-export. 1C's scheduled job pulls it back after creating the docs.
  // Флаг пер-тенантный — поднимаем его в компании владельца накладной. У
  // легаси-накладных без владельца берём компанию того, кто нажал «Отправить»:
  // это единственная известная компания в этом запросе, и она же увидит флаг.
  try {
    const syncOwnerId = invoice.owner_user_id ?? req.user?.id ?? null;
    if (syncOwnerId != null && await invoiceRepo.hasUnmatchedItems(id)) {
      await syncStateRepo.markNomenclatureSyncRequested(syncOwnerId);
      void logIntegrationEvent({
        integration: 'nomenclature', event_type: 'sync_requested', invoice_id: id,
        summary: `Накладная №${invForNotif?.invoice_number ?? id} содержит новые позиции — каталог 1С помечен к выгрузке`,
      });
    }
  } catch (e) {
    logger.warn('Failed to set nomenclature sync flag', { id, error: (e as Error).message });
  }

  res.json({
    data: { id, approved_for_1c: true },
    message: 'Накладная помечена для отправки в 1С. Загрузите через обработку в 1С.'
  });
});

// POST /api/invoices/:id/confirm — confirm sent to 1C.
// Called by 1C external processing after it successfully creates the document.
// Sets status = sent_to_1c AND clears approved_for_1c (because it's now done).
//
// Idempotent: if the invoice is already sent_to_1c, returns 200 with
// already_sent=true instead of mutating state. This protects against 1C
// network-retrying the same confirmation and causing duplicate purchase docs
// from being perceived as different invoices on the 1C side.
router.post('/:id/confirm', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid invoice id' });
    return;
  }
  const invoice = await invoiceRepo.getById(id);

  if (!invoice) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }

  if (invoice.status === 'sent_to_1c') {
    res.json({ data: { id, status: 'sent_to_1c', already_sent: true, sent_at: invoice.sent_at } });
    return;
  }

  await invoiceRepo.markSent(id);
  const db = getDb();
  await db.prepare('UPDATE invoices SET approved_for_1c = 0 WHERE id = ?').run(id);

  const invConfirmed = await invoiceRepo.getById(id);
  if (invConfirmed) {
    emitNotification('sent_to_1c', {
      invoice_id: invConfirmed.id,
      invoice_number: invConfirmed.invoice_number,
      supplier: invConfirmed.supplier,
      total_sum: invConfirmed.total_sum,
    }, req.user?.id ?? null).catch(() => {});
  }

  void logIntegrationEvent({
    integration: '1c', event_type: 'sent', invoice_id: id,
    summary: `Накладная №${invConfirmed?.invoice_number ?? id} загружена в 1С (подтверждено)`,
  });

  res.json({ data: { id, status: 'sent_to_1c', already_sent: false } });
});

// POST /api/invoices/:id/reset — reset from sent_to_1c back to processed.
// Also clears approved_for_1c flag so user has to explicitly re-approve
// before 1C picks it up again (avoids accidental double-imports).
router.post('/:id/reset', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const invoice = await invoiceRepo.getById(id);

  if (!invoice) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }

  const db = getDb();
  await db.prepare(
    "UPDATE invoices SET status = 'processed', sent_at = NULL, approved_for_1c = 0, approved_at = NULL WHERE id = ?"
  ).run(id);
  void logIntegrationEvent({
    integration: '1c', event_type: 'reset', invoice_id: id,
    summary: `Статус накладной №${invoice.invoice_number ?? id} сброшен (можно отправить в 1С заново)`,
  });
  res.json({ data: { id, status: 'processed', approved_for_1c: false } });
});

// POST /api/invoices/:id/read — пометить прочитанной/непрочитанной. Body {read:boolean}.
// Персональная UX-операция компании: owner-scoped через invoiceOwnershipGuard (не admin-only).
router.post('/:id/read', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const invoice = await invoiceRepo.getById(id);
  if (!invoice) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }
  const read = (req.body as { read?: boolean })?.read !== false; // по умолчанию true
  await invoiceRepo.setRead(id, read);
  res.json({ data: { id, read } });
});

// POST /api/invoices/:id/paid-externally — пометить «оплачено вне сервиса». Body {value:boolean}.
// Вынимает накладную из overdue-метки, карточки бэклога и обязательств «Операций».
router.post('/:id/paid-externally', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const invoice = await invoiceRepo.getById(id);
  if (!invoice) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }
  const value = (req.body as { value?: boolean })?.value !== false; // по умолчанию true
  await invoiceRepo.setPaidExternally(id, value);
  void logIntegrationEvent({
    integration: 'sber',
    event_type: value ? 'paid_externally_set' : 'paid_externally_cleared',
    invoice_id: id,
    summary: value
      ? `Накладная №${invoice.invoice_number ?? id} помечена «оплачено вне сервиса»`
      : `С накладной №${invoice.invoice_number ?? id} снята отметка «оплачено вне сервиса»`,
  });
  res.json({ data: { id, paid_externally: value } });
});

// POST /api/invoices/:id/unapprove — withdraw the "Отправить в 1С" approval.
// Use when user wants to cancel the pending 1C upload before 1C has fetched it.
router.post('/:id/unapprove', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const invoice = await invoiceRepo.getById(id);

  if (!invoice) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }

  await invoiceRepo.unapproveForOneC(id);
  void logIntegrationEvent({
    integration: '1c', event_type: 'unapproved', invoice_id: id,
    summary: `Отозвана отправка накладной №${invoice.invoice_number ?? id} в 1С`,
  });
  res.json({ data: { id, approved_for_1c: false } });
});

// POST /api/invoices/:id/merge-into/:targetId — manually fold one invoice
// (source) into another (target). For cases where the dispatcher's automatic
// multi-page reconciliation missed a split invoice (e.g. OCR garbled both the
// supplier AND the number so no structural signal fired). Items move source →
// target, the source photo is carried over, the grand total = max(both totals)
// is applied, and the source row is deleted.
router.post('/:id/merge-into/:targetId', async (req: Request, res: Response) => {
  const sourceId = parseInt(req.params.id as string);
  const targetId = parseInt(req.params.targetId as string);

  if (!Number.isFinite(sourceId) || !Number.isFinite(targetId) || sourceId === targetId) {
    res.status(400).json({ error: 'sourceId и targetId должны быть разными накладными' });
    return;
  }

  const source = await invoiceRepo.getById(sourceId);
  const target = await invoiceRepo.getById(targetId);
  if (!source || !target) {
    res.status(404).json({ error: 'Накладная не найдена' });
    return;
  }

  try {
    const grand = Math.max(source.total_sum ?? 0, target.total_sum ?? 0);
    // Move items first, then carry the photo(s), then drop the now-empty source.
    await invoiceRepo.moveItemsToInvoice(sourceId, targetId);
    const files = (source.file_name ?? '').split(',').map(s => s.trim()).filter(Boolean);
    for (const f of files) await invoiceRepo.appendFileName(targetId, f);
    await invoiceRepo.delete(sourceId);
    if (grand > 0) await invoiceRepo.updateInvoiceData(targetId, { total_sum: grand });
    // forceDerive: the target's stored vat_sum covered only its own pages; after
    // folding in the source's items it's stale, so recompute VAT from all items.
    await invoiceRepo.recalculateTotal(targetId, { forceDerive: true });

    logger.info('Manual invoice merge', { sourceId, targetId, grand });
    const merged = await invoiceRepo.getWithItems(targetId);
    res.json({ data: merged });
  } catch (err) {
    logger.error('Failed to merge invoices', { sourceId, targetId, error: (err as Error).message });
    res.status(500).json({ error: 'Ошибка объединения накладных' });
  }
});

// POST /api/invoices/:id/remap — re-run nomenclature matching.
// Query param: ?all=true to also re-map items that already have a GUID.
// Useful after 1C catalog update — new items may be a better match for
// already-mapped lines.
router.post('/:id/remap', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const includeAll = req.query.all === 'true';
  const invoice = await invoiceRepo.getById(id);

  if (!invoice) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }

  // Каталог и сопоставления пер-тенантные: работаем в области владельца
  // накладной, а не действующего пользователя — так админ, правящий чужую
  // накладную, всё равно видит каталог её компании.
  const mappingOwnerId = invoice.owner_user_id ?? -1;

  if (!mapper) {
    res.status(500).json({ error: 'Mapper not initialized' });
    return;
  }

  // Refresh mapper cache to pick up any new nomenclature
  mapper.invalidateCache();

  const items = await invoiceRepo.getItems(id);

  // Header total_sum recovery: invoices processed BEFORE the recalculateTotal
  // fix have a total_sum that was overwritten with Σ items. If raw_text is
  // a Claude JSON response and contains a bigger total_sum, prefer that —
  // it's the original "Всего к оплате" number the supplier signed under.
  // Harmless when raw_text has no total_sum or it matches the DB value.
  let restoredTotal = 0;
  let headerTotal = invoice.total_sum;
  if (invoice.raw_text) {
    const match = invoice.raw_text.match(/"total_sum"\s*:\s*(\d+(?:\.\d+)?)/);
    if (match) {
      const rawTotal = parseFloat(match[1]);
      if (isFinite(rawTotal) && rawTotal > 0 && (!headerTotal || rawTotal > headerTotal * 1.01)) {
        logger.info('Remap: restoring header total_sum from raw_text', {
          id, previous: headerTotal, restored: rawTotal,
        });
        // Extract vat_sum too, if present, to keep things coherent.
        const vatMatch = invoice.raw_text.match(/"vat_sum"\s*:\s*(\d+(?:\.\d+)?)/);
        const rawVat = vatMatch ? parseFloat(vatMatch[1]) : null;
        await invoiceRepo.updateInvoiceData(id, {
          total_sum: rawTotal,
          vat_sum: rawVat && isFinite(rawVat) ? rawVat : undefined,
        });
        headerTotal = rawTotal;
        restoredTotal = 1;
      }
    }
  }

  // Per-item VAT sanity check against header total_sum. This runs at ingest
  // in the watcher, but until now remap didn't retry it — so invoices stored
  // with mixed pre-VAT/post-VAT rows stayed broken forever. Do it first so
  // pack-transform below sees the corrected totals.
  let vatInflated = 0;
  if (headerTotal != null && headerTotal > 0 && items.length > 0) {
    const vatFix = sanitizeItemVatPerItem(
      items.map(i => ({
        quantity: i.quantity, unit: i.unit, price: i.price, total: i.total,
        vat_rate: i.vat_rate,
      })),
      headerTotal,
    );
    if (vatFix.report.inflated > 0) {
      logger.info('Remap: per-item VAT sanity inflated lines', vatFix.report);
      for (let k = 0; k < items.length; k++) {
        const before = items[k];
        const after = vatFix.items[k];
        if (after.total !== before.total || after.price !== before.price) {
          await invoiceRepo.updateItemFields(before.id, {
            total: after.total ?? null,
            price: after.price ?? null,
          });
          // Reflect in the in-memory list so the pack-transform loop below
          // sees the corrected numbers.
          items[k] = { ...before, total: after.total ?? null, price: after.price ?? null };
          vatInflated++;
        }
      }
    }
  }

  let remapped = 0;
  let changed = 0;
  let legacyMapped = 0;
  let repacked = 0;
  let cleaned = 0;
  for (const item of items) {
    const alreadyMapped = !!item.onec_guid;
    // Skip mapping lookup for already-mapped items unless ?all=true, but still
    // run pack-transform below so a pack_size learned AFTER first ingest can
    // retroactively convert qty/unit (e.g. 7 шт ведра → 21 кг сельди).
    const shouldLookup = includeAll || !alreadyMapped;
    const mappingContext = { supplierInn: invoice.supplier_inn, supplierName: invoice.supplier };
    const result = shouldLookup ? await mapper.map(item.original_name, mappingOwnerId, mappingContext) : null;

    if (result?.onec_guid) {
      if (result.onec_guid !== item.onec_guid) changed++;
      await invoiceRepo.updateItemMapping(
        item.id,
        result.onec_guid,
        result.mapped_name,
        result.confidence
      );
      remapped++;
    } else if (result?.source === 'legacy' && result.mapped_name !== item.original_name) {
      // Legacy mapping: no onec_guid, but we still have a known 1C name.
      // 1C's BSL code will resolve it via "НайтиИлиСоздатьНоменклатуру" by name.
      // Update the displayed name so the user sees the correct target even
      // without a catalog GUID. mapping_confidence set to 0.9 to match the
      // mapper's internal convention for legacy results.
      await invoiceRepo.updateItemMappingName(item.id, result.mapped_name, result.confidence);
      legacyMapped++;
    } else if (
      result?.source === 'none' &&
      result.mapped_name &&
      result.mapped_name !== item.mapped_name
    ) {
      // Unmatched: refresh the editable «Название (1С)» with the cleaned name so
      // rows ingested before name-cleaning get fixed when the user re-maps.
      await invoiceRepo.updateItemMappingName(item.id, result.mapped_name, result.confidence);
      cleaned++;
    }

    // Re-apply pack transform using the (possibly freshly-learned) pack_size
    // on the mapping. Watcher applies this once at ingest; without a repeat
    // here, mappings learned AFTER the invoice was first processed never
    // propagate. Idempotence guard inside applyPackTransform makes repeated
    // calls safe — if unit already matches pack_unit, nothing changes.
    //
    // When we skipped the mapper lookup above (already-mapped item without
    // ?all=true), fetch the current mapping directly so pack_size can still
    // be honoured.
    const mappingForPack = result ?? await mapper.map(item.original_name, mappingOwnerId, mappingContext);
    // Prefer the unit from whatever catalog row this item resolves to —
    // either the mapping's guid (learned mapping) or the item's own guid
    // (freshly placed by LLM-remap without a mappings row yet). Without
    // this, pack-transform runs blind and can mangle rows whose 1C side
    // is countable (e.g. "Бутылка ПЭТ 0,3 …" → qty × 150 × 150).
    const packGuid = mappingForPack.onec_guid || item.onec_guid;
    const remapOnec1cUnit = packGuid
      ? (await onecNomenclatureRepo.getByGuid(packGuid, mappingOwnerId))?.unit ?? null
      : null;
    const resolved = resolveAndApplyPackTransform(
      { quantity: item.quantity, unit: item.unit, price: item.price, total: item.total },
      item.original_name,
      mappingForPack.pack_size,
      mappingForPack.pack_unit,
      mappingForPack.mapped_name,
      remapOnec1cUnit,
    );
    const before = { qty: item.quantity, unit: item.unit, price: item.price };
    const after = resolved.item;
    if (
      after.quantity !== before.qty
      || after.unit !== before.unit
      || after.price !== before.price
    ) {
      await invoiceRepo.updateItemFields(item.id, {
        quantity: after.quantity ?? null,
        unit: after.unit ?? null,
        price: after.price ?? null,
      });
      repacked++;
    }
  }

  // Totals may have shifted if pack-transform changed any prices (it shouldn't
  // — total is preserved — but flag mismatches regardless).
  await invoiceRepo.recalculateTotal(id);

  logger.info('Re-mapped invoice items', { id, remapped, legacyMapped, changed, repacked, cleaned, vatInflated, restoredTotal, total: items.length, all: includeAll });
  res.json({ data: { id, remapped, legacyMapped, changed, repacked, cleaned, vatInflated, restoredTotal, total: items.length } });
});

// POST /api/invoices/:id/llm-remap — ask Claude to map items against the
// current 1C catalog. By default only touches items where onec_guid IS NULL
// (fill-in-the-gaps mode). Pass ?all=true to also reconsider already-mapped
// items — useful when the catalog grew or the existing mapping is dubious.
//
// When all=true and Claude returns null for an already-mapped item we LEAVE
// the existing guid in place (Claude's null is "no better candidate", not
// "unmap this"). pack_size / unit_override from the LLM are applied only
// for items whose guid actually changed or that were unmapped before — we
// don't re-repack rows that already have correct numbers.
router.post('/:id/llm-remap', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const includeAll = req.query.all === 'true' || req.query.all === '1';
  const invoice = await invoiceRepo.getById(id);
  if (!invoice) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }

  // Каталог и сопоставления пер-тенантные: работаем в области владельца
  // накладной, а не действующего пользователя — так админ, правящий чужую
  // накладную, всё равно видит каталог её компании.
  const mappingOwnerId = invoice.owner_user_id ?? -1;

  const items = await invoiceRepo.getItems(id);
  const targets = includeAll ? items : items.filter(it => !it.onec_guid);
  if (targets.length === 0) {
    res.json({
      data: {
        id, requested: 0, matched: 0, changed: 0, repacked: 0, total: items.length,
        message: includeAll ? 'В накладной нет товаров' : 'Нет несопоставленных товаров',
      },
    });
    return;
  }

  // Build the catalog snapshot ONCE — the same ordering is used both to
  // build the prompt and to resolve catalog_idx back to a guid in the
  // response.
  const catalogRows = await onecNomenclatureRepo.listItems({ ownerUserId: mappingOwnerId, excludeFolders: true });
  if (catalogRows.length === 0) {
    res.status(400).json({ error: 'Справочник 1С пуст — нечего сопоставлять. Сначала выгрузите номенклатуру из 1С.' });
    return;
  }
  const catalog: CatalogEntry[] = catalogRows.map(r => ({ guid: r.guid, name: r.name, unit: r.unit }));

  const analyzerCfg = await invoiceRepo.getAnalyzerConfig();
  const apiKey = analyzerCfg.anthropic_api_key || config.anthropicApiKey;
  if (!apiKey) {
    res.status(500).json({ error: 'Anthropic API key not configured' });
    return;
  }

  const result = await mapItemsWithClaudeApi(
    targets.map(it => ({ key: String(it.id), name: it.original_name || '', unit: it.unit })),
    catalog,
    apiKey,
    analyzerCfg.claude_model || 'claude-sonnet-5',
  );

  if (!result.success || !result.matched) {
    res.status(502).json({ error: result.error || 'LLM mapping failed' });
    return;
  }

  let matched = 0;   // items for which Claude returned a guid
  let changed = 0;   // items whose guid actually changed vs DB
  let repacked = 0;  // items on which we applied pack_size / unit_override
  let coercedCount = 0;  // items whose unit was coerced to the 1C accounting unit
  for (const it of targets) {
    const hit = result.matched.get(String(it.id));
    const wasUnmapped = !it.onec_guid;

    // Path A: Claude returned a hit. Apply guid + maybe pack_size / unit_override.
    if (hit) {
      matched++;
      const guidChanged = it.onec_guid !== hit.guid;
      if (guidChanged) {
        await invoiceRepo.updateItemMapping(it.id, hit.guid, hit.name, 1.0);
        changed++;
      }
      const onec1cUnit = (await onecNomenclatureRepo.getByGuid(hit.guid, mappingOwnerId))?.unit ?? null;

      // Pack-transforms multiply qty — so we only run them when this row is
      // either NEW (was unmapped) or the guid switched. Otherwise we'd double-
      // count on every re-run.
      const canRepack = wasUnmapped || guidChanged;

      if (canRepack) {
        // Unified pack-transform path that mirrors fileWatcher. Priority for
        // pack hints: LLM (when complete) → learned mapping → regex fallback
        // via detectPackFromName. The regex fallback is what catches
        // "Мука (50кг)" — without it, items that were originally unmapped
        // and only got their guid via this LLM-remap call would never get
        // their qty/unit corrected from "1 шт" to "50 кг".
        const learnedMapping = await mappingRepo.getByScannedName(it.original_name || '', mappingOwnerId);
        const llmGavePackHint = !!(hit.pack_size && hit.pack_size > 0 && hit.unit_override);
        const hintedSize = llmGavePackHint ? hit.pack_size : (learnedMapping?.pack_size ?? null);
        const hintedUnit = llmGavePackHint ? hit.unit_override : (learnedMapping?.pack_unit ?? null);

        const resolved = resolveAndApplyPackTransform(
          { quantity: it.quantity, unit: it.unit, price: it.price, total: it.total },
          it.original_name || '',
          hintedSize,
          hintedUnit,
          hit.name,
          onec1cUnit,
        );

        const r = resolved.item;
        const beforeQty = it.quantity;
        const beforeUnit = it.unit;
        const beforePrice = it.price;
        if (r.quantity !== beforeQty || r.unit !== beforeUnit || r.price !== beforePrice) {
          await invoiceRepo.updateItemFields(it.id, {
            quantity: r.quantity ?? null,
            unit: r.unit ?? null,
            price: r.price ?? null,
          });
          repacked++;
        }

        // Persist regex-detected pack back to the mapping (как watcher) —
        // следующий llm-remap пойдёт по learned-mapping ветке, а не regex.
        if (resolved.usedFallback && learnedMapping && resolved.packSize && resolved.packUnit) {
          await mappingRepo.update(learnedMapping.id, mappingOwnerId, {
            pack_size: resolved.packSize,
            pack_unit: resolved.packUnit,
          });
        }
      } else {
        // Already-mapped, no guid change — coerce-only (idempotent). Even
        // long-standing rows whose unit doesn't match the 1C accounting unit
        // (e.g. stored as "л" while 1C tracks in "кг") get fixed here.
        const coerced = coerceToOnec1cUnit(
          { quantity: it.quantity, unit: it.unit, price: it.price, total: it.total },
          onec1cUnit,
        );
        if (coerced.unit !== it.unit || coerced.quantity !== it.quantity) {
          await invoiceRepo.updateItemFields(it.id, coerced);
          coercedCount++;
        }
      }
      continue;
    }

    // Path B: Claude returned no hit. We can't re-map but we CAN still
    // coerce the unit if the row was already mapped previously and is
    // sitting in a non-1C unit (e.g. "л" while 1C tracks in "кг").
    if (!wasUnmapped) {
      const onec1cUnit = (await onecNomenclatureRepo.getByGuid(it.onec_guid as string, mappingOwnerId))?.unit ?? null;
      const coerced = coerceToOnec1cUnit(
        { quantity: it.quantity, unit: it.unit, price: it.price, total: it.total },
        onec1cUnit,
      );
      if (coerced.unit !== it.unit || coerced.quantity !== it.quantity) {
        await invoiceRepo.updateItemFields(it.id, coerced);
        coercedCount++;
      }
    }
  }

  // Flags the invoice if Σ(items.total) drifts from invoice.total_sum.
  await invoiceRepo.recalculateTotal(id);

  logger.info('LLM-remap completed', {
    id, requested: targets.length, matched, changed, repacked, coerced: coercedCount, all: includeAll,
  });

  res.json({
    data: {
      id,
      requested: targets.length,
      matched,
      changed,
      repacked,
      coerced: coercedCount,
      total: items.length,
    },
  });
});

// DELETE /api/invoices/:id — delete invoice, its items, and associated files
router.delete('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const invoice = await invoiceRepo.getById(id);

  if (!invoice) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }

  try {
    const { file_name } = await invoiceRepo.delete(id);

    deleteStoredInvoiceFiles(file_name);

    res.json({ data: { id, deleted: true } });
  } catch (err) {
    logger.error('Failed to delete invoice', { id, error: (err as Error).message });
    res.status(500).json({ error: 'Ошибка удаления накладной' });
  }
});

// Validate a batch `{ids}` body and load the invoices, enforcing that EVERY id
// belongs to the caller (same preflight as delete-batch — a mixed-owner batch
// must not partially act, and 404 avoids leaking another tenant's ids). Returns
// the loaded invoices, or null after already sending the error response.
async function loadOwnedBatch(req: Request, res: Response): Promise<Invoice[] | null> {
  const rawIds = req.body?.ids;
  if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > 500) {
    res.status(400).json({ error: 'ids must be a non-empty array with at most 500 entries' });
    return null;
  }
  if (rawIds.some(id => !Number.isInteger(id) || id <= 0)) {
    res.status(400).json({ error: 'every invoice id must be a positive integer' });
    return null;
  }
  const ids = [...new Set(rawIds as number[])];
  const invoices = await Promise.all(ids.map(id => invoiceRepo.getById(id)));
  const loaded: Invoice[] = [];
  for (const invoice of invoices) {
    if (!invoice || invoice.owner_user_id !== req.user?.id) {
      res.status(404).json({ error: 'Invoice not found' });
      return null;
    }
    loaded.push(invoice);
  }
  return loaded;
}

// POST /api/invoices/send-1c-batch — mass "→ 1С" (approve) for selected invoices.
router.post('/send-1c-batch', async (req: Request, res: Response) => {
  const invoices = await loadOwnedBatch(req, res);
  if (!invoices) return;
  const result = await bulkSend1c(invoices, req.header('X-API-Key') ?? '');
  res.json({ data: result });
});

// POST /api/invoices/send-sber-batch — mass "→ Сбер" (create payment drafts).
router.post('/send-sber-batch', async (req: Request, res: Response) => {
  const invoices = await loadOwnedBatch(req, res);
  if (!invoices) return;
  const result = await bulkSendSber(invoices, req.header('X-API-Key') ?? '');
  res.json({ data: result });
});

// POST /api/invoices/delete-batch — delete multiple invoices
router.post('/delete-batch', async (req: Request, res: Response) => {
  const rawIds = req.body?.ids;
  if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > 500) {
    res.status(400).json({ error: 'ids must be a non-empty array with at most 500 entries' });
    return;
  }

  if (rawIds.some(id => !Number.isInteger(id) || id <= 0)) {
    res.status(400).json({ error: 'every invoice id must be a positive integer' });
    return;
  }

  const ids = [...new Set(rawIds as number[])];
  const invoices = await Promise.all(ids.map(id => invoiceRepo.getById(id)));
  for (const invoice of invoices) {
    const visible = invoice && invoice.owner_user_id === req.user?.id;
    if (!visible) {
      // Preflight the whole batch before deleting anything. A mixed-owner batch
      // must not partially succeed, and 404 avoids leaking another tenant's ids.
      res.status(404).json({ error: 'Invoice not found' });
      return;
    }
  }

  let deleted = 0;

  for (const id of ids) {
    try {
      const { file_name } = await invoiceRepo.delete(id);
      deleteStoredInvoiceFiles(file_name);
      deleted++;
    } catch (err) {
      logger.error('Failed to delete invoice in batch', { id, error: (err as Error).message });
    }
  }

  res.json({ data: { deleted, total: ids.length } });
});

// POST /api/invoices/canonicalize-suppliers — retroactively rewrite supplier
// names in existing invoices to the canonical form (ООО "Name" / ИП Name).
// Safe to run repeatedly — canonicalizeSupplierName is idempotent.
router.post('/canonicalize-suppliers', requireAdmin, async (_req: Request, res: Response) => {
  const db = getDb();
  const rows = await db.prepare(
    `SELECT id, supplier FROM invoices WHERE supplier IS NOT NULL AND supplier != ''`
  ).all<{ id: number; supplier: string }>();

  const update = db.prepare('UPDATE invoices SET supplier = ? WHERE id = ?');
  let updated = 0;
  const changes: Array<{ id: number; before: string; after: string }> = [];

  for (const row of rows) {
    const canonical = canonicalizeSupplierName(row.supplier);
    if (canonical && canonical !== row.supplier) {
      await update.run(canonical, row.id);
      updated++;
      if (changes.length < 20) {
        changes.push({ id: row.id, before: row.supplier, after: canonical });
      }
    }
  }

  logger.info('Canonicalized supplier names', { total: rows.length, updated });
  res.json({
    data: {
      scanned: rows.length,
      updated,
      sample_changes: changes,
    },
  });
});

// POST /api/invoices/reprocess — move files from processed/failed back to inbox
// Used to retrigger OCR+parsing after parser improvements, or to retry failed invoices.
// Body: { file_names: string[], wait_for_completion?: boolean }
// Sequential: moves file, waits for processing (DB poll) before moving next.
// This matters for multi-page merging where page N+1 must find page N's DB record.
router.post('/reprocess', requireAdmin, async (req: Request, res: Response) => {
  const { file_names, wait_for_completion = true } = req.body as {
    file_names?: unknown;
    wait_for_completion?: boolean;
  };

  if (!Array.isArray(file_names) || file_names.length === 0) {
    res.status(400).json({ error: 'file_names must be a non-empty array of strings' });
    return;
  }
  if (file_names.some(f => typeof f !== 'string' || !f)) {
    res.status(400).json({ error: 'Each file_name must be a non-empty string' });
    return;
  }

  const results: Array<{ file: string; status: string; from?: string; invoice_id?: number; error?: string }> = [];

  for (let i = 0; i < file_names.length; i++) {
    // Path-traversal protection: take basename only
    const fileName = path.basename(file_names[i] as string);

    const processedPath = path.join(config.processedDir, fileName);
    const failedPath = path.join(config.failedDir, fileName);
    const inboxPath = path.join(config.inboxDir, fileName);

    let source: string | null = null;
    let sourceLabel = '';
    if (fs.existsSync(processedPath)) {
      source = processedPath;
      sourceLabel = 'processed';
    } else if (fs.existsSync(failedPath)) {
      source = failedPath;
      sourceLabel = 'failed';
    }

    if (!source) {
      results.push({ file: fileName, status: 'not_found' });
      continue;
    }

    try {
      // Move file to inbox — the chokidar file watcher will pick it up
      fs.renameSync(source, inboxPath);
      logger.info('Reprocess: moved file to inbox', { file: fileName, from: sourceLabel });

      if (wait_for_completion) {
        // Poll DB for processing completion (max 90s)
        const invoiceId = await waitForProcessed(fileName, 90000);
        if (invoiceId) {
          results.push({ file: fileName, status: 'processed', from: sourceLabel, invoice_id: invoiceId });
        } else {
          results.push({ file: fileName, status: 'timeout', from: sourceLabel });
        }
      } else {
        results.push({ file: fileName, status: 'moved', from: sourceLabel });
      }
    } catch (err) {
      results.push({ file: fileName, status: 'error', error: (err as Error).message });
    }
  }

  res.json({ data: { results } });
});

/**
 * Poll for an invoice record with this fileName to reach a terminal status
 * (processed, sent_to_1c, or error). Returns the invoice id on success,
 * null on timeout.
 */
async function waitForProcessed(fileName: string, timeoutMs: number): Promise<number | null> {
  const start = Date.now();
  const terminalStatuses = ['processed', 'sent_to_1c', 'error'];

  while (Date.now() - start < timeoutMs) {
    const inv = await invoiceRepo.findRecentByFileName(fileName, 10);
    if (inv && terminalStatuses.includes(inv.status)) {
      return inv.id;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return null;
}

// PUT /api/invoices/:invoiceId/items/:itemId/map — set or clear onec_guid for a single line item.
//
// When setting (onec_guid is a non-empty string):
//   - Validates the onec_guid exists in onec_nomenclature
//   - Updates invoice_items.onec_guid + mapped_name (to the 1C catalog name)
//   - Upserts nomenclature_mappings for this scan name → onec_guid (learned mapping)
//   - Records supplier usage (times_seen, last_seen_*)
//   - Invalidates mapper cache so the next invoice benefits immediately
//
// When clearing (onec_guid is null, empty string, whitespace):
//   - Clears invoice_items.onec_guid on this item only
//   - Reverts invoice_items.mapped_name to the original_name (raw scan text)
//   - Does NOT touch nomenclature_mappings — clearing one invoice's mapping must not
//     corrupt the global learned mapping that other invoices may still depend on
//   - Invalidates mapper cache (no-op in practice since learned mapping is unchanged,
//     but cheap and defensive)
//
// All mutations are wrapped in a single DB transaction so partial failure cannot
// leave inconsistent state across invoice_items / nomenclature_mappings / mapping_supplier_usage.
router.put('/:invoiceId/items/:itemId/map', async (req: Request, res: Response) => {
  const invoiceId = parseInt(req.params.invoiceId as string, 10);
  const itemId = parseInt(req.params.itemId as string, 10);
  if (Number.isNaN(invoiceId) || Number.isNaN(itemId)) {
    res.status(400).json({ error: 'invalid invoiceId or itemId' });
    return;
  }

  // Normalize onec_guid: empty string / whitespace / missing → null, otherwise trimmed string
  const body = req.body as {
    onec_guid?: string | null;
    pack_size?: number | null;
    pack_unit?: string | null;
  } | undefined;
  const rawGuid = body?.onec_guid;
  const onec_guid: string | null =
    typeof rawGuid === 'string' && rawGuid.trim() !== '' ? rawGuid.trim() : null;

  // Pack fields: accept number (optionally via string), non-positive / NaN → null
  const rawPackSize = body?.pack_size;
  const packSizeNum = rawPackSize == null ? null : Number(rawPackSize);
  const pack_size: number | null =
    packSizeNum != null && isFinite(packSizeNum) && packSizeNum > 0 ? packSizeNum : null;
  const rawPackUnit = body?.pack_unit;
  const pack_unit: string | null =
    typeof rawPackUnit === 'string' && rawPackUnit.trim() !== '' ? rawPackUnit.trim() : null;

  const invoice = await invoiceRepo.getById(invoiceId);
  if (!invoice) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }

  // Каталог и сопоставления пер-тенантные: работаем в области владельца
  // накладной, а не действующего пользователя — так админ, правящий чужую
  // накладную, всё равно видит каталог её компании.
  const mappingOwnerId = invoice.owner_user_id ?? -1;
  const item = await invoiceRepo.getItemById(itemId);
  if (!item || item.invoice_id !== invoiceId) {
    res.status(404).json({ error: 'Invoice item not found' });
    return;
  }
  const parentInvoice = await invoiceRepo.getById(invoiceId);
  if (!parentInvoice || parentInvoice.owner_user_id !== req.user?.id) {
    res.status(404).json({ error: 'Invoice item not found' });
    return;
  }

  // If setting a mapping, validate the GUID exists in the synced catalog
  let resolvedName: string | null = null;
  if (onec_guid) {
    const onecRow = await onecNomenclatureRepo.getByGuid(onec_guid, mappingOwnerId);
    if (!onecRow) {
      res.status(400).json({ error: 'onec_guid not found in onec_nomenclature' });
      return;
    }
    resolvedName = onecRow.name;
  }

  // Display name: 1C catalog name when mapping is set, raw scan text when clearing
  const displayName = onec_guid ? resolvedName : item.original_name;

  // If pack transform is provided alongside the mapping, compute the new
  // quantity/unit/price BEFORE the transaction so we can write them atomically
  // with the mapping change. Total is preserved unchanged.
  const applyPack = onec_guid != null && pack_size != null && pack_unit != null;
  let transformedQty: number | null = item.quantity;
  let transformedUnit: string | null = item.unit;
  let transformedPrice: number | null = item.price;
  if (applyPack && item.quantity != null && item.quantity > 0) {
    const total = item.total != null
      ? item.total
      : (item.price != null ? item.price * item.quantity : null);
    const newQty = item.quantity * (pack_size as number);
    const newPrice = total != null && newQty > 0 ? total / newQty : item.price;
    transformedQty = newQty;
    transformedUnit = pack_unit;
    transformedPrice = newPrice;
  }

  // All mutations in one transaction
  await getDb().transaction(async (txn) => {
    await invoiceRepo.mapItem(itemId, onec_guid, displayName);

    // Write transformed quantity/unit/price on the item if applicable
    if (applyPack) {
      await invoiceRepo.updateItemQuantity(itemId, transformedQty, transformedUnit, transformedPrice);
    }

    // Learning loop: only touch the global nomenclature_mappings when SETTING.
    // Clearing a single invoice item's mapping must not corrupt a learned mapping
    // that other invoices may still rely on. Pack fields are persisted alongside
    // only when explicitly provided — if the caller omits them, any existing
    // pack values on the learned mapping are preserved (we can't tell from an
    // empty body whether the user wanted to clear or just didn't re-send them).
    if (onec_guid) {
      const upsertPayload: Parameters<typeof mappingRepo.upsert>[0] = {
        scanned_name: item.original_name,
        mapped_name_1c: resolvedName as string,
        onec_guid,
      };
      if (applyPack) {
        upsertPayload.pack_size = pack_size;
        upsertPayload.pack_unit = pack_unit;
      }
      await mappingRepo.upsert(upsertPayload, mappingOwnerId);
      const supplierKey = makeSupplierKey(invoice.supplier_inn, invoice.supplier);
      if (supplierKey) {
        await supplierMappingRepo.upsert({
          supplierKey,
          scannedName: item.original_name,
          mappedName: resolvedName as string,
          onecGuid: onec_guid,
        }, mappingOwnerId);
      }
    }
    // Touch txn so unused-param lint stays quiet — actual writes go through repos.
    void txn;
  });
  // Invalidate mapper cache so the next fuzzy lookup rebuilds
  if (mapper) mapper.invalidateCache();

  const updatedItem = await invoiceRepo.getItemById(itemId);
  if (!updatedItem) {
    res.status(500).json({ error: 'Failed to retrieve updated item' });
    return;
  }
  res.json({ data: updatedItem });
});

// PATCH /api/invoices/:invoiceId/items/:itemId — inline-edit of an item's
// numeric/text fields. Accepts any subset of {quantity, unit, price, total};
// missing keys are left untouched. If quantity+price are both known after
// the update, total is auto-derived unless explicitly provided.
//
// Always triggers recalculateTotal on the parent invoice so the sum +
// items_total_mismatch flag stay accurate.
router.patch('/:invoiceId/items/:itemId', async (req: Request, res: Response) => {
  const invoiceId = parseInt(req.params.invoiceId as string, 10);
  const itemId = parseInt(req.params.itemId as string, 10);
  if (!Number.isFinite(invoiceId) || !Number.isFinite(itemId)) {
    res.status(400).json({ error: 'invalid invoiceId or itemId' });
    return;
  }

  const item = await invoiceRepo.getItemById(itemId);
  if (!item || item.invoice_id !== invoiceId) {
    res.status(404).json({ error: 'Invoice item not found' });
    return;
  }
  const editedInvoice = await invoiceRepo.getById(invoiceId);
  if (!editedInvoice || editedInvoice.owner_user_id !== req.user?.id) {
    res.status(404).json({ error: 'Invoice item not found' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;

  // Custom name for an UNMATCHED item: this exact text is what 1C creates
  // Номенклатура from. Handled separately — it clears any catalog match and
  // flags the override so the dashboard can confirm it visually.
  if ('mapped_name' in body) {
    const raw = body.mapped_name;
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!name) {
      res.status(400).json({ error: 'mapped_name must be a non-empty string' });
      return;
    }
    const updated = await invoiceRepo.setItemCustomName(itemId, name);
    res.json({ data: updated });
    return;
  }

  const toNumOrNull = (v: unknown): number | null | undefined => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined; // undefined → caller passed garbage, ignore
  };

  const fields: { quantity?: number | null; unit?: string | null; price?: number | null; total?: number | null } = {};
  if ('quantity' in body) {
    const q = toNumOrNull(body.quantity);
    if (q === undefined) { res.status(400).json({ error: 'invalid quantity' }); return; }
    fields.quantity = q;
  }
  if ('unit' in body) {
    const u = body.unit;
    fields.unit = (typeof u === 'string' && u.trim() !== '') ? u.trim() : null;
  }
  if ('price' in body) {
    const p = toNumOrNull(body.price);
    if (p === undefined) { res.status(400).json({ error: 'invalid price' }); return; }
    fields.price = p;
  }
  if ('total' in body) {
    const t = toNumOrNull(body.total);
    if (t === undefined) { res.status(400).json({ error: 'invalid total' }); return; }
    fields.total = t;
  }

  // Auto-derive total from qty*price if both are set after this patch and
  // caller didn't explicitly set total. This mirrors what the UI expects when
  // user edits just qty or price.
  const effQty = 'quantity' in fields ? fields.quantity : item.quantity;
  const effPrice = 'price' in fields ? fields.price : item.price;
  if (!('total' in fields) && effQty != null && effPrice != null) {
    fields.total = Math.round(effQty * effPrice * 100) / 100;
  }

  if (Object.keys(fields).length === 0) {
    res.status(400).json({ error: 'no editable fields provided' });
    return;
  }

  await getDb().transaction(async (txn) => {
    await invoiceRepo.updateItemFields(itemId, fields);
    // Keep the invoice total + mismatch flag in sync with the edited items.
    await invoiceRepo.recalculateTotal(invoiceId);
    void txn;
  });
  // Единицу измерения запоминаем только в области владельца накладной —
  // см. комментарий в PATCH /:id. Без владельца правка просто не запоминается.
  if ('unit' in fields && editedInvoice.owner_user_id != null) {
    await ocrCorrectionRepo.remember(
      supplierCorrectionKey(editedInvoice), 'item_unit', item.unit, fields.unit, editedInvoice.owner_user_id,
    );
  }

  const updated = await invoiceRepo.getItemById(itemId);
  const invoice = await invoiceRepo.getById(invoiceId);

  if (invoice) {
    emitNotification('invoice_edited', {
      invoice_id: invoice.id,
      invoice_number: invoice.invoice_number,
      supplier: invoice.supplier,
      total_sum: invoice.total_sum,
    }, req.user?.id ?? null).catch(() => {});
  }

  res.json({
    data: {
      item: updated,
      invoice_total_sum: invoice?.total_sum ?? null,
      items_total_mismatch: invoice?.items_total_mismatch ?? 0,
    },
  });
});

// POST /api/invoices/:id/rescan — full re-process: re-OCR + re-Claude + re-map.
// Используется кнопкой UI «Пересканировать фото» когда юзеру нужен полный
// rerun pipeline (например, после обновления промпта или 1С-каталога).
// Файл должен ещё лежать на диске (processed/ или inbox/).
router.post('/:id/rescan', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
  if (!fileWatcher) return res.status(500).json({ error: 'FileWatcher not initialized' });

  const invoice = await invoiceRepo.getById(id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

  try {
    await fileWatcher.reprocessInvoice(id);
    return res.json({ success: true });
  } catch (err) {
    logger.error('Rescan failed', { id, error: (err as Error).message });
    return res.status(502).json({ error: (err as Error).message });
  }
});

// POST /api/invoices/:id/unlink-duplicate — отметить накладную как «не дубликат».
// Сбрасывает duplicate_of в NULL и возвращает status='processed'. Items при этом
// НЕ восстанавливаются — если юзер хочет полную обработку, нужно нажать «Удалить»
// и переотсканировать.
router.post('/:id/unlink-duplicate', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
  const invoice = await invoiceRepo.getById(id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (invoice.duplicate_of == null) {
    return res.status(400).json({ error: 'Invoice is not marked as duplicate' });
  }
  await invoiceRepo.unmarkAsDuplicate(id);
  return res.json({ success: true });
});

// GET /api/invoices/:id/sber-status — текущее состояние платежа в Сбере
router.get('/:id/sber-status', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
  const payment = await sberPaymentRepo.findByInvoiceId(id);
  return res.json({ payment });
});

// DELETE /api/invoices/:id/sber-payment — удалить запись о платеже из БД ScanFlow.
// Реальный черновик в СберБизнес НЕ удаляется (Sber API в нашем scope такое не
// позволяет). Юзер должен открыть свой банк и удалить вручную. Этот endpoint
// нужен для retry-сценария и для очистки записей, которые юзер уже разрулил
// в банке.
router.delete('/:id/sber-payment', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
  await sberPaymentRepo.deleteByInvoiceId(id);
  return res.json({ success: true });
});

// POST /api/invoices/:id/send-sber — создать черновик платежа в СберБизнес
router.post('/:id/send-sber', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
  const invoice = await invoiceRepo.getById(id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

  // Amount-based approval gate. The existing payment route remains the single
  // execution path; a large payment first creates an auditable request and can
  // only continue after an admin decision.
  const automation = await automationRepo.get();
  if (automation.payment_approval_threshold != null
      && (invoice.total_sum ?? 0) > automation.payment_approval_threshold
      && !(await approvalRepo.hasApproved(id, 'sber'))) {
    const approval = await approvalRepo.create(id, 'sber', req.user?.id ?? null, 'Автоматически создано по лимиту суммы');
    return res.status(409).json({
      error: `Платёж выше лимита ${automation.payment_approval_threshold.toFixed(2)} ₽ и ожидает согласования`,
      needs_approval: true,
      approval_id: approval.id,
    });
  }

  const existingPayment = await sberPaymentRepo.findByInvoiceId(id);
  if (existingPayment) {
    if (existingPayment.status === 'failed') {
      // Предыдущая попытка упала — разрешаем retry (юзер явно нажал кнопку
      // ещё раз). Удаляем старую строку, дальше идёт обычный create.
      await sberPaymentRepo.deleteByInvoiceId(id);
    } else {
      // status === 'created' | 'pending' — реальный конфликт.
      return res.status(409).json({
        error: 'Payment already created for this invoice',
        existing_status: existingPayment.status,
        existing_payment_number: existingPayment.sber_payment_number,
      });
    }
  }
  if (!invoice.total_sum || invoice.total_sum <= 0) {
    return res.status(400).json({ error: 'invoice has no total_sum' });
  }
  if (!invoice.supplier_inn) {
    return res.status(400).json({ error: 'invoice has no supplier_inn' });
  }

  // Подключение к Сберу и справочник поставщиков пер-тенантные: работаем только
  // в области владельца накладной. Без владельца платить нельзя — иначе и счёт
  // списания, и реквизиты пришлось бы брать у чужой компании.
  const supplierOwnerId = invoice.owner_user_id;
  if (supplierOwnerId == null) {
    return res.status(400).json({ error: 'У накладной не указан владелец — отправка в Сбербанк невозможна' });
  }

  const tokenRow = await sberTokenRepo.get(supplierOwnerId);
  if (!tokenRow) return res.status(400).json({ error: 'Sber not connected' });
  if (!tokenRow.account_number || !tokenRow.org_name || !tokenRow.payer_inn ||
      !tokenRow.payer_bank_bic || !tokenRow.payer_bank_corr_account) {
    return res.status(400).json({ error: 'payer details incomplete (settings → Сбербанк)' });
  }

  // Resolve supplier
  const overrides = (req.body as { supplier_overrides?: Record<string, unknown> }).supplier_overrides;
  let supplier = await supplierRepo.findByInn(invoice.supplier_inn, supplierOwnerId);
  if (overrides) {
    const o = overrides as {
      inn?: string; name?: string; kpp?: string;
      account?: string; bank_bic?: string; bank_corr_account?: string;
      bank_name?: string; address?: string;
    };
    if (!o.inn || !o.name || !o.bank_bic) {
      return res.status(400).json({ error: 'supplier_overrides missing required fields (inn, name, bank_bic)' });
    }
    supplier = await supplierRepo.upsert({
      inn: o.inn, name: o.name, kpp: o.kpp ?? null,
      account: o.account ?? null, bank_bic: o.bank_bic,
      bank_corr_account: o.bank_corr_account ?? null,
      bank_name: o.bank_name ?? null, address: o.address ?? null,
      verified: 1, source: 'invoice',
    }, supplierOwnerId);
  }
  if (!supplier || !supplier.verified) {
    // Prefill the confirmation modal from the saved supplier card (looked up by
    // ИНН) when one exists — даже если verified=0 (например, заведён фото-
    // экстрактом). Реквизиты (БИК/счёт/корсчёт/банк/адрес) берём из справочника,
    // OCR-данные накладной — только как запасной вариант. Так пользователю не
    // нужно вводить то, что уже сохранено в Справочники → Поставщики.
    return res.status(409).json({
      needs_supplier_confirmation: true,
      prefilled: {
        inn: invoice.supplier_inn,
        name: supplier?.name ?? invoice.supplier ?? '',
        kpp: supplier?.kpp ?? invoice.supplier_kpp ?? null,
        bank_bic: supplier?.bank_bic ?? invoice.supplier_bik ?? null,
        account: supplier?.account ?? invoice.supplier_account ?? null,
        bank_corr_account: supplier?.bank_corr_account ?? invoice.supplier_corr_account ?? null,
        bank_name: supplier?.bank_name ?? null,
        address: supplier?.address ?? invoice.supplier_address ?? null,
      },
    });
  }

  // Get token (auto-refresh)
  let accessToken: string;
  try {
    accessToken = await getValidAccessToken(supplierOwnerId);
  } catch (err) {
    // NB: must NOT be 401 here. The frontend treats *any* 401 as "your ScanFlow
    // X-API-Key is dead" and logs the user out (see App.api in public/js/app.js).
    // A failed *Sber* OAuth refresh is an upstream-auth problem, not a ScanFlow
    // session problem — return 502 (same as the SberApiError branch below) so
    // the user sees an actionable error instead of being kicked to the login page.
    return res.status(502).json({
      error: `Не удалось авторизоваться в Сбербанке: ${(err as Error).message}. Переподключите Сбербанк на странице /#/sber.`,
    });
  }

  // Render purpose
  const purposeOverride = (req.body as { purpose_override?: string }).purpose_override;
  // Шаблон назначения — профильное (индивидуальное) поле, поэтому берётся у
  // владельца накладной. firstUserId() подставлял сюда шаблон чужой компании.
  const templateOwnerId = invoice.owner_user_id;
  const tpl =
    purposeOverride ??
    (templateOwnerId != null ? await userRepo.getPurposeTemplate(templateOwnerId) : null) ??
    'Оплата по накладной № {invoice_number} от {invoice_date_dot}, {vat_clause}';
  const items = await invoiceRepo.getItems(id);
  const firstVatRate = items[0]?.vat_rate ?? null;
  const purpose = renderPurpose(tpl, {
    invoice_number: invoice.invoice_number,
    invoice_date: invoice.invoice_date,
    total_sum: invoice.total_sum,
    vat_sum: invoice.vat_sum,
    vat_rate: firstVatRate,
    supplier: supplier.name,
  });

  const externalId = randomUUID();
  // Payment document date in Moscow time (business TZ). toISOString() uses UTC,
  // which yields yesterday's date for sends between 21:00–23:59 MSK. en-CA
  // formats as YYYY-MM-DD, which passes the Sber payload date validation.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());

  // Quantize to kopecks. total_sum is a DOUBLE, so a sum of per-item totals can
  // carry binary-float artifacts (e.g. 300.30000000000007). Sber expects a
  // 2-decimal currency amount, and the audit row should store the exact value
  // shown in the UI / purpose line. No-op for already-2-decimal values.
  const amount = typeof invoice.total_sum === 'number'
    ? Math.round(invoice.total_sum * 100) / 100
    : invoice.total_sum;

  // Build payload first so we can persist it BEFORE the request — that way
  // if Sber API/TLS errors out, the row in sber_payments still has the
  // request_payload for debugging.
  const payload = {
    date: today,
    externalId,
    amount,
    purpose,
    payerName: tokenRow.org_name,
    payerInn: tokenRow.payer_inn,
    payerKpp: tokenRow.payer_kpp ?? undefined,
    payerAccount: tokenRow.account_number,
    payerBankBic: tokenRow.payer_bank_bic,
    payerBankCorrAccount: tokenRow.payer_bank_corr_account,
    payeeName: supplier.name,
    payeeInn: supplier.inn,
    payeeKpp: supplier.kpp ?? undefined,
    payeeAccount: supplier.account ?? undefined,
    payeeBankBic: supplier.bank_bic,
    payeeBankCorrAccount: supplier.bank_corr_account ?? undefined,
  };

  // INSERT pending row — UNIQUE invoice_id защищает от двойного клика
  try {
    await sberPaymentRepo.create({
      invoice_id: id,
      external_id: externalId,
      status: 'pending',
      payment_purpose: purpose,
      amount,
      payer_account: tokenRow.account_number,
      payee_inn: invoice.supplier_inn,
      request_payload: JSON.stringify(redact(payload)),
    });
  } catch (err) {
    if ((err as Error).message.includes('UNIQUE') || (err as Error).message.includes('Duplicate')) {
      return res.status(409).json({ error: 'Payment already created for this invoice' });
    }
    throw err;
  }

  try {
    const result = await createPaymentOrder(accessToken, payload);
    await sberPaymentRepo.updateStatus(id, {
      status: 'created',
      sber_payment_number: result.number ?? null,
      response_body: JSON.stringify(redact(result)),
    });
    await supplierRepo.touchLastUsed(supplier.inn, supplierOwnerId);
    logger.info('[sber] payment created', { invoice_id: id, number: result.number, externalId });
    void logIntegrationEvent({
      integration: 'sber', event_type: 'payment_created', invoice_id: id,
      summary: `Платёж в Сбербанк по №${invoice.invoice_number ?? id} создан (черновик)${result.number ? `, № ${result.number}` : ''}`,
    });
    return res.json({
      success: true,
      payment_number: result.number ?? null,
      external_id: externalId,
    });
  } catch (err) {
    if (err instanceof SberApiError) {
      await sberPaymentRepo.updateStatus(id, {
        status: 'failed',
        response_body: err.body,
        error_message: `${err.status}: ${err.body.slice(0, 500)}`,
      });
      logger.error('[sber] payment failed', { invoice_id: id, status: err.status });
      void logIntegrationEvent({
        integration: 'sber', event_type: 'payment_failed', status: 'error', invoice_id: id,
        summary: `Ошибка платежа в Сбербанк по №${invoice.invoice_number ?? id}: HTTP ${err.status}`,
        detail: err.body,
      });
      return res.status(502).json({ error: 'Sber API error', sber_status: err.status, sber_body: err.body });
    }
    await sberPaymentRepo.updateStatus(id, {
      status: 'failed',
      error_message: (err as Error).message.slice(0, 500),
    });
    logger.error('[sber] payment send error', { invoice_id: id, err: (err as Error).message });
    void logIntegrationEvent({
      integration: 'sber', event_type: 'payment_failed', status: 'error', invoice_id: id,
      summary: `Ошибка платежа в Сбербанк по №${invoice.invoice_number ?? id}`,
      detail: (err as Error).message,
    });
    return res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/invoices/:id/add-pages — "дофоткать": append photographed pages to
// an existing invoice. Multipart field "files" (1..10 images). Async like
// /api/upload (OCR is slow → nginx 502s on a synchronous request): returns 202
// and processes in the background; the client polls GET /invoices/:id until the
// item count grows. Files land in processedDir (unwatched), so the watcher can
// never ingest them as separate invoices.
router.post('/:id/add-pages', addPagesUpload.array('files', 10), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: 'invalid id' }); return; }
  if (!fileWatcher) { res.status(500).json({ error: 'FileWatcher not initialized' }); return; }
  const invoice = await invoiceRepo.getById(id);
  if (!invoice) { res.status(404).json({ error: 'Invoice not found' }); return; }
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) { res.status(400).json({ error: 'No files uploaded (field "files")' }); return; }

  // Files are in processedDir (unwatched) — no watcher race, no markProcessing needed.
  const fw = fileWatcher;

  res.status(202).json({ message: 'Pages queued', count: files.length });

  void (async () => {
    for (const f of files) {
      try {
        await fw.addPageToInvoice(id, f.path, f.filename);
      } catch (err) {
        logger.error('add-pages: failed', { id, file: f.filename, error: (err as Error).message });
      }
    }
  })();
});

// POST /api/invoices/merge-suppliers?dry_run=true|false
// Groups existing supplier spellings by ≥70% similarity (guarded by ИНН — two
// different non-null ИНН are never merged), picks the most-used spelling as the
// canonical, and rewrites all invoices in each group to it. dry_run (default
// true) only reports the proposed groups without writing.
router.post('/merge-suppliers', requireAdmin, async (req: Request, res: Response) => {
  const dryRun = String(req.query.dry_run ?? 'true') !== 'false';
  const SUP_THRESHOLD = 0.70;

  const sups = await invoiceRepo.distinctSuppliers(); // most-used first
  const used = new Set<number>();
  const groups: Array<{ canonical: string; canonical_count: number; merge: Array<{ supplier: string; count: number }> }> = [];

  for (let i = 0; i < sups.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const merge: Array<{ supplier: string; count: number }> = [];
    for (let j = i + 1; j < sups.length; j++) {
      if (used.has(j)) continue;
      // ИНН guard: never merge two distinct legal entities.
      if (sups[i].supplier_inn && sups[j].supplier_inn && sups[i].supplier_inn !== sups[j].supplier_inn) continue;
      if (suppliersMatch(sups[i].supplier, sups[j].supplier, SUP_THRESHOLD)) {
        used.add(j);
        merge.push({ supplier: sups[j].supplier, count: sups[j].count });
      }
    }
    if (merge.length > 0) {
      groups.push({ canonical: sups[i].supplier, canonical_count: sups[i].count, merge });
    }
  }

  let invoicesUpdated = 0;
  if (!dryRun) {
    for (const g of groups) {
      invoicesUpdated += await invoiceRepo.renameSupplier(g.merge.map(m => m.supplier), g.canonical);
    }
  }

  logger.info('merge-suppliers', { dryRun, groups: groups.length, invoicesUpdated });
  res.json({ data: { dry_run: dryRun, groups_found: groups.length, invoices_updated: invoicesUpdated, groups } });
});

export default router;
