import { Router, Request, Response } from 'express';
import { invoiceRepo } from '../../database/repositories/invoiceRepo';
import { logger } from '../../utils/logger';

const router = Router();

// GET /api/settings/analyzer — get current analyzer config
router.get('/analyzer', (_req: Request, res: Response) => {
  try {
    const config = invoiceRepo.getAnalyzerConfig();
    res.json({
      data: {
        mode: config.mode,
        has_api_key: !!config.anthropic_api_key,
        claude_model: config.claude_model,
        llm_mapper_enabled: config.llm_mapper_enabled,
      },
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/settings/analyzer — update analyzer config
router.put('/analyzer', (req: Request, res: Response) => {
  try {
    const { mode, anthropic_api_key, claude_model, llm_mapper_enabled } = req.body;

    if (!mode || !['hybrid', 'claude_api'].includes(mode)) {
      res.status(400).json({ error: 'Invalid mode. Must be "hybrid" or "claude_api"' });
      return;
    }

    const llmFlag = typeof llm_mapper_enabled === 'boolean' ? llm_mapper_enabled : undefined;

    if (mode === 'claude_api' && !anthropic_api_key) {
      const current = invoiceRepo.getAnalyzerConfig();
      if (!current.anthropic_api_key) {
        res.status(400).json({ error: 'Anthropic API key is required for Claude API mode' });
        return;
      }
      invoiceRepo.updateAnalyzerConfig(mode, undefined, claude_model, llmFlag);
    } else {
      invoiceRepo.updateAnalyzerConfig(mode, anthropic_api_key, claude_model, llmFlag);
    }

    logger.info('Analyzer config updated', { mode, llmMapperEnabled: llmFlag });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
