import { describe, it, expect, vi, beforeEach } from 'vitest';

// Сеть подменена: проверяем выбор движка, классификацию ошибок и повторы, а не OpenAI.
const h = vi.hoisted(() => ({
  codexRespond: vi.fn(),
  connection: vi.fn(),
  anthropicCtor: vi.fn(),
}));
vi.mock('../../src/chatgpt/codexClient', () => ({ codexRespond: h.codexRespond }));
vi.mock('../../src/database/repositories/chatgptConnectionRepo', () => ({ chatgptConnectionRepo: { get: h.connection } }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    constructor(opts: unknown) { h.anthropicCtor(opts); }
    messages = { stream: () => ({ finalMessage: async () => ({ content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }) }) };
  },
}));

import { aiStructured, aiText } from '../../src/ai/gateway';
import { aiTargetFromConfig, aiEngineState } from '../../src/ai/engine';
import { AiUnavailableError, isNetworkFailure, aiUnavailableText } from '../../src/ai/errors';
import { ChatgptUnavailableError } from '../../src/chatgpt/access';
import { DEFAULT_GPT_MODEL } from '../../src/ocr/gptVision';
import type { AiTarget } from '../../src/ai/types';

const GPT: AiTarget = { engine: 'gpt', model: 'gpt-6.1-sol', apiKey: null };
const CLAUDE: AiTarget = { engine: 'claude', model: 'claude-sonnet-5', apiKey: 'sk-ant-test' };
const base = { anthropic_api_key: 'sk-ant-db', claude_model: 'claude-sonnet-5', gpt_model: 'gpt-6-luna' };
const active = { status: 'active', rateLimitedUntilMs: null };

beforeEach(() => {
  vi.resetAllMocks();
  h.connection.mockResolvedValue(active);
});

describe('aiTargetFromConfig — Claude только в режиме claude_api', () => {
  it('gpt, hybrid и dispatcher → GPT с моделью из настроек', () => {
    for (const mode of ['gpt', 'hybrid', 'dispatcher', 'что-то-новое']) {
      expect(aiTargetFromConfig({ ...base, mode })).toEqual({ engine: 'gpt', model: 'gpt-6-luna', apiKey: null });
    }
  });
  it('модель GPT не задана или не GPT → модель по умолчанию', () => {
    expect(aiTargetFromConfig({ ...base, mode: 'gpt', gpt_model: null }).model).toBe(DEFAULT_GPT_MODEL);
    expect(aiTargetFromConfig({ ...base, mode: 'gpt', gpt_model: 'claude-sonnet-5' }).model).toBe(DEFAULT_GPT_MODEL);
  });
  it('claude_api → Claude с ключом из настроек', () => {
    expect(aiTargetFromConfig({ ...base, mode: 'claude_api' })).toEqual({ engine: 'claude', model: 'claude-sonnet-5', apiKey: 'sk-ant-db' });
  });
});

