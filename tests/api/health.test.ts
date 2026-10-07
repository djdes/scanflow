import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../../src/watcher/fileWatcher', () => ({ FileWatcher: class {} }));
vi.mock('../../src/mapping/nomenclatureMapper', () => ({ NomenclatureMapper: class {} }));
const h = vi.hoisted(() => ({ state: vi.fn() }));
vi.mock('../../src/ai/engine', async () => {
  const actual = await vi.importActual<typeof import('../../src/ai/engine')>('../../src/ai/engine');
  return { ...actual, aiEngineState: h.state };
});

import { createServer } from '../../src/api/server';
import { FileWatcher } from '../../src/watcher/fileWatcher';
import { NomenclatureMapper } from '../../src/mapping/nomenclatureMapper';

let app: express.Express;
beforeAll(() => {
  app = createServer(new FileWatcher() as never, new NomenclatureMapper() as never);
});

const gpt = (available: boolean) => ({
  engine: 'gpt', model: 'gpt-6.1-sol', available, reason: available ? null : 'rate_limited',
  retryAtMs: available ? null : Date.now() + 60_000, text: available ? 'подключено' : 'Лимит',
});

// Проба БД в /health сделана через require('../database/db') — в тестовой среде он
// не находится, поэтому сравниваем итог при разных состояниях GPT между собой.
describe('/health и ИИ-движок', () => {
  it('режим gpt: состояние подписки — только сведения, на итог не влияет; ключ Anthropic не нужен', async () => {
    h.state.mockResolvedValue(gpt(true));
    const ready = await request(app).get('/health');
    h.state.mockResolvedValue(gpt(false));
    const limited = await request(app).get('/health');

    expect(ready.body.checks.ai_engine).toEqual({ ok: true, detail: 'gpt: ready' });
    expect(limited.body.checks.ai_engine).toEqual({ ok: false, detail: 'gpt: rate_limited' });
    expect(limited.status).toBe(ready.status);
    expect(limited.body.status).toBe(ready.body.status);
    expect(limited.body.checks.anthropic_api_key).toBeUndefined();
  });

  it('режим claude_api без ключа — проверка ключа, degraded', async () => {
    h.state.mockResolvedValue({ engine: 'claude', model: 'claude-sonnet-5', available: false, reason: 'not_connected', retryAtMs: null, text: 'Не задан ключ Anthropic' });
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.checks.anthropic_api_key).toEqual({ ok: false, detail: 'ANTHROPIC_API_KEY not set' });
  });
});
