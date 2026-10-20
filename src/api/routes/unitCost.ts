import { Router, type Request, type Response, type NextFunction } from 'express';
import { costSuggestions, previewItemCost, decideItemCost, UnitCostError } from '../../services/itemUnitCost';

const router = Router();
router.get('/suggestions', async (req: Request, res: Response) => {
  const cursor = req.query.cursor == null ? Number.MAX_SAFE_INTEGER : Number(req.query.cursor);
  if (!Number.isSafeInteger(cursor) || cursor <= 0) { res.status(400).json({ error: 'Некорректная страница расчётов' }); return; }
  res.json(await costSuggestions(req.user!.id, cursor));
});
router.post('/invoices/:invoiceId/items/:itemId/:action', async (req: Request, res: Response, next: NextFunction) => {
  const invoiceId = Number(req.params.invoiceId), itemId = Number(req.params.itemId), action = String(req.params.action);
  if (![invoiceId, itemId].every(id => Number.isSafeInteger(id) && id > 0) || !['preview', 'remember', 'dismiss', 'forget'].includes(action)) {
    res.status(400).json({ error: 'Некорректное действие или строка накладной' }); return;
  }
  try {
    const data = action === 'preview'
      ? await previewItemCost(req.user!.id, invoiceId, itemId, req.body ?? {})
      : await decideItemCost(req.user!.id, invoiceId, itemId, action as 'remember' | 'dismiss' | 'forget', req.body ?? {});
    res.json({ data });
  } catch (error) {
    if (error instanceof UnitCostError) res.status(error.status).json({ error: error.message });
    else next(error);
  }
});
export default router;
