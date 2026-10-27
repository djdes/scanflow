import { Router } from 'express';
import { recognitionJobRepo, type RecognitionJob } from '../../database/repositories/recognitionJobRepo';
import { kickRecognitionQueue } from '../../services/recognitionQueue';
import { aiEngineState } from '../../ai/engine';
const router = Router();
// Do not expose server paths, hashes, leases or another company's uploads.
const view = (job: RecognitionJob) => ({ id: Number(job.id), original_name: job.original_name, state: job.state,
  invoice_id: job.invoice_id, attempts: job.attempts, last_error: job.last_error,
  next_attempt_at: job.next_attempt_at, created_at: job.created_at });
router.get('/', async (req, res) => {
  const ids = String(req.query.ids ?? '').split(',').map(Number).filter(id => Number.isSafeInteger(id) && id > 0).slice(0, 100);
  const [list, ai, receipts] = await Promise.all([recognitionJobRepo.list(req.user!.id), aiEngineState(), recognitionJobRepo.receipts(req.user!.id, ids)]);
  res.json({ ...list, data: list.data.map(view), receipts: receipts.map(view), ai: { available: ai.available, text: ai.text } });
});
router.get('/:id', async (req, res) => {
  const job = await recognitionJobRepo.get(Number(req.params.id), req.user!.id);
  if (!job) { res.status(404).json({ error: 'Задание не найдено' }); return; }
  res.json({ data: view(job) });
});
router.post('/:id/retry', async (req, res) => {
  const job = await recognitionJobRepo.get(Number(req.params.id), req.user!.id);
  if (!job) { res.status(404).json({ error: 'Задание не найдено' }); return; }
  if (job.state === 'processing') { res.status(409).json({ error: 'Фотография уже распознаётся' }); return; }
  await recognitionJobRepo.retry(job.id, req.user!.id);
  kickRecognitionQueue();
  res.json({ success: true });
});
export default router;
