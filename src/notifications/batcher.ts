import type { EventType } from './types';

/**
 * Пакетный режим уведомлений (п.19 пакета v2, флаг движка batch_notify).
 *
 * Пачка из ~20 фото давала на каждую накладную photo_uploaded +
 * invoice_recognized + elevated_prices + suspicious_total. Часовой лимит
 * (NOTIFY_HOURLY_CAP = 30) срабатывал посреди пачки, и всё, что шло после,
 * глушилось — включая ошибки распознавания (логи прода 14.09 и 29.09).
 *
 * Правило: ≥3 photo_uploaded за 2 минуты у одного получателя → пакетный режим.
 * В нём события пачки не уходят поштучно, а копятся; когда 90 секунд не
 * приходит ни одного нового, уходит ОДНА сводка — одна отправка для лимита.
 * Вне пакетного режима всё по-старому.
 *
 * Здесь только чистая логика: время передаётся параметром, ни таймеров, ни
 * I/O. Таймеры и отправка сводки — в events.ts.
 */

export const BATCH_UPLOAD_THRESHOLD = 3;
export const BATCH_DETECT_WINDOW_MS = 2 * 60_000;
export const BATCH_QUIET_MS = 90_000;
/** Сколько накладных сводка перечисляет ссылками. */
export const BATCH_SUMMARY_MAX_LINKS = 15;
/** Сколько номеров накладных с ошибкой назвать прямо в первой строке. */
const HEADLINE_MAX_ERRORS = 5;

/** События, которые в пакетном режиме копятся в сводку. Остальные идут как обычно. */
export const BATCHABLE_EVENTS: ReadonlySet<EventType> = new Set<EventType>([
  'photo_uploaded',
  'invoice_recognized',
  'elevated_prices',
  'suspicious_total',
  'recognition_error',
]);

export interface BatchEvent {
  type: EventType;
  invoiceId: number;
  invoiceNumber?: string | null;
  supplier?: string | null;
  /**
   * false — этот тип выключен у получателя в настройках. Такое событие (на
   * деле — photo_uploaded) учитывается для распознавания пачки и в счётчике
   * «Загружено N фото», но само по себе сводку не вызывает.
   */
  deliver?: boolean;
}

/**
 * 'send'   — отправить как обычно (не пакетный тип или пакетного режима нет);
 * 'start'  — это событие включило пакетный режим и отложено в сводку;
 * 'buffer' — пакетный режим уже идёт, событие отложено в сводку.
 */
export type BatchDecision = 'send' | 'start' | 'buffer';

export interface BatchSnapshot {
  recipient: number;
  startedAt: number;
  lastEventAt: number;
  /** Загрузки, ушедшие поштучно до включения режима: входят в счётчик «Загружено». */
  earlyUploads: BatchEvent[];
  events: BatchEvent[];
}

export interface BatcherOptions {
  threshold: number;
  windowMs: number;
  quietMs: number;
}

interface RecipientState {
  /** Недавние загрузки вне пакетного режима — для распознавания пачки. */
  uploads: Array<{ ev: BatchEvent; at: number }>;
  batch: Omit<BatchSnapshot, 'recipient'> | null;
}

export class NotificationBatcher {
  private readonly recipients = new Map<number, RecipientState>();
  private readonly opts: BatcherOptions;

  constructor(opts: Partial<BatcherOptions> = {}) {
    this.opts = {
      threshold: opts.threshold ?? BATCH_UPLOAD_THRESHOLD,
      windowMs: opts.windowMs ?? BATCH_DETECT_WINDOW_MS,
      quietMs: opts.quietMs ?? BATCH_QUIET_MS,
    };
  }

  offer(recipient: number, ev: BatchEvent, now: number): BatchDecision {
    if (!BATCHABLE_EVENTS.has(ev.type)) return 'send';
    const st = this.recipients.get(recipient);
    if (st?.batch) {
      st.batch.events.push(ev);
      st.batch.lastEventAt = now;
      return 'buffer';
    }
    if (ev.type !== 'photo_uploaded') return 'send';

    const uploads = (st?.uploads ?? []).filter(u => now - u.at <= this.opts.windowMs);
    uploads.push({ ev, at: now });
    if (uploads.length >= this.opts.threshold) {
      this.recipients.set(recipient, {
        uploads: [],
        batch: {
          startedAt: now,
          lastEventAt: now,
          earlyUploads: uploads.slice(0, -1).map(u => u.ev),
          events: [ev],
        },
      });
      return 'start';
    }
    this.recipients.set(recipient, { uploads, batch: null });
    return 'send';
  }

  isBatching(recipient: number): boolean {
    return this.recipients.get(recipient)?.batch != null;
  }

  /** Момент, когда у получателя истечёт тишина (для таймера); null — пакета нет. */
  quietDeadline(recipient: number): number | null {
    const b = this.recipients.get(recipient)?.batch;
    return b ? b.lastEventAt + this.opts.quietMs : null;
  }

