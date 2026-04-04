import { Router, Request, Response } from 'express';
import { invoiceRepo } from '../../database/repositories/invoiceRepo';
import { getDb } from '../../database/db';
import { sendToWebhook } from '../../integration/webhook';

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

export default router;
