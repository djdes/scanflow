import { Router, Request, Response } from 'express';
import { invoiceRepo } from '../../database/repositories/invoiceRepo';
import { logger } from '../../utils/logger';

const router = Router();

// GET /api/settings/analyzer — get current analyzer config
router.get('/analyzer', async (_req: Request, res: Response) => {
  try {
    const config = await invoiceRepo.getAnalyzerConfig();
    res.json({
      data: {
        mode: config.mode,
        has_api_key: !!config.anthropic_api_key,
        has_projectsflow_token: !!config.projectsflow_token,
        projectsflow_project_id: config.projectsflow_project_id,
        claude_model: config.claude_model,
        llm_mapper_enabled: config.llm_mapper_enabled,
        auto_send_1c: config.auto_send_1c,
        auto_send_sber: config.auto_send_sber,
      },
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/settings/analyzer — update analyzer config
router.put('/analyzer', async (req: Request, res: Response) => {
  try {
    const { mode, anthropic_api_key, projectsflow_token, projectsflow_project_id, claude_model, llm_mapper_enabled, auto_send_1c, auto_send_sber } = req.body;

    if (!mode || !['hybrid', 'claude_api', 'dispatcher'].includes(mode)) {
      res.status(400).json({ error: 'Invalid mode. Must be "hybrid", "claude_api" or "dispatcher"' });
      return;
    }

    const llmFlag = typeof llm_mapper_enabled === 'boolean' ? llm_mapper_enabled : undefined;
    const auto1c = typeof auto_send_1c === 'boolean' ? auto_send_1c : undefined;
    const autoSber = typeof auto_send_sber === 'boolean' ? auto_send_sber : undefined;

    // Validate dispatcher mode prerequisites (token + project_id) — present
    // either in this request or already in DB.
    if (mode === 'dispatcher') {
      const current = await invoiceRepo.getAnalyzerConfig();
      if (!projectsflow_token && !current.projectsflow_token) {
        res.status(400).json({ error: 'ProjectsFlow agent token (pfat_*) is required for Dispatcher mode' });
        return;
      }
      if (!projectsflow_project_id && !current.projectsflow_project_id) {
        res.status(400).json({ error: 'ProjectsFlow project ID is required for Dispatcher mode' });
        return;
      }
    }

    if (mode === 'claude_api' && !anthropic_api_key) {
      const current = await invoiceRepo.getAnalyzerConfig();
      if (!current.anthropic_api_key) {
        res.status(400).json({ error: 'Anthropic API key is required for Claude API mode' });
        return;
      }
      await invoiceRepo.updateAnalyzerConfig(mode, undefined, claude_model, llmFlag, auto1c, autoSber, projectsflow_token, projectsflow_project_id);
    } else {
      await invoiceRepo.updateAnalyzerConfig(mode, anthropic_api_key, claude_model, llmFlag, auto1c, autoSber, projectsflow_token, projectsflow_project_id);
    }

    logger.info('Analyzer config updated', { mode, llmMapperEnabled: llmFlag, autoSend1c: auto1c, autoSendSber: autoSber });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