describe('aiStructured через GPT', () => {
  it('уходит в codexRespond со схемой и инструкциями; Claude не создаётся', async () => {
    h.codexRespond.mockResolvedValue({ text: ' {"a":1} ', model: 'gpt-6.1-sol', usage: null });
    const r = await aiStructured({
      target: GPT, label: 't', system: ['A', 'B'], content: [{ type: 'text', text: 'hi' }],
      schema: { type: 'object' }, schemaName: 'invoice', effort: 'low',
    });
    expect(r).toEqual({ text: '{"a":1}', truncated: false });
    const req = h.codexRespond.mock.calls[0][0];
    expect(req.instructions).toBe('A\n\nB');
    expect(req.schema).toEqual({ name: 'invoice', schema: { type: 'object' } });
    expect(req.effort).toBe('low');
    expect(req.content).toEqual([{ type: 'input_text', text: 'hi' }]);
    expect(h.anthropicCtor).not.toHaveBeenCalled();
  });

  it('картинка → input_image с нужной детализацией', async () => {
    h.codexRespond.mockResolvedValue({ text: '1', model: null, usage: null });
    await aiText({ target: GPT, label: 't', content: [{ type: 'image', mediaType: 'image/jpeg', data: 'AAA' }], imageDetail: 'low' });
    expect(h.codexRespond.mock.calls[0][0].content).toEqual([{ type: 'input_image', image_url: 'data:image/jpeg;base64,AAA', detail: 'low' }]);
  });

  it('лимит подписки → AiUnavailableError(rate_limited) с временем сброса, без повторов и без Claude', async () => {
    const reset = Date.now() + 3_600_000;
    h.connection.mockResolvedValue({ status: 'active', rateLimitedUntilMs: reset });
    h.codexRespond.mockRejectedValue(new ChatgptUnavailableError('Лимит подписки ChatGPT исчерпан'));
    const err = await aiText({ target: GPT, label: 't', content: 'x' }).catch(e => e);
    expect(err).toBeInstanceOf(AiUnavailableError);
    expect(err.reason).toBe('rate_limited');
    expect(err.retryAtMs).toBe(reset);
    expect(h.codexRespond).toHaveBeenCalledTimes(1);
    expect(h.anthropicCtor).not.toHaveBeenCalled();
  });

  it('нужен повторный вход → reauth_required', async () => {
    h.connection.mockResolvedValue({ status: 'reauth_required', rateLimitedUntilMs: null });
    h.codexRespond.mockRejectedValue(new ChatgptUnavailableError('нужен вход'));
    const err = await aiText({ target: GPT, label: 't', content: 'x' }).catch(e => e);
    expect(err.reason).toBe('reauth_required');
  });

  it('HTTP 429 → rate_limited сразу, без повторов', async () => {
    h.codexRespond.mockRejectedValue(Object.assign(new Error('ChatGPT 429: limit'), { status: 429 }));
    const err = await aiText({ target: GPT, label: 't', content: 'x' }).catch(e => e);
    expect(err).toBeInstanceOf(AiUnavailableError);
    expect(err.reason).toBe('rate_limited');
    expect(h.codexRespond).toHaveBeenCalledTimes(1);
  });

  it('сеть не отвечает и после повторов → AiUnavailableError(network)', async () => {
    h.codexRespond.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    const err = await aiText({ target: GPT, label: 't', content: 'x', retries: 1 }).catch(e => e);
    expect(err).toBeInstanceOf(AiUnavailableError);
    expect(err.reason).toBe('network');
    expect(h.codexRespond).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('таймаут ответа — обычная ошибка (страница, а не связь), чтобы она не ждала вечно', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    h.codexRespond.mockRejectedValue(timeout);
    const err = await aiText({ target: GPT, label: 't', content: 'x', retries: 0 }).catch(e => e);
    expect(err).toBe(timeout);
    expect(err).not.toBeInstanceOf(AiUnavailableError);
  });

  it('ошибка запроса 400 — обычная ошибка, без повторов', async () => {
    const bad = Object.assign(new Error('ChatGPT 400: bad schema'), { status: 400 });
    h.codexRespond.mockRejectedValue(bad);
    const err = await aiText({ target: GPT, label: 't', content: 'x' }).catch(e => e);
    expect(err).toBe(bad);
    expect(h.codexRespond).toHaveBeenCalledTimes(1);
  });
});

describe('Claude — только по target claude', () => {
  it('без ключа → AiUnavailableError(not_connected) про Anthropic', async () => {
    const err = await aiText({ target: { ...CLAUDE, apiKey: null }, label: 't', content: 'x' }).catch(e => e);
    expect(err).toBeInstanceOf(AiUnavailableError);
    expect(err.text).toBe('Не задан ключ Anthropic');
    expect(h.codexRespond).not.toHaveBeenCalled();
  });
  it('с ключом — Claude, GPT не вызывается', async () => {
    const r = await aiStructured({ target: CLAUDE, label: 't', content: 'x', schema: { type: 'object' }, schemaName: 's' });
    expect(r.text).toBe('{"ok":true}');
    expect(h.anthropicCtor).toHaveBeenCalledTimes(1);
    expect(h.codexRespond).not.toHaveBeenCalled();
  });
});

describe('aiEngineState и тексты', () => {
  it('подключено → available', async () => {
    expect(await aiEngineState(GPT)).toMatchObject({ available: true, reason: null, text: 'gpt-6.1-sol: подключено' });
  });
  it('нет подключения → not_connected с подсказкой', async () => {
    h.connection.mockResolvedValue(null);
    const s = await aiEngineState(GPT);
    expect(s).toMatchObject({ available: false, reason: 'not_connected' });
    expect(s.text).toContain('Войти по коду');
  });
  it('isNetworkFailure: связь — да, таймаут и 4xx — нет', () => {
    expect(isNetworkFailure(Object.assign(new Error('x'), { status: 502 }))).toBe(true);
    expect(isNetworkFailure(Object.assign(new Error('x'), { status: 407 }))).toBe(true);
    expect(isNetworkFailure(Object.assign(new Error('ChatGPT 403: похоже на блокировку по IP'), { status: 403 }))).toBe(true);
    expect(isNetworkFailure(Object.assign(new Error('x'), { status: 400 }))).toBe(false);
    expect(isNetworkFailure(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe(false);
    expect(isNetworkFailure(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).toBe(true);
  });
  it('лимит — время по Москве', () => {
    expect(aiUnavailableText('rate_limited', null)).toBe('Лимит подписки ChatGPT исчерпан');
    expect(aiUnavailableText('rate_limited', Date.now() + 60_000)).toMatch(/^Лимит подписки ChatGPT до (\d\d\.\d\d )?\d\d:\d\d МСК$/);
  });
});
