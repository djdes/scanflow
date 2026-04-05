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

// DELETE /api/invoices/:id — delete invoice and its items
router.delete('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const invoice = invoiceRepo.getById(id);

  if (!invoice) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }

  invoiceRepo.delete(id);
  res.json({ data: { id, deleted: true } });
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
// Side effects:
//   - Updates invoice_items.onec_guid and mapped_name
//   - Upserts nomenclature_mappings for this scan name → onec_guid (learned mapping)
//   - Records supplier usage (times_seen, last_seen_*)
//   - Invalidates mapper cache so subsequent invoices benefit immediately
router.put('/:invoiceId/items/:itemId/map', (req: Request, res: Response) => {
  const invoiceId = parseInt(req.params.invoiceId as string, 10);
  const itemId = parseInt(req.params.itemId as string, 10);
  const { onec_guid } = req.body as { onec_guid?: string | null };

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

  let resolvedName: string | null = null;
  if (onec_guid) {
    const onecRow = onecNomenclatureRepo.getByGuid(onec_guid);
    if (!onecRow) {
      res.status(400).json({ error: `onec_guid ${onec_guid} not found in onec_nomenclature` });
      return;
    }
    resolvedName = onecRow.name;
  }

  // Update the invoice item itself
  invoiceRepo.mapItem(itemId, onec_guid ?? null, resolvedName);

  // Learn: upsert nomenclature_mappings for this scan name
  const mapping = mappingRepo.upsert({
    scanned_name: item.original_name,
    mapped_name_1c: resolvedName ?? item.original_name,
    onec_guid: onec_guid ?? null,
  });
  mappingRepo.recordUsage(mapping.id, invoice.supplier ?? null);

  // Invalidate mapper cache so the next invoice benefits immediately
  if (mapper) mapper.invalidateCache();

  const updatedItem = invoiceRepo.getItemById(itemId);
  res.json({ data: updatedItem });
});

export default router;
