import { getDb } from '../db';

export interface IntegrationEvent {
  id: number;
  ts: string;
  integration: string;
  event_type: string;
  status: string;
  invoice_id: number | null;
  summary: string;
  detail: string | null;
}

export const integrationEventRepo = {
  async recent(opts: { integration?: string; limit?: number; offset?: number } = {}): Promise<IntegrationEvent[]> {
    // mysql2 named-placeholder pool can't bind LIMIT/OFFSET — inline after clamp
    // (same approach as invoiceRepo.getAll). `integration` is bound as a param.
    const lim = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 100)));
    const off = Math.max(0, Math.floor(opts.offset ?? 0));
    if (opts.integration) {
      return getDb()
        .prepare(`SELECT * FROM integration_events WHERE integration = ? ORDER BY ts DESC, id DESC LIMIT ${lim} OFFSET ${off}`)
        .all<IntegrationEvent>(opts.integration);
    }
    return getDb()
      .prepare(`SELECT * FROM integration_events ORDER BY ts DESC, id DESC LIMIT ${lim} OFFSET ${off}`)
      .all<IntegrationEvent>();
  },

  // Derived 1C "connection" signal: the most recent time 1C polled /pending.
  // Bounded by api_requests_log's 7-day retention — null means no poll in that window.
  async last1cPollAt(): Promise<string | null> {
    const row = await getDb()
      .prepare(`SELECT MAX(timestamp) AS t FROM api_requests_log WHERE path LIKE '/api/invoices/pending%'`)
      .get<{ t: string | null }>();
    return row?.t ?? null;
  },

  async prune(days = 90): Promise<number> {
    const d = Math.max(1, Math.floor(days));
    const r = await getDb()
      .prepare(`DELETE FROM integration_events WHERE ts < (NOW() - INTERVAL ${d} DAY)`)
      .run();
    return r.changes;
  },
};
