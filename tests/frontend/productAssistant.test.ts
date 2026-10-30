import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
const script = readFileSync('public/js/product-assistant.js', 'utf8');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function setup(apiJson = vi.fn()) {
  const assistant = runInNewContext(script + '\nProductAssistant;', { App: { apiJson, esc }, URLSearchParams, setTimeout, clearTimeout });
  return { assistant, apiJson };
}
const rid = '0123456789abcdef0123456789abcdef';
describe('assistant response lifecycle and rendering', () => {
  it('renders safe Markdown without executing HTML or turning model URLs into links', () => {
    const { assistant } = setup();
    const html = assistant.answerHtml('**Батон** <img src=x onerror=alert(1)> `код` [x](javascript:alert(1))');
    expect(html).toContain('<strong>Батон</strong>'); expect(html).toContain('<code>код</code>');
    expect(html).toContain('&lt;img'); expect(html).not.toContain('<img'); expect(html).not.toContain('<a');
  });
  it('polls the accepted ID, preserving scope, without following external URLs or resubmitting work', async () => {
    const api = vi.fn().mockResolvedValueOnce({ data: { status: 'running' } }).mockResolvedValueOnce({ data: { status: 'completed', result: { answer: 'готово' } } });
    const { assistant } = setup(api); const update = vi.fn();
    const result = await assistant.poll({ request_id: rid, status: 'queued', poll_url: 'https://evil.test' }, { delay: async () => {}, update, scope: { invoice_id: 7, item_id: 2 } });
    expect(result.result.answer).toBe('готово'); expect(api).toHaveBeenCalledTimes(2);
    expect(api).toHaveBeenCalledWith(`/product-assistant/requests/${rid}?invoice_id=7&item_id=2`);
    expect(update.mock.calls.map(([s]) => s.status)).toEqual(['queued', 'running', 'completed']);
  });
  it('stops polling when the dialog is disposed and surfaces terminal failures', async () => {
    const { assistant, apiJson } = setup();
    expect(await assistant.poll({ request_id: rid, status: 'queued' }, { active: () => false })).toBe(null);
    expect(apiJson).not.toHaveBeenCalled();
    await expect(assistant.poll({ request_id: rid, status: 'failed' })).rejects.toMatchObject({ terminal: true });
    await expect(assistant.poll({ request_id: 'http://evil.test', status: 'queued' })).rejects.toThrow('номер запроса');
  });
});