  /** Тишина ≥ quietMs — забрать накопленное и выйти из пакетного режима; иначе null. */
  takeIfQuiet(recipient: number, now: number): BatchSnapshot | null {
    const b = this.recipients.get(recipient)?.batch;
    if (!b || now - b.lastEventAt < this.opts.quietMs) return null;
    this.recipients.delete(recipient);
    return { recipient, ...b };
  }
}

export type BatchFlag = 'error' | 'suspicious' | 'elevated';

export interface BatchInvoice {
  id: number;
  number: string | null;
  supplier: string | null;
  flags: BatchFlag[];
}

export interface BatchSummary {
  /** Накладных с загруженным фото (включая ушедшие поштучно до пачки). */
  uploaded: number;
  /** Последнее итоговое событие — «распознана». */
  recognized: number;
  /** Последнее итоговое событие — ошибка распознавания. */
  errors: BatchInvoice[];
  suspicious: number;
  elevated: number;
  /** Все накладные пачки: сначала с ошибкой, затем с подозрительной суммой, с ценами, остальные. */
  invoices: BatchInvoice[];
  /** Есть хоть одно событие, которое получатель хочет получать. Нет — сводку не шлём. */
  deliverable: boolean;
}

const FLAG_ORDER: BatchFlag[] = ['error', 'suspicious', 'elevated'];

export function summarizeBatch(snap: Pick<BatchSnapshot, 'earlyUploads' | 'events'>): BatchSummary {
  interface Acc extends BatchInvoice { order: number; uploaded: boolean; final: 'recognized' | 'error' | null }
  const byId = new Map<number, Acc>();
  const touch = (ev: BatchEvent): Acc => {
    let acc = byId.get(ev.invoiceId);
    if (!acc) {
      acc = { id: ev.invoiceId, number: null, supplier: null, flags: [], order: byId.size, uploaded: false, final: null };
      byId.set(ev.invoiceId, acc);
    }
    if (ev.invoiceNumber) acc.number = String(ev.invoiceNumber);
    if (ev.supplier) acc.supplier = String(ev.supplier);
    return acc;
  };
  const flag = (acc: Acc, f: BatchFlag): void => { if (!acc.flags.includes(f)) acc.flags.push(f); };

  for (const ev of snap.earlyUploads) touch(ev).uploaded = true;
  for (const ev of snap.events) {
    const acc = touch(ev);
    if (ev.type === 'photo_uploaded') acc.uploaded = true;
    else if (ev.type === 'invoice_recognized') acc.final = 'recognized';
    else if (ev.type === 'recognition_error') acc.final = 'error';
    else if (ev.type === 'suspicious_total') flag(acc, 'suspicious');
    else if (ev.type === 'elevated_prices') flag(acc, 'elevated');
  }

  const all = [...byId.values()];
  // Итог — по последнему событию: перераспознавание после ошибки = распознана.
  for (const acc of all) if (acc.final === 'error') flag(acc, 'error');
  const rank = (acc: Acc): number => {
    const i = FLAG_ORDER.findIndex(f => acc.flags.includes(f));
    return i === -1 ? FLAG_ORDER.length : i;
  };
  const toInvoice = ({ id, number, supplier, flags }: Acc): BatchInvoice => ({
    id, number, supplier, flags: FLAG_ORDER.filter(f => flags.includes(f)),
  });

  return {
    uploaded: all.filter(a => a.uploaded).length,
    recognized: all.filter(a => a.final === 'recognized').length,
    errors: all.filter(a => a.final === 'error').map(toInvoice),
    suspicious: all.filter(a => a.flags.includes('suspicious')).length,
    elevated: all.filter(a => a.flags.includes('elevated')).length,
    invoices: all.slice().sort((a, b) => (rank(a) - rank(b)) || (a.order - b.order)).map(toInvoice),
    deliverable: [...snap.earlyUploads, ...snap.events].some(ev => ev.deliver !== false),
  };
}

/** «№ 123» — номер документа, если распознан; иначе «#775» — номер в ScanFlow. */
export function batchInvoiceLabel(inv: Pick<BatchInvoice, 'id' | 'number'>): string {
  return inv.number ? `№ ${inv.number}` : `#${inv.id}`;
}

/** Первая строка сводки: «Загружено 20 фото: распознано 18, с ошибкой 1 (#775), …». */
export function batchHeadline(s: BatchSummary): string {
  const parts = [`распознано ${s.recognized}`];
  if (s.errors.length) {
    const named = s.errors.slice(0, HEADLINE_MAX_ERRORS).map(batchInvoiceLabel).join(', ');
    parts.push(`с ошибкой ${s.errors.length} (${named}${s.errors.length > HEADLINE_MAX_ERRORS ? ', …' : ''})`);
  }
  if (s.suspicious) parts.push(`подозрительная сумма ${s.suspicious}`);
  if (s.elevated) parts.push(`повышенные цены ${s.elevated}`);
  return `Загружено ${s.uploaded} фото: ${parts.join(', ')}`;
}
