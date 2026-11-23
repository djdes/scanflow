import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const queue: any = runInNewContext(`${readFileSync('public/js/recognition-queue.js', 'utf8')}\nRecognitionQueue;`, { Date });

describe('recognition queue block', () => {
  it('does not repeat files already listed under the upload card', () => {
    const state = { total: 3, data: [{ id: 1 }, { id: 2 }, { id: 3 }] };
    const history = [{ jobId: 1, status: 'server_queued' }, { jobId: 3, status: 'removed' }, { status: 'uploading' }];
    expect(queue.visibleJobs(state, history).map((j: { id: number }) => j.id)).toEqual([2, 3]);
    expect(queue.visibleJobs(state, [])).toHaveLength(3);
  });

  it('describes jobs in plain words', () => {
    expect(queue.jobView({ state: 'processing' })).toEqual({ tone: 'work', label: 'Распознаётся…' });
    expect(queue.jobView({ state: 'queued', last_error: null })).toEqual({ tone: 'wait', label: 'В очереди на распознавание', detail: '' });
    const retry = queue.jobView({ state: 'retry', next_attempt_at: 'bad', last_error: 'Лимит GPT' });
    expect(retry).toEqual({ tone: 'warn', label: 'Не распознали — повторим позже', detail: 'Лимит GPT' });
  });

  it('shows only the time for today and the date for other days', () => {
    const now = new Date('2026-11-23T18:00:00');
    expect(queue.shortTime('2026-11-23 16:03:00', now)).toBe('16:03');
    expect(queue.shortTime('2026-11-22 09:15:00', now)).toBe('22.11, 09:15');
    expect(queue.shortTime(null, now)).toBe('');
  });
});
