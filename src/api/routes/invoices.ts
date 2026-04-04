import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { invoiceRepo } from '../../database/repositories/invoiceRepo';
import { getDb } from '../../database/db';
import { sendToWebhook } from '../../integration/webhook';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { canonicalizeSupplierName } from '../../utils/invoiceNumber';

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

// POST /api/invoices/:id/send — manually send to 1C webhook
router.post('/:id/send', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const invoice = invoiceRepo.getById(id);

  if (!invoice) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }

  if (invoice.status !== 'processed') {
    res.status(400).json({ error: `Invoice must be in "processed" status, current: "${invoice.status}"` });
    return;
  }

  const success = await sendToWebhook(id);
  if (success) {
    res.json({ message: 'Sent to 1C', status: 'sent_to_1c' });
  } else {
    res.status(500).json({ error: 'Failed to send to 1C webhook. Check webhook configuration.' });
  }
});

// POST /api/invoices/:id/confirm — confirm sent to 1C
router.post('/:id/confirm', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const invoice = invoiceRepo.getById(id);

  if (!invoice) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }

  invoiceRepo.markSent(id);
  res.json({ data: { id, status: 'sent_to_1c' } });
});

// POST /api/invoices/:id/reset — reset from sent_to_1c back to processed.
// Used when a 1C import needs to be retried (e.g. user deleted the document
// in 1C and wants to re-pull it via the external processing).
router.post('/:id/reset', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const invoice = invoiceRepo.getById(id);

  if (!invoice) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }

  const db = getDb();
  db.prepare("UPDATE invoices SET status = 'processed', sent_at = NULL WHERE id = ?").run(id);
  res.json({ data: { id, status: 'processed' } });
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

// POST /api/invoices/bulk-delete-except-latest — admin cleanup.
// Deletes ALL invoices (and their items) except the latest N by created_at.
// Body: { keep: number }
// Returns count of deleted rows. Intended for one-off cleanup before the
// first real 1C import run — removes old test/garbage data so the 1C
// /pending list isn't polluted with hundreds of obsolete records.
router.post('/bulk-delete-except-latest', (req: Request, res: Response) => {
  const { keep } = req.body as { keep?: unknown };
  if (typeof keep !== 'number' || keep < 0 || !Number.isInteger(keep)) {
    res.status(400).json({ error: 'keep must be a non-negative integer' });
    return;
  }

  const db = getDb();
  // Collect IDs to KEEP (top N by created_at DESC)
  const keepRows = db.prepare(
    `SELECT id FROM invoices ORDER BY created_at DESC LIMIT ?`
  ).all(keep) as Array<{ id: number }>;
  const keepIds = new Set(keepRows.map(r => r.id));

  // Find IDs to delete
  const allRows = db.prepare('SELECT id FROM invoices').all() as Array<{ id: number }>;
  const toDelete = allRows.map(r => r.id).filter(id => !keepIds.has(id));

  const delItems = db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?');
  const delInvoice = db.prepare('DELETE FROM invoices WHERE id = ?');

  const tx = db.transaction((ids: number[]) => {
    for (const id of ids) {
      delItems.run(id);
      delInvoice.run(id);
    }
  });
  tx(toDelete);

  logger.info('Bulk delete complete', { kept: keepIds.size, deleted: toDelete.length });
  res.json({ data: { kept: keepIds.size, deleted: toDelete.length } });
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

export default router;
