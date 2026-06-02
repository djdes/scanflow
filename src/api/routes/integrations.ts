import { Router, Request, Response } from 'express';
import { integrationEventRepo } from '../../database/repositories/integrationEventRepo';

const router = Router();

// GET /api/integrations/log?integration=1c|sber|webhook|nomenclature&limit=&offset=
// Returns the recent integration activity events plus the derived "1C last polled
// at" signal (most recent /pending hit from api_requests_log).
router.get('/log', async (req: Request, res: Response) => {
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
});

export default router;
