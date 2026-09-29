import { describe, it, expect } from 'vitest';
import { parseEngineFlags, ENGINE_FLAGS } from '../../src/services/engineFlags';

describe('parseEngineFlags', () => {
  it('без сохранённого значения все движки включены', () => {
    const f = parseEngineFlags(null);
    for (const k of ENGINE_FLAGS) expect(f[k]).toBe(true);
  });

  it('сохранённое false выключает только этот движок', () => {
    const f = parseEngineFlags('{"units_v2":false}');
    expect(f.units_v2).toBe(false);
    expect(f.mapping_v2).toBe(true);
    expect(f.price_guard).toBe(true);
  });

  it('мусор и неизвестные ключи не ломают разбор', () => {
    expect(parseEngineFlags('not json').units_v2).toBe(true);
    const f = parseEngineFlags('{"units_v2":"no","unknown":false,"learning":0}');
    expect(f.units_v2).toBe(true);   // не boolean — игнор
    expect(f.learning).toBe(true);   // 0 не boolean — игнор
    expect((f as Record<string, boolean>).unknown).toBeUndefined();
  });
});
