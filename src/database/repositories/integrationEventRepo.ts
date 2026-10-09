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
  /** Из накладной события (LEFT JOIN) — чтобы журнал говорил «накладная №…», а не id. */
  invoice_number?: string | null;
  invoice_date?: string | null;
  supplier?: string | null;
  total_sum?: number | null;
}

export const integrationEventRepo = {
  /**
   * ownerUserId задан — только события этой компании (миграция 84); нет — все (админ).
   * withoutPolls — без опросов очереди 1С: их сотни, а «1С на связи» и так видно.
   */
  async recent(opts: { integration?: string; limit?: number; offset?: number; ownerUserId?: number; withoutPolls?: boolean } = {}): Promise<IntegrationEvent[]> {
    // mysql2 named-placeholder pool can't bind LIMIT/OFFSET — inline after clamp
    // (same approach as invoiceRepo.getAll). Filters are bound as params.
    const lim = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 100)));
    const off = Math.max(0, Math.floor(opts.offset ?? 0));
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.integration) { where.push('e.integration = ?'); params.push(opts.integration); }
    if (opts.ownerUserId != null) { where.push('e.owner_user_id = ?'); params.push(opts.ownerUserId); }
    if (opts.withoutPolls) where.push("e.event_type <> 'poll'");
    return getDb()
      .prepare(`SELECT e.*, i.invoice_number, i.invoice_date, i.supplier, i.total_sum
         FROM integration_events e LEFT JOIN invoices i ON i.id = e.invoice_id${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
         ORDER BY e.ts DESC, e.id DESC LIMIT ${lim} OFFSET ${off}`)
      .all<IntegrationEvent>(...params);
  },

  // Derived 1C "connection" signal: the most recent time 1C polled /pending.
  // Bounded by api_requests_log's 7-day retention — null means no poll in that window.
  async last1cPollAt(): Promise<string | null> {
    const row = await getDb()
      .prepare(`SELECT MAX(timestamp) AS t FROM api_requests_log WHERE path LIKE '/api/invoices/pending%'`)
      .get<{ t: string | null }>();
    return row?.t ?? null;
  },

  // То же для компании: база 1С ходит через /api/onec/exchange по токену
  // подключения, и каждый её запрос обновляет onec_connections.last_used_at.
  async last1cPollAtForOwner(ownerUserId: number): Promise<string | null> {
    const row = await getDb()
      .prepare('SELECT MAX(last_used_at) AS t FROM onec_connections WHERE owner_user_id = ? AND active = 1')
      .get<{ t: string | null }>(ownerUserId);
    return row?.t ?? null;
  },

  async prune(days = 90): Promise<number> {
    const d = Math.max(1, Math.floor(days));
    const r = await getDb()
      .prepare(`DELETE FROM integration_events WHERE ts < (NOW() - INTERVAL ${d} DAY)`)
      .run();
    return r.changes;
  },

  // Опросы очереди 1С (event_type='poll') — самые частые и самые бесполезные
  // в истории строки; им хватает нескольких дней, остальному журналу — 90.
  async prunePolls(days = 3): Promise<number> {
    const d = Math.max(1, Math.floor(days));
    const r = await getDb()
      .prepare(`DELETE FROM integration_events WHERE event_type = 'poll' AND ts < (NOW() - INTERVAL ${d} DAY)`)
      .run();
    return r.changes;
  },
};
