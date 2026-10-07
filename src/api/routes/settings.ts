import { Router, Request, Response } from 'express';
import { invoiceRepo } from '../../database/repositories/invoiceRepo';
import { logger } from '../../utils/logger';
import { logIntegrationEvent } from '../../integration/integrationLog';
import { requireAdmin } from '../middleware/auth';
import { getEngineFlags, setEngineFlags, ENGINE_FLAGS, ENGINE_FLAG_INFO } from '../../services/engineFlags';
import { chatgptConnectionRepo } from '../../database/repositories/chatgptConnectionRepo';
import { DEFAULT_GPT_MODEL, isGptModel } from '../../ocr/gptVision';

const router = Router();

// GET /api/settings/analyzer — get current analyzer config
router.get('/analyzer', async (req: Request, res: Response) => {
  try {
    const config = await invoiceRepo.getAnalyzerConfig();
    // Secrets (Anthropic / DaData / ProjectsFlow tokens) are returned ONLY to
    // admins. Other authenticated users get has_* flags so the UI still shows
    // mode/configured-state, but never the raw master credentials. (Open
    // self-registration means non-admins must not be able to read these.)
    const isAdmin = req.user?.role === 'admin';
    res.json({
      data: {
        mode: config.mode,
        // Менять настройки распознавания может только админ (PUT закрыт requireAdmin).
        can_edit: isAdmin,
        has_api_key: !!config.anthropic_api_key,
        anthropic_api_key: isAdmin ? config.anthropic_api_key : null,
        dadata_api_key: isAdmin ? config.dadata_api_key : null,
        has_projectsflow_token: !!config.projectsflow_token,
        projectsflow_token: isAdmin ? config.projectsflow_token : null,
        projectsflow_project_id: config.projectsflow_project_id,
        claude_model: config.claude_model,
        gpt_model: config.gpt_model || DEFAULT_GPT_MODEL,
        llm_mapper_enabled: config.llm_mapper_enabled,
        auto_send_1c: config.auto_send_1c,
        auto_send_sber: config.auto_send_sber,
        has_dadata_key: !!config.dadata_api_key,
      },
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/settings/analyzer — update analyzer config (admin only: this is the
// platform-global OCR/integration config, not per-tenant).
router.put('/analyzer', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { mode, anthropic_api_key, projectsflow_token, projectsflow_project_id, claude_model, gpt_model, llm_mapper_enabled, auto_send_1c, auto_send_sber, dadata_api_key } = req.body;
    // Only persist a non-empty key; omitting it (or sending blank) leaves the
    // stored key untouched so a routine save doesn't wipe it.
    const dadataKey = (typeof dadata_api_key === 'string' && dadata_api_key.trim()) ? dadata_api_key.trim() : undefined;

    if (!mode || !['hybrid', 'claude_api', 'gpt', 'dispatcher'].includes(mode)) {
      res.status(400).json({ error: 'Invalid mode. Must be "hybrid", "claude_api", "gpt" or "dispatcher"' });
      return;
    }
    // Имя модели уходит в запрос к ChatGPT — только «gpt-…» из безопасных символов.
    const gptModel = (typeof gpt_model === 'string' && gpt_model.trim()) ? gpt_model.trim() : undefined;
    if (gptModel !== undefined && !isGptModel(gptModel)) {
      res.status(400).json({ error: 'Модель GPT должна называться «gpt-…» (латиница, цифры, точка, дефис)' });
      return;
    }

    const llmFlag = typeof llm_mapper_enabled === 'boolean' ? llm_mapper_enabled : undefined;
    const auto1c = typeof auto_send_1c === 'boolean' ? auto_send_1c : undefined;
    const autoSber = typeof auto_send_sber === 'boolean' ? auto_send_sber : undefined;

    // Snapshot the auto-send flags BEFORE the update so we only log an integration
    // event when one actually flips (OCR mode / key / mapper changes are not
    // integration actions and are not logged).
    const beforeCfg = await invoiceRepo.getAnalyzerConfig();

    // Включить режим gpt можно только при подключённой подписке ChatGPT — иначе читать нечем.
    // Проверяется лишь при переключении: сохранение автоотправки в уже включённом режиме
    // не должно падать из-за того, что подключению нужен повторный вход.
    if (mode === 'gpt' && beforeCfg.mode !== 'gpt') {
      const chatgpt = await chatgptConnectionRepo.get();
      if (!chatgpt || chatgpt.status !== 'active') {
        res.status(400).json({ error: chatgpt
          ? 'Подключение ChatGPT требует повторного входа по коду — войдите заново и сохраните режим'
          : 'Сначала подключите ChatGPT: «Подключение ChatGPT» → «Войти по коду»' });
        return;
      }
    }

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
      await invoiceRepo.updateAnalyzerConfig(mode, undefined, claude_model, llmFlag, auto1c, autoSber, projectsflow_token, projectsflow_project_id, dadataKey, gptModel);
    } else {
      await invoiceRepo.updateAnalyzerConfig(mode, anthropic_api_key, claude_model, llmFlag, auto1c, autoSber, projectsflow_token, projectsflow_project_id, dadataKey, gptModel);
    }

    if (auto1c !== undefined && auto1c !== beforeCfg.auto_send_1c) {
      void logIntegrationEvent({ integration: '1c', event_type: 'config_changed',
        summary: `Авто-отправка в 1С ${auto1c ? 'включена' : 'выключена'}` });
    }
    if (autoSber !== undefined && autoSber !== beforeCfg.auto_send_sber) {
      void logIntegrationEvent({ integration: 'sber', event_type: 'config_changed',
        summary: `Авто-отправка в Сбербанк ${autoSber ? 'включена' : 'выключена'}` });
    }

    logger.info('Analyzer config updated', { mode, gptModel, llmMapperEnabled: llmFlag, autoSend1c: auto1c, autoSendSber: autoSber });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/settings/engine-flags — переключатели движков v2 (читать может любой:
// UI показывает состояние; менять — только админ, это платформенный конфиг).
router.get('/engine-flags', async (req: Request, res: Response) => {
  try {
    const flags = await getEngineFlags();
    res.json({
      data: ENGINE_FLAGS.map(key => ({ key, enabled: flags[key], ...ENGINE_FLAG_INFO[key] })),
      can_edit: req.user?.role === 'admin',
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/settings/engine-flags — { units_v2: false, ... } (только известные ключи).
router.put('/engine-flags', requireAdmin, async (req: Request, res: Response) => {
  try {
    const before = await getEngineFlags();
    const next = await setEngineFlags((req.body ?? {}) as Record<string, unknown>);
    const changed = ENGINE_FLAGS.filter(k => before[k] !== next[k]);
    if (changed.length) {
      logger.warn('Engine flags changed', { by: req.user?.id, changed: Object.fromEntries(changed.map(k => [k, next[k]])) });
    }
    res.json({ data: ENGINE_FLAGS.map(key => ({ key, enabled: next[key], ...ENGINE_FLAG_INFO[key] })) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
