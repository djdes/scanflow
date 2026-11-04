import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  analyzerConfig: {
    mode: 'dispatcher',
    anthropic_api_key: null as string | null,
    claude_model: 'claude-sonnet-5',
    gpt_model: 'gpt-6.1-sol',
    projectsflow_token: 'pfat_test_token' as string | null,
    projectsflow_project_id: '82a0e598-fce2-4948-b653-ceb64d132fe2' as string | null,
    llm_mapper_enabled: true,
    auto_send_1c: false,
    auto_send_sber: false,
    dadata_api_key: null,
  },
}));

vi.mock('../../src/database/repositories/invoiceRepo', () => ({
  invoiceRepo: {
    getAnalyzerConfig: vi.fn(async () => h.analyzerConfig),
  },
}));

vi.mock('../../src/database/repositories/chatgptConnectionRepo', () => ({
  chatgptConnectionRepo: {
    get: vi.fn(async () => null),
  },
}));

import { aiEngineState } from '../../src/ai/engine';

describe('aiEngineState in dispatcher mode', () => {
  beforeEach(() => {
    h.analyzerConfig.mode = 'dispatcher';
    h.analyzerConfig.projectsflow_token = 'pfat_test_token';
    h.analyzerConfig.projectsflow_project_id = '82a0e598-fce2-4948-b653-ceb64d132fe2';
  });

  it('reports available=true when ProjectsFlow token and projectId are configured, even without local ChatGPT session', async () => {
    const state = await aiEngineState();
    expect(state).toMatchObject({
      engine: 'gpt',
      model: 'gpt-6.1-sol',
      available: true,
      reason: null,
      text: 'Диспетчер Ralph (gpt-6.1-sol): подключено',
    });
  });

  it('reports available=false when ProjectsFlow token is missing', async () => {
    h.analyzerConfig.projectsflow_token = null;
    const state = await aiEngineState();
    expect(state.available).toBe(false);
    expect(state.reason).toBe('not_connected');
  });
});
