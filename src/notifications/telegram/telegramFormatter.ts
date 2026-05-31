import type { Invoice } from '../../database/repositories/invoiceRepo';
import type { EventPayload } from '../types';

// Per-event timestamp. Built from invoice fields directly (no separate event log
// is maintained; the invoice itself is the source of truth for state).
export interface EventState {
  photo_uploaded: Date | null;
  invoice_recognized: Date | null;
  approved_for_1c: Date | null;
  sent_to_1c: Date | null;
}

// Maps the current invoice state to which thread events have happened.
// approved_for_1c: presence of approved_at field.
// invoice_recognized: status='processed' or beyond.
// sent_to_1c: presence of sent_at.
// photo_uploaded: always true once the invoice exists; uses created_at.
export function deriveEventState(invoice: Invoice): EventState {
  const created = invoice.created_at ? new Date(invoice.created_at + 'Z') : null;
  // We don't have a precise timestamp for "recognized" in the schema; use the
  // invoice's created_at as a proxy when the invoice has progressed past parsing.
  // For better timestamps we'd need a separate column. Good enough.
  const recognized =
    invoice.status === 'processed' ||
    invoice.status === 'sent_to_1c' ||
    invoice.approved_for_1c === 1
      ? created
      : null;
  const approved = invoice.approved_at ? new Date(invoice.approved_at + 'Z') : null;
  const sent = invoice.sent_at ? new Date(invoice.sent_at + 'Z') : null;

  return {
    photo_uploaded: created,
    invoice_recognized: recognized,
    approved_for_1c: approved,
    sent_to_1c: sent,
  };
}

function fmtMoney(n: number | null | undefined): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n) + ' ₽';
}

function fmtTime(d: Date | null): string {
  if (!d) return '';
  // Local Moscow time in HH:mm format — concise for thread display.
  const fmt = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit',
  });
  return fmt.format(d);
}

const STEP_LABELS: Record<keyof EventState, string> = {
  photo_uploaded: 'Загружена',
  invoice_recognized: 'Распознана',
  approved_for_1c: 'Утверждена',
  sent_to_1c: 'Отправлена в 1С',
};

const STEP_ORDER: Array<keyof EventState> = [
  'photo_uploaded',
  'invoice_recognized',
  'approved_for_1c',
  'sent_to_1c',
];

// Builds the full thread message text reflecting all done/pending steps.
// Plain text (no parse_mode) so we don't have to escape special chars in
// supplier names. Telegram ignores most chars in plain text.
export function buildInvoiceThread(invoice: Invoice, state: EventState): string {
  const num = invoice.invoice_number || `#${invoice.id}`;
  const supplier = invoice.supplier || '—';
  const sum = fmtMoney(invoice.total_sum);

  const lines: string[] = [
    `📄 Накладная № ${num}`,
    `Поставщик: ${supplier}`,
    `Сумма: ${sum}`,
    '',
  ];

  for (const step of STEP_ORDER) {
    const ts = state[step];
    if (ts) {
      lines.push(`✅ ${STEP_LABELS[step]} ${fmtTime(ts)}`);
    } else {
      lines.push(`⏳ ${STEP_LABELS[step]}`);
    }
  }

  return lines.join('\n');
}

// Builds the standalone urgent message body. Not part of the invoice thread.
export interface ElevatedItem {
  name: string;
  unit: string | null;
  price: number;
  median_price: number;
  deviation_pct: number;
}

export function buildUrgentMessage(
  eventType: 'recognition_error' | 'suspicious_total' | 'elevated_prices',
  payload: EventPayload,
): string {
  const num = payload.invoice_number ? String(payload.invoice_number) : `#${payload.invoice_id}`;
  const supplier = payload.supplier ? String(payload.supplier) : '—';
  const sum = fmtMoney(payload.total_sum as number | null | undefined);

  if (eventType === 'recognition_error') {
    const err = payload.error_message ? String(payload.error_message) : 'без описания';
    return [
      `🚨 Ошибка распознавания`,
      `Накладная: ${num}`,
      `Поставщик: ${supplier}`,
      ``,
      `Причина: ${err}`,
    ].join('\n');
  }

  if (eventType === 'elevated_prices') {
    const items = Array.isArray(payload.elevated_items) ? (payload.elevated_items as ElevatedItem[]) : [];
    const lines: string[] = [
      `⚠️ Повышенные цены в накладной`,
      `Накладная: ${num}`,
      `Поставщик: ${supplier}`,
      ``,
      `Найдено ${items.length} ${pluralRu(items.length, 'позиция', 'позиции', 'позиций')} дороже обычного:`,
    ];
    // Sort by deviation desc, cap at 15 to keep the message within reason.
    const sorted = [...items].sort((a, b) => b.deviation_pct - a.deviation_pct);
    const shown = sorted.slice(0, 15);
    for (const it of shown) {
      const unit = it.unit ? `/${it.unit}` : '';
      const dev = Math.round(it.deviation_pct);
      lines.push(`• ${it.name} — ${fmtMoney(it.price)}${unit} (обычно ${fmtMoney(it.median_price)}, +${dev}%)`);
    }
    if (sorted.length > shown.length) {
      lines.push(`… и ещё ${sorted.length - shown.length}`);
    }
    lines.push('', 'Откройте накладную в дашборде, чтобы проверить.');
    return lines.join('\n');
  }

  // suspicious_total
  const itemsTotal = payload.items_total != null ? fmtMoney(payload.items_total as number) : null;
  const lines = [
    `⚠️ Подозрительная сумма`,
    `Накладная: ${num}`,
    `Поставщик: ${supplier}`,
    `Сумма по документу: ${sum}`,
  ];
  if (itemsTotal) lines.push(`Сумма строк: ${itemsTotal}`);
  lines.push('', 'Проверьте документ в дашборде.');
  return lines.join('\n');
}

function pluralRu(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}
