import { Router, Request, Response } from 'express';
import { integrationEventRepo } from '../../database/repositories/integrationEventRepo';
import { syncStateRepo } from '../../database/repositories/syncStateRepo';

const router = Router();

// GET /api/integrations/log?integration=1c|sber|webhook|nomenclature&limit=&offset=
// Returns the recent integration activity events plus the derived "1C last polled
// at" signal (most recent /pending hit from api_requests_log).
router.get('/log', async (req: Request, res: Response) => {
  try {
    const integration = req.query.integration as string | undefined;
    const allowed = ['1c', 'sber', 'webhook', 'nomenclature'];
    const filter = integration && allowed.includes(integration) ? integration : undefined;
    const limit = parseInt(req.query.limit as string, 10);
    const offset = parseInt(req.query.offset as string, 10);
    const data = await integrationEventRepo.recent({
      integration: filter,
      limit: Number.isFinite(limit) ? limit : 100,
      offset: Number.isFinite(offset) ? offset : 0,
    });
    const onec_last_poll_at = await integrationEventRepo.last1cPollAt();
    res.json({ data, onec_last_poll_at });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/integrations/sync-flag — cheap per-minute check for the 1C scheduled
// job: is there new nomenclature waiting to be exported back to the site?
router.get('/sync-flag', async (_req: Request, res: Response) => {
  try {
    const st = await syncStateRepo.getNomenclatureSyncState();
    res.json({ data: { nomenclature_sync_requested: st.requested, since: st.since } });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/integrations/sync-flag/clear { since } — clear after a successful
// export. Race-guarded: only clears if no newer request arrived (stored <= since).
// `since` must be the exact string returned by GET /sync-flag.
router.post('/sync-flag/clear', async (req: Request, res: Response) => {
  const since = (req.body?.since ?? '') as unknown;
  if (typeof since !== 'string' || !since.trim()) {
    res.status(400).json({ error: 'since is required (the value from GET /sync-flag)' });
    return;
  }
  try {
    const r = await syncStateRepo.clearNomenclatureSync(since);
    res.json({ data: { cleared: r.cleared } });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
