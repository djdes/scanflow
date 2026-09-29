import { describe, it, expect, vi, beforeEach } from 'vitest';

// Без базы: проверяем, что чистка опросов бьёт только по event_type='poll'.
const sqls: string[] = [];
vi.mock('../../src/database/db', () => ({
  getDb: () => ({
    prepare: (sql: string) => {
      sqls.push(sql.replace(/\s+/g, ' ').trim());
      return { run: async () => ({ changes: 4, lastInsertRowid: 0 }) };
    },
  }),
}));

import { integrationEventRepo } from '../../src/database/repositories/integrationEventRepo';

describe('integrationEventRepo.prunePolls (п.20)', () => {
  beforeEach(() => { sqls.length = 0; });

  it('удаляет только опросы 1С старше 3 дней по умолчанию', async () => {
    expect(await integrationEventRepo.prunePolls()).toBe(4);
    expect(sqls).toEqual([
      "DELETE FROM integration_events WHERE event_type = 'poll' AND ts < (NOW() - INTERVAL 3 DAY)",
    ]);
  });

  it('срок — целое число дней не меньше 1', async () => {
    await integrationEventRepo.prunePolls(7.9);
    await integrationEventRepo.prunePolls(0);
    expect(sqls[0]).toContain('INTERVAL 7 DAY');
    expect(sqls[1]).toContain('INTERVAL 1 DAY');
  });
});
