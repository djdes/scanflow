import { describe, it, expect } from 'vitest';
import { createPollLogGate, POLL_LOG_QUIET_MS } from '../../src/integration/pollLogGate';

const MIN = 60_000;

describe('журнал опроса очереди 1С (п.20)', () => {
  it('первый пустой опрос пишется, следующие пустые в течение часа — нет', () => {
    const shouldLog = createPollLogGate();
    expect(shouldLog(5, 0, 0)).toBe(true);
    expect(shouldLog(5, 0, 1 * MIN)).toBe(false);
    expect(shouldLog(5, 0, 59 * MIN)).toBe(false);
  });

  it('через час пустой опрос снова пишется', () => {
    const shouldLog = createPollLogGate();
    shouldLog(5, 0, 0);
    expect(shouldLog(5, 0, POLL_LOG_QUIET_MS)).toBe(true);
    expect(shouldLog(5, 0, POLL_LOG_QUIET_MS + MIN)).toBe(false);
  });

  it('непустой опрос пишется всегда и начинает час заново', () => {
    const shouldLog = createPollLogGate();
    shouldLog(5, 0, 0);
    expect(shouldLog(5, 3, 10 * MIN)).toBe(true);
    expect(shouldLog(5, 1, 11 * MIN)).toBe(true);
    // Пустой через 55 мин после последней записи — ещё рано.
    expect(shouldLog(5, 0, 66 * MIN)).toBe(false);
    expect(shouldLog(5, 0, 71 * MIN)).toBe(true);
  });

  it('у каждого подключения свой час', () => {
    const shouldLog = createPollLogGate();
    expect(shouldLog(5, 0, 0)).toBe(true);
    expect(shouldLog(6, 0, MIN)).toBe(true);
    expect(shouldLog(5, 0, 2 * MIN)).toBe(false);
    expect(shouldLog(6, 0, 2 * MIN)).toBe(false);
  });
});
