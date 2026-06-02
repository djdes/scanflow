import { getDb } from '../database/db';
import { logger } from '../utils/logger';

export type IntegrationName = '1c' | 'sber' | 'webhook' | 'nomenclature';

export interface IntegrationEventInput {
  integration: IntegrationName;
  event_type: string;
  status?: 'ok' | 'error' | 'info';
  invoice_id?: number | null;
  summary: string;
  detail?: unknown;
}

/**
 * Append one row to integration_events. NEVER throws — an audit-log write must
 * not break the action it records (mirrors notifications/events.ts emit()).
 *
 * summary is clamped to 512 chars and detail (JSON string) to 4000, because the
 * DB runs with STRICT_TRANS_TABLES — an over-length insert would otherwise throw
 * ER_DATA_TOO_LONG (lesson from the История-tab audit).
 */
export async function logIntegrationEvent(e: IntegrationEventInput): Promise<void> {
  try {
    const summary = String(e.summary ?? '').slice(0, 512);
    let detail: string | null = null;
    if (e.detail != null) {
      const raw = typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail);
      detail = raw.slice(0, 4000);
    }
    await getDb().prepare(
      `INSERT INTO integration_events (integration, event_type, status, invoice_id, summary, detail)
       VALUES (:integration, :event_type, :status, :invoice_id, :summary, :detail)`
    ).run({
      integration: e.integration,
      event_type: e.event_type,
      status: e.status ?? 'ok',
      invoice_id: e.invoice_id ?? null,
      summary,
      detail,
    });
  } catch (err) {
    logger.error('logIntegrationEvent failed (swallowed)', {
      error: (err as Error).message,
      event_type: e.event_type,
    });
  }
}
