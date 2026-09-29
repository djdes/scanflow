import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/database/db', () => ({ getDb: vi.fn() }));
vi.mock('../../src/services/ownerAlerts', () => ({ sendOwnerAlert: vi.fn() }));

import { onecStallMessage, type CompanyHealth } from '../../src/services/companyHealth';

const company = (over: Partial<CompanyHealth> = {}): CompanyHealth => ({
  owner_user_id: 1, username: 'demo', invoices_total: 150, invoices_7d: 12, invoices_30d: 40,
  last_upload_at: '2026-09-29 09:15:10', last_sent_at: '2026-09-15 06:39:55', sent_7d: 0,
  queue_count: 70, queue_sum: 2234782, queue_with_sber_payment: 67, unmapped_lines_in_queue: 18,
  mappings: 3902, catalog_items: 723, sber_connected: true,
  ...over,
});

describe('onecStallMessage', () => {
  it('signals when new invoices arrive but nothing reaches 1C for a week', () => {
    const text = onecStallMessage(company())!;
    expect(text).toContain('В 1С уже неделю ничего не уходит');
    expect(text).toContain('15.09.2026');
    expect(text).toContain('70 на 2');
    expect(text).toContain('по 67 уже созданы платёжки');
    expect(text).toContain('#/queue');
  });

  it('stays silent when 1C is in use this week, nothing new arrived, the queue is empty or 1C was never used', () => {
    expect(onecStallMessage(company({ sent_7d: 3 }))).toBeNull();
    expect(onecStallMessage(company({ invoices_7d: 0 }))).toBeNull();
    expect(onecStallMessage(company({ queue_count: 0 }))).toBeNull();
    expect(onecStallMessage(company({ last_sent_at: null }))).toBeNull();
  });
});
