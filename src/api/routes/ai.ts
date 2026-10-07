import { Router, Request, Response } from 'express';
import { aiEngineState } from '../../ai/engine';
import { invoiceRepo } from '../../database/repositories/invoiceRepo';

/**
 * Состояние ИИ-движка для интерфейса (любой пользователь): чем распознаём, доступна ли
 * модель сейчас, и сколько накладных своей компании ждут её (waiting_ai). Подробностей
 * подключения (почта, токены) здесь нет — они в /api/chatgpt, только для админа.
 */
const router = Router();

router.get('/status', async (req: Request, res: Response) => {
  const [state, waiting] = await Promise.all([
    aiEngineState(),
    invoiceRepo.countWaitingAi(req.user?.id ?? null),
  ]);
  res.json({
    data: {
      engine: state.engine,
      model: state.model,
      available: state.available,
      reason: state.reason,
      text: state.text,
      retry_at: state.retryAtMs ? new Date(state.retryAtMs).toISOString() : null,
      waiting,
    },
  });
});

export default router;
