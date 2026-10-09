import { describe, it, expect, vi, beforeEach } from 'vitest';

// Без базы: проверяем, что чистка опросов бьёт только по event_type='poll'.
const sqls: string[] = [];
const params: unknown[][] = [];
vi.mock('../../src/database/db', () => ({
  getDb: () => ({
    prepare: (sql: string) => {
      sqls.push(sql.replace(/\s+/g, ' ').trim());
      return {
        run: async () => ({ changes: 4, lastInsertRowid: 0 }),
        all: async (...p: unknown[]) => { params.push(p); return []; },
      };
    },
  }),
}));

import { integrationEventRepo } from '../../src/database/repositories/integrationEventRepo';

describe('integrationEventRepo.recent — журнал своей компании', () => {
  beforeEach(() => { sqls.length = 0; params.length = 0; });

  it('пользователь — только события своей компании, фильтры параметрами', async () => {
    await integrationEventRepo.recent({ integration: '1c', ownerUserId: 3, limit: 50 });
    expect(sqls[0]).toBe('SELECT * FROM integration_events WHERE integration = ? AND owner_user_id = ? ORDER BY ts DESC, id DESC LIMIT 50 OFFSET 0');
    expect(params[0]).toEqual(['1c', 3]);
  });

  it('админ без фильтра — вся платформа', async () => {
    await integrationEventRepo.recent({});
    expect(sqls[0]).toBe('SELECT * FROM integration_events ORDER BY ts DESC, id DESC LIMIT 100 OFFSET 0');
    expect(params[0]).toEqual([]);
  });
});

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
