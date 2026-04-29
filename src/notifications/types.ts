// All event types this module knows about. Adding a new one requires:
//   1. Add it here
//   2. Add to DEFAULT_EVENTS in migrations.ts (if it should be on by default)
//   3. Add a renderRealtime case in templates.ts
//   4. Add a renderDigest grouping in templates.ts
//   5. Emit it from somewhere
export type EventType =
  | 'photo_uploaded'
  | 'invoice_recognized'
  | 'recognition_error'
  | 'suspicious_total'
  | 'invoice_edited'
  | 'approved_for_1c'
  | 'sent_to_1c';

export const ALL_EVENT_TYPES: readonly EventType[] = [
  'photo_uploaded',
  'invoice_recognized',
  'recognition_error',
  'suspicious_total',
  'invoice_edited',
  'approved_for_1c',
  'sent_to_1c',
] as const;

// Events that bypass digest mode and always send immediately.
export const URGENT_EVENT_TYPES: ReadonlySet<EventType> = new Set([
  'recognition_error',
  'suspicious_total',
]);

export type NotifyMode = 'realtime' | 'digest_hourly' | 'digest_daily';

export const ALL_NOTIFY_MODES: readonly NotifyMode[] = [
  'realtime',
  'digest_hourly',
  'digest_daily',
] as const;

// Carried in the email body. Must be JSON-serializable (goes through DB column).
export interface EventPayload {
  invoice_id: number;
  invoice_number?: string | null;
  supplier?: string | null;
  total_sum?: number | null;
  // Free-form per-event extras (e.g. error_message for recognition_error).
  [k: string]: unknown;
}

export interface NotifyConfig {
  email: string | null;
  notify_mode: NotifyMode;
  notify_events: EventType[];
}
