import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { invoiceRepo } from '../../database/repositories/invoiceRepo';
import { mappingRepo } from '../../database/repositories/mappingRepo';
import { onecNomenclatureRepo } from '../../database/repositories/onecNomenclatureRepo';
import { getDb } from '../../database/db';
import { sendToWebhook } from '../../integration/webhook';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { canonicalizeSupplierName } from '../../utils/invoiceNumber';
import { NomenclatureMapper } from '../../mapping/nomenclatureMapper';
import { resolveAndApplyPackTransform } from '../../mapping/packTransform';
import { sanitizeItemVatPerItem } from '../../parser/itemSanitizer';

let mapper: NomenclatureMapper | null = null;
export function setMapper(m: NomenclatureMapper): void {
  mapper = m;
}

const router = Router();

// GET /api/invoices/stats — dashboard statistics (must be before /:id)
router.get('/stats', (_req: Request, res: Response) => {
  const db = getDb();
  const byStatus = db.prepare('SELECT status, COUNT(*) as count FROM invoices GROUP BY status').all();
  const totalRow = db.prepare('SELECT COUNT(*) as count FROM invoices').get() as { count: number };
  res.json({ data: { byStatus, total: totalRow.count } });
});

// GET /api/invoices — list all invoices
router.get('/', (req: Request, res: Response) => {
  const status = req.query.status as string | undefined;
  const limit = parseInt(req.query.limit as string) || 100;
  const offset = parseInt(req.query.offset as string) || 0;

  const invoices = invoiceRepo.getAll(status, limit, offset);
  res.json({ data: invoices, count: invoices.length });
});

// GET /api/invoices/pending?limit=100&offset=0 — invoices ready for 1C.
// Default limit 100, hard max 500 (enforced in repo). 1C polls this; without
// paging a backlog of thousands would blow up memory + response size.
router.get('/pending', (req: Request, res: Response) => {
  const limitRaw = parseInt(req.query.limit as string, 10);
  const offsetRaw = parseInt(req.query.offset as string, 10);
  const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;
  const offset = Number.isFinite(offsetRaw) ? offsetRaw : undefined;
  const { rows, total } = invoiceRepo.getPendingWithItems({ limit, offset });
  res.json({ data: rows, count: rows.length, total, limit: limit ?? 100, offset: offset ?? 0 });
});

// GET /api/invoices/:id/photos — list photo files for an invoice
router.get('/:id/photos', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const invoice = invoiceRepo.getById(id);

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
router.get('/:id/photos/:filename', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const invoice = invoiceRepo.getById(id);

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
  const filePath = path.join(config.processedDir, safeFilename);

  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: 'File not found on disk' });
    return;
  }

  res.sendFile(filePath);
});

// GET /api/invoices/:id — single invoice with items
router.get('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const invoice = invoiceRepo.getWithItems(id);

  if (!invoice) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }

  res.json({ data: invoice });
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
  const invoice = invoiceRepo.getById(id);

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

  // Also try the legacy webhook if configured — backward compat for anyone
  // who has a webhook URL set up. If no webhook is configured, this is a no-op.
  try {
    await sendToWebhook(id);
  } catch {
    // Webhook is optional; ignore failures
  }

  // Primary flow: mark as approved so 1C picks it up on next /pending call
  invoiceRepo.approveForOneC(id);

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
router.post('/:id/confirm', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid invoice id' });
    return;
  }
  const invoice = invoiceRepo.getById(id);

  if (!invoice) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }

  if (invoice.status === 'sent_to_1c') {
    res.json({ data: { id, status: 'sent_to_1c', already_sent: true, sent_at: invoice.sent_at } });
    return;
  }

  invoiceRepo.markSent(id);
  const db = getDb();
  db.prepare('UPDATE invoices SET approved_for_1c = 0 WHERE id = ?').run(id);
  res.json({ data: { id, status: 'sent_to_1c', already_sent: false } });
});

// POST /api/invoices/:id/reset — reset from sent_to_1c back to processed.
// Also clears approved_for_1c flag so user has to explicitly re-approve
// before 1C picks it up again (avoids accidental double-imports).
router.post('/:id/reset', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const invoice = invoiceRepo.getById(id);

  if (!invoice) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }

  const db = getDb();
  db.prepare(
    "UPDATE invoices SET status = 'processed', sent_at = NULL, approved_for_1c = 0, approved_at = NULL WHERE id = ?"
  ).run(id);
  res.json({ data: { id, status: 'processed', approved_for_1c: false } });
});

