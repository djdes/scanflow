import { describe, it, expect } from 'vitest';
import { GptStreamError, parseResponsesStream, resetFromError, toStrictSchema } from '../../src/chatgpt/responses';
import { buildCodexBody, codexHeaders } from '../../src/chatgpt/codexClient';
import { accountFromTokens, readJwtClaims } from '../../src/chatgpt/claims';
import { buildInvoiceSchema } from '../../src/ocr/claudeApiAnalyzer';

const sse = (...events: object[]) => events.map(e => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join('');
const jwt = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;

describe('toStrictSchema', () => {
  it('схема накладной: все поля обязательны, необязательные реквизиты — nullable', () => {
    const strict = toStrictSchema(buildInvoiceSchema(true)) as {
      required: string[]; properties: Record<string, { type: unknown }>; additionalProperties: boolean;
    } & { properties: { items: { items: { required: string[]; additionalProperties: boolean } } } };
    expect(strict.additionalProperties).toBe(false);
    expect(strict.required).toEqual(Object.keys(strict.properties));
    expect(strict.properties.supplier_bik.type).toEqual(['string', 'null']);
    expect(strict.properties.invoice_type.type).toBe('string');
    const item = strict.properties.items.items;
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toContain('catalog_idx');
  });
});

describe('parseResponsesStream', () => {
  it('склеивает текст из дельт и достаёт расход', () => {
    const raw = sse(
      { type: 'response.output_text.delta', delta: '{"a":' },
      { type: 'response.output_text.delta', delta: '1}' },
      { type: 'response.completed', response: { model: 'gpt-6.1-sol', usage: { input_tokens: 5854, output_tokens: 1618, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 264 } } } },
    );
    expect(parseResponsesStream(raw)).toEqual({
      text: '{"a":1}',
      model: 'gpt-6.1-sol',
      usage: { input: 5854, cached: 0, output: 1618, reasoning: 264 },
    });
  });
  it('без дельт берёт текст из готового сообщения', () => {
    const raw = sse(
      { type: 'response.output_item.done', item: { type: 'message', content: [{ type: 'output_text', text: '3' }] } },
      { type: 'response.completed', response: {} },
    );
    expect(parseResponsesStream(raw).text).toBe('3');
  });
  it('лимит подписки в потоке — ошибка с отметкой лимита и временем сброса', () => {
    const raw = sse({ type: 'error', error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', resets_at: 1800000000 } });
    try {
      parseResponsesStream(raw);
      throw new Error('не бросило');
    } catch (e) {
      expect(e).toBeInstanceOf(GptStreamError);
      expect((e as GptStreamError).rateLimited).toBe(true);
      expect((e as GptStreamError).resetsAtMs).toBe(1800000000 * 1000);
    }
  });
  it('прочая ошибка из потока — без отметки лимита', () => {
    expect(() => parseResponsesStream(sse({ type: 'response.failed', response: { error: { message: 'bad image' } } })))
      .toThrow(/bad image/);
  });
  it('оборванный ответ — ошибка, а не обрезанный JSON', () => {
    const raw = sse(
      { type: 'response.output_text.delta', delta: '{"items":[' },
      { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } },
    );
    expect(() => parseResponsesStream(raw)).toThrow(/оборван \(max_output_tokens\)/);
  });
  it('пустой ответ — ошибка', () => {
    expect(() => parseResponsesStream(sse({ type: 'response.completed', response: {} }))).toThrow(/no text/);
  });
});

describe('resetFromError', () => {
  it('resets_at — секунды эпохи, resets_in_seconds — от текущего момента', () => {
    expect(resetFromError({ resets_at: 1700000000 })).toBe(1700000000000);
    expect(resetFromError({ resets_in_seconds: 60 }, 1000)).toBe(61000);
    expect(resetFromError({})).toBeNull();
  });
});

describe('запрос к бэкенду Codex', () => {
  it('тело: инструкции, сообщение пользователя, усилие, строгая схема, store=false, поток', () => {
    const body = buildCodexBody({
      model: 'gpt-6.1-sol',
      instructions: 'Ты эксперт',
      content: [{ type: 'input_text', text: 'Прочитай' }],
      schema: { name: 'invoice', schema: { type: 'object', properties: { a: { type: 'string' } }, required: [] } },
      effort: 'medium',
    }) as Record<string, any>;
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.reasoning).toEqual({ effort: 'medium' });
    expect(body.input).toEqual([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Прочитай' }] }]);
    expect(body.text.format).toMatchObject({ type: 'json_schema', name: 'invoice', strict: true });
    expect(body.text.format.schema.required).toEqual(['a']);
  });
  it('без схемы — свободный текст', () => {
    expect(buildCodexBody({ model: 'gpt-6-luna', instructions: 'i', content: [], effort: 'low' })).not.toHaveProperty('text');
  });
  it('заголовки: токен, account id (без него бэкенд отвечает 401), originator codex', () => {
    const h = codexHeaders({ accessToken: 'AT', accountId: 'acc-1' });
    expect(h.authorization).toBe('Bearer AT');
    expect(h['chatgpt-account-id']).toBe('acc-1');
    expect(h.originator).toBe('codex_cli_rs');
    expect(h.accept).toBe('text/event-stream');
    expect(codexHeaders({ accessToken: 'AT', accountId: null })).not.toHaveProperty('chatgpt-account-id');
  });
});

describe('claims', () => {
  it('аккаунт, email, тариф и срок — из access- и id-токена', () => {
    const access = jwt({ exp: 1800000000, 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-1', chatgpt_plan_type: 'plus' } });
    const id = jwt({ email: 'owner@example.ru' });
    expect(accountFromTokens(access, id)).toEqual({
      accountId: 'acc-1', email: 'owner@example.ru', planType: 'plus', accessExpiresMs: 1800000000 * 1000,
    });
  });
  it('битый токен не роняет разбор', () => {
    expect(readJwtClaims('not-a-jwt')).toBeNull();
    expect(accountFromTokens('x.y', null)).toEqual({ accountId: null, email: null, planType: null, accessExpiresMs: null });
  });
});
