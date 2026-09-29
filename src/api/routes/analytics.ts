import { Router, Request, Response } from 'express';
import { parsePeriod, type AnalyticsPeriod } from '../../services/analyticsMath';
import { getSupplierQuality } from '../../services/analyticsQuality';
import { getPriceItemDetail, getPriceOverview } from '../../services/analyticsPrices';

/**
 * /api/analytics — страница «Аналитика». Монтируется за apiKeyAuth.
 *
 *   GET /suppliers?days=90      качество накладных по поставщикам (п.7)
 *   GET /prices?days=90         закупочные цены по позициям 1С (п.11)
 *   GET /prices/:guid?days=90   одна позиция: закупки для графика, поставщики,
 *                               «у кого дешевле»
 *
 * days — 30, 90, 180 или 365 (по умолчанию 90). Только чтение, и только данные
 * компании вызывающего: owner = req.user.id во всех запросах (правило 19 —
 * роль admin чужие накладные не открывает).
 */
const router = Router();

// GUID приходит из выгрузки 1С (обычно 36 символов). В SQL он идёт параметром;
// здесь — только отсечь заведомый мусор.
const GUID_RE = /^[^\s\u0000-\u001f]{1,64}$/;

function ownerOf(req: Request, res: Response): number | null {
  const id = req.user?.id;
  if (id == null) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  return id;
}

function periodOf(req: Request, res: Response): AnalyticsPeriod | null {
  const days = parsePeriod(req.query.days);
  if (days == null) res.status(400).json({ error: 'Период: 30, 90, 180 или 365 дней' });
  return days;
}

// GET /api/analytics/suppliers
router.get('/suppliers', async (req: Request, res: Response) => {
  const owner = ownerOf(req, res);
  if (owner == null) return;
  const days = periodOf(req, res);
  if (days == null) return;
  res.json({ data: await getSupplierQuality(owner, days) });
});

// GET /api/analytics/prices
router.get('/prices', async (req: Request, res: Response) => {
  const owner = ownerOf(req, res);
  if (owner == null) return;
  const days = periodOf(req, res);
  if (days == null) return;
  res.json({ data: await getPriceOverview(owner, days) });
});

// GET /api/analytics/prices/:guid
router.get('/prices/:guid', async (req: Request, res: Response) => {
  const owner = ownerOf(req, res);
  if (owner == null) return;
  const guid = String(req.params.guid ?? '');
  if (!GUID_RE.test(guid)) return res.status(400).json({ error: 'Некорректный идентификатор позиции' });
  const days = periodOf(req, res);
  if (days == null) return;
  const detail = await getPriceItemDetail(owner, guid, days);
  if (!detail) return res.status(404).json({ error: 'За этот период закупок этой позиции нет' });
  res.json({ data: detail });
});

export default router;