// POST /api/invoices/:id/unapprove — withdraw the "Отправить в 1С" approval.
// Use when user wants to cancel the pending 1C upload before 1C has fetched it.
router.post('/:id/unapprove', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const invoice = invoiceRepo.getById(id);

  if (!invoice) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }

  invoiceRepo.unapproveForOneC(id);
  res.json({ data: { id, approved_for_1c: false } });
});

// POST /api/invoices/:id/remap — re-run nomenclature matching.
// Query param: ?all=true to also re-map items that already have a GUID.
// Useful after 1C catalog update — new items may be a better match for
// already-mapped lines.
router.post('/:id/remap', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const includeAll = req.query.all === 'true';
  const invoice = invoiceRepo.getById(id);

  if (!invoice) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }

  if (!mapper) {
    res.status(500).json({ error: 'Mapper not initialized' });
    return;
  }

  // Refresh mapper cache to pick up any new nomenclature
  mapper.invalidateCache();

  const items = invoiceRepo.getItems(id);

  // Per-item VAT sanity check against header total_sum. This runs at ingest
  // in the watcher, but until now remap didn't retry it — so invoices stored
  // with mixed pre-VAT/post-VAT rows stayed broken forever. Do it first so
  // pack-transform below sees the corrected totals.
  let vatInflated = 0;
  if (invoice.total_sum != null && invoice.total_sum > 0 && items.length > 0) {
    const vatFix = sanitizeItemVatPerItem(
      items.map(i => ({
        quantity: i.quantity, unit: i.unit, price: i.price, total: i.total,
        vat_rate: i.vat_rate,
      })),
      invoice.total_sum,
    );
    if (vatFix.report.inflated > 0) {
      logger.info('Remap: per-item VAT sanity inflated lines', vatFix.report);
      for (let k = 0; k < items.length; k++) {
        const before = items[k];
        const after = vatFix.items[k];
        if (after.total !== before.total || after.price !== before.price) {
          invoiceRepo.updateItemFields(before.id, {
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
  for (const item of items) {
    const alreadyMapped = !!item.onec_guid;
    // Skip mapping lookup for already-mapped items unless ?all=true, but still
    // run pack-transform below so a pack_size learned AFTER first ingest can
    // retroactively convert qty/unit (e.g. 7 шт ведра → 21 кг сельди).
    const shouldLookup = includeAll || !alreadyMapped;
    const result = shouldLookup ? mapper.map(item.original_name) : null;

    if (result?.onec_guid) {
      if (result.onec_guid !== item.onec_guid) changed++;
      invoiceRepo.updateItemMapping(
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
      invoiceRepo.updateItemMappingName(item.id, result.mapped_name, result.confidence);
      legacyMapped++;
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
    const mappingForPack = result ?? mapper.map(item.original_name);
    const resolved = resolveAndApplyPackTransform(
      { quantity: item.quantity, unit: item.unit, price: item.price, total: item.total },
      item.original_name,
      mappingForPack.pack_size,
      mappingForPack.pack_unit,
      mappingForPack.mapped_name,
    );
    const before = { qty: item.quantity, unit: item.unit, price: item.price };
    const after = resolved.item;
    if (
      after.quantity !== before.qty
      || after.unit !== before.unit
      || after.price !== before.price
    ) {
      invoiceRepo.updateItemFields(item.id, {
        quantity: after.quantity ?? null,
        unit: after.unit ?? null,
        price: after.price ?? null,
      });
      repacked++;
    }
  }

  // Totals may have shifted if pack-transform changed any prices (it shouldn't
  // — total is preserved — but flag mismatches regardless).
  invoiceRepo.recalculateTotal(id);

  logger.info('Re-mapped invoice items', { id, remapped, legacyMapped, changed, repacked, vatInflated, total: items.length, all: includeAll });
  res.json({ data: { id, remapped, legacyMapped, changed, repacked, vatInflated, total: items.length } });
});

// DELETE /api/invoices/:id — delete invoice, its items, and associated files
router.delete('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const invoice = invoiceRepo.getById(id);

  if (!invoice) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }

  try {
    const { file_name } = invoiceRepo.delete(id);

    // Delete associated photo files from processed/failed dirs
    if (file_name) {
      const fs = require('fs');
      const path = require('path');
      const { config } = require('../../config');
      const fileNames = file_name.split(',').map((f: string) => f.trim());
      for (const fn of fileNames) {
        for (const dir of [config.processedDir, config.failedDir, config.inboxDir]) {
          try {
            const fp = path.join(dir, fn);
            if (fs.existsSync(fp)) fs.unlinkSync(fp);
          } catch { /* ignore */ }
        }
      }
    }

    res.json({ data: { id, deleted: true } });
  } catch (err) {
    logger.error('Failed to delete invoice', { id, error: (err as Error).message });
    res.status(500).json({ error: 'Ошибка удаления накладной' });
  }
});

// POST /api/invoices/delete-batch — delete multiple invoices
router.post('/delete-batch', (req: Request, res: Response) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: 'ids array required' });
    return;
  }

  const fs = require('fs');
  const path = require('path');
  const { config } = require('../../config');
  let deleted = 0;

  for (const id of ids) {
    try {
      const { file_name } = invoiceRepo.delete(id);
      if (file_name) {
        const fileNames = file_name.split(',').map((f: string) => f.trim());
        for (const fn of fileNames) {
          for (const dir of [config.processedDir, config.failedDir, config.inboxDir]) {
            try {
              const fp = path.join(dir, fn);
              if (fs.existsSync(fp)) fs.unlinkSync(fp);
            } catch { /* ignore */ }
          }
        }
      }
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
router.post('/canonicalize-suppliers', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, supplier FROM invoices WHERE supplier IS NOT NULL AND supplier != ''`
  ).all() as Array<{ id: number; supplier: string }>;

  const update = db.prepare('UPDATE invoices SET supplier = ? WHERE id = ?');
  let updated = 0;
  const changes: Array<{ id: number; before: string; after: string }> = [];

  for (const row of rows) {
    const canonical = canonicalizeSupplierName(row.supplier);
    if (canonical && canonical !== row.supplier) {
      update.run(canonical, row.id);
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
router.post('/reprocess', async (req: Request, res: Response) => {
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
    const inv = invoiceRepo.findRecentByFileName(fileName, 10);
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
router.put('/:invoiceId/items/:itemId/map', (req: Request, res: Response) => {
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

  const invoice = invoiceRepo.getById(invoiceId);
  if (!invoice) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }
  const item = invoiceRepo.getItemById(itemId);
  if (!item || item.invoice_id !== invoiceId) {
    res.status(404).json({ error: 'Invoice item not found' });
    return;
  }

  // If setting a mapping, validate the GUID exists in the synced catalog
  let resolvedName: string | null = null;
  if (onec_guid) {
    const onecRow = onecNomenclatureRepo.getByGuid(onec_guid);
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
  const db = getDb();
  db.transaction(() => {
    invoiceRepo.mapItem(itemId, onec_guid, displayName);

    // Write transformed quantity/unit/price on the item if applicable
    if (applyPack) {
      invoiceRepo.updateItemQuantity(itemId, transformedQty, transformedUnit, transformedPrice);
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
      mappingRepo.upsert(upsertPayload);
    }
  })();

  // Invalidate mapper cache so the next fuzzy lookup rebuilds
  if (mapper) mapper.invalidateCache();

  const updatedItem = invoiceRepo.getItemById(itemId);
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
router.patch('/:invoiceId/items/:itemId', (req: Request, res: Response) => {
  const invoiceId = parseInt(req.params.invoiceId as string, 10);
  const itemId = parseInt(req.params.itemId as string, 10);
  if (!Number.isFinite(invoiceId) || !Number.isFinite(itemId)) {
    res.status(400).json({ error: 'invalid invoiceId or itemId' });
    return;
  }

  const item = invoiceRepo.getItemById(itemId);
  if (!item || item.invoice_id !== invoiceId) {
    res.status(404).json({ error: 'Invoice item not found' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
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

  const db = getDb();
  db.transaction(() => {
    invoiceRepo.updateItemFields(itemId, fields);
    // Keep the invoice total + mismatch flag in sync with the edited items.
    invoiceRepo.recalculateTotal(invoiceId);
  })();

  const updated = invoiceRepo.getItemById(itemId);
  const invoice = invoiceRepo.getById(invoiceId);
  res.json({
    data: {
      item: updated,
      invoice_total_sum: invoice?.total_sum ?? null,
      items_total_mismatch: invoice?.items_total_mismatch ?? 0,
    },
  });
});

export default router;
