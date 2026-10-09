import { describe, it, expect, vi, beforeEach } from 'vitest';

// Без базы: событие журнала получает компанию — явную или владельца накладной.
const inserted: Array<Record<string, unknown>> = [];
const owners = new Map<number, number | null>([[787, 3], [42, null]]);
vi.mock('../../src/database/db', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      get: async (id: number) => (sql.includes('FROM invoices') && owners.has(id) ? { owner_user_id: owners.get(id) } : undefined),
      run: async (row: Record<string, unknown>) => { inserted.push(row); return { changes: 1, lastInsertRowid: 1 }; },
    }),
  }),
}));

import { logIntegrationEvent } from '../../src/integration/integrationLog';

describe('logIntegrationEvent — компания события (миграция 84)', () => {
  beforeEach(() => { inserted.length = 0; });

  it('событие накладной — компания владельца накладной', async () => {
    await logIntegrationEvent({ integration: '1c', event_type: 'document_posted', invoice_id: 787, summary: 'ок' });
    expect(inserted[0]).toMatchObject({ invoice_id: 787, owner_user_id: 3 });
  });

  it('явная компания (опрос подключения 1С) важнее и без накладной', async () => {
    await logIntegrationEvent({ integration: '1c', event_type: 'poll', owner_user_id: 3, summary: 'очередь: 0' });
    expect(inserted[0]).toMatchObject({ invoice_id: null, owner_user_id: 3 });
  });

  it('нет ни компании, ни накладной — NULL (видит только админ)', async () => {
    await logIntegrationEvent({ integration: 'sber', event_type: 'token_refreshed', summary: 'ок' });
    await logIntegrationEvent({ integration: '1c', event_type: 'approved', invoice_id: 42, summary: 'ок' });
    expect(inserted.map(r => r.owner_user_id)).toEqual([null, null]);
  });
});
