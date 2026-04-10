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

// GET /api/invoices/pending — invoices ready for 1C
router.get('/pending', (_req: Request, res: Response) => {
  const invoices = invoiceRepo.getPending();
  const result = invoices.map(inv => invoiceRepo.getWithItems(inv.id));
  res.json({ data: result, count: result.length });
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

// GET /api/invoices/:id/photos/:filename — serve photo file
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
router.post('/:id/confirm', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const invoice = invoiceRepo.getById(id);

  if (!invoice) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }

  invoiceRepo.markSent(id);
  const db = getDb();
  db.prepare('UPDATE invoices SET approved_for_1c = 0 WHERE id = ?').run(id);
  res.json({ data: { id, status: 'sent_to_1c' } });
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

// POST /api/invoices/:id/remap — re-run nomenclature matching for unmapped items.
// Used after 1C catalog is updated — items that had no match before may now
// find a counterpart in the refreshed onec_nomenclature table.
router.post('/:id/remap', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
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
  let remapped = 0;
  for (const item of items) {
    // Only re-map items that don't have a GUID yet (avoid overwriting confirmed ones)
    if (item.onec_guid) continue;

    const result = mapper.map(item.original_name);
    if (result.onec_guid) {
      invoiceRepo.mapItem(item.id, result.onec_guid, result.mapped_name);
      remapped++;
    }
  }

  logger.info('Re-mapped invoice items', { id, remapped, total: items.length });
  res.json({ data: { id, remapped, total: items.length } });
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
  const rawGuid = (req.body as { onec_guid?: string | null } | undefined)?.onec_guid;
  const onec_guid: string | null =
    typeof rawGuid === 'string' && rawGuid.trim() !== '' ? rawGuid.trim() : null;

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

  // All mutations in one transaction
  const db = getDb();
  db.transaction(() => {
    invoiceRepo.mapItem(itemId, onec_guid, displayName);

    // Learning loop: only touch the global nomenclature_mappings when SETTING.
    // Clearing a single invoice item's mapping must not corrupt a learned mapping
    // that other invoices may still rely on.
    if (onec_guid) {
      const mapping = mappingRepo.upsert({
        scanned_name: item.original_name,
        mapped_name_1c: resolvedName as string,
        onec_guid,
      });
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

export default router;
