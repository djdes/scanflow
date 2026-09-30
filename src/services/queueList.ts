import { evaluateInvoiceQuality } from '../automation/qualityGate';
import type { Invoice } from '../database/repositories/invoiceRepo';
import { queueRepo, type QueueInvoiceRow, type QueueLineRow, type ReocrListRow } from '../database/repositories/queueRepo';
import { locateGoldenPhoto } from '../golden/goldenRunner';
import { bankStatusKind, bankStatusLabel } from '../sber/payments';
import { logger } from '../utils/logger';
import { enrichInvoiceWithSupplier } from './enrichSupplier';
import {
  invoiceFiles,
  isInQueue,
  isLegacyLine,
  isWorkable,
  lineRisks,
  priceDeviationPct,
  queueReasons,
  queueState,
  summarizeLines,
  type LineRisk,
  type QueueLineSummary,
  type QueueReason,
  type QueueState,
} from './queue';
import { reocrView, type ReocrView } from './queueReocr';
import { queueJobStatus, type QueueJobStatusView } from './queueJobs';

/**
 * Сборка страницы «Очередь в 1С» (#/queue): накладные очереди компании с
 * готовностью к 1С (причины гейта автопилота + то, что 1С не примет),
 * строками без позиции 1С и с флагом пересчёта, платёжкой в Сбере и
 * перераспознаванием. Только чтение; всё — в области владельца (правило 19).
 */

export type PhotoState = 'ok' | 'partial' | 'missing';

export function photoState(
  fileName: string | null,
  filePath: string | null,
  locate: (name: string, filePath: string | null) => string | null = locateGoldenPhoto,
): { state: PhotoState; pages: number } {
  const files = invoiceFiles(fileName);
  const found = files.filter(f => !!locate(f, filePath)).length;
  const state: PhotoState = !files.length || !found ? 'missing' : found < files.length ? 'partial' : 'ok';
  return { state, pages: files.length };
}

export interface QueueSberView {
  /** sber_payments.status: created | failed | pending. */
  status: string;
  number: string | null;
  bank_status: string | null;
  bank_kind: string | null;
  bank_label: string | null;
  bank_status_at: string | null;
}

export interface QueueListRow extends QueueLineSummary {
  id: number;
  invoice_number: string | null;
  invoice_date: string | null;
  supplier: string | null;
  supplier_inn: string | null;
  total_sum: number | null;
  vat_sum: number | null;
  created_at: string;
  approved_for_1c: boolean;
  approved_at: string | null;
  onec_status: string | null;
  onec_error: string | null;
  onec_pulled_at: string | null;
  state: QueueState;
  reasons: QueueReason[];
  pages: number;
  photo: PhotoState;
  paid_externally: boolean;
  sber: QueueSberView | null;
  reocr: ReocrView | null;
}

export interface QueueListSummary {
  count: number;
  total_sum: number;
  vat_sum: number;
  ready: number;
  blocked: number;
  approved: number;
  /** Черновик платёжки в Сбере создан. */
  sber_created: number;
  /** Банк исполнил платёжку — оплачено, а в 1С накладной ещё нет. */
  sber_paid: number;
  no_photo: number;
  legacy: number;
  /** Сколько накладных возьмёт «Перераспознать очередь» (не одобрены, результата ещё нет). */
  reocr_todo: number;
  /** Перераспознаны, есть расхождения, ждут решения человека. */
  reocr_pending_apply: number;
  /** Сколько накладных возьмёт «Подобрать позиции ИИ» (не одобрены, есть строки без позиции и без своего названия). */
  llm_todo: number;
}

export interface QueueList {
  data: QueueListRow[];
  summary: QueueListSummary;
  jobs: { reocr: QueueJobStatusView; llm_map: QueueJobStatusView };
}

/** Параллельно, но не больше limit одновременно (пул БД — 10 соединений). */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Причины гейта автопилота; сбой проверки одной накладной не роняет страницу. */
export async function gateReasons(invoiceId: number): Promise<Array<{ code: string; message: string }>> {
  try {
    return (await evaluateInvoiceQuality(invoiceId)).reasons;
  } catch (err) {
    logger.warn('queue: quality check failed', { invoiceId, error: (err as Error).message });
    return [{ code: 'check_failed', message: 'Не удалось проверить накладную — откройте её карточку' }];
  }
}

/** Название поставщика — как в списке накладных: из подтверждённой карточки справочника, если она есть. */
async function displaySupplier(inv: { supplier: string | null; supplier_inn: string | null; owner_user_id: number | null }): Promise<string | null> {
  try {
    const enriched = await enrichInvoiceWithSupplier({
      supplier: inv.supplier, supplier_inn: inv.supplier_inn, owner_user_id: inv.owner_user_id,
      supplier_kpp: null, supplier_bik: null, supplier_account: null, supplier_corr_account: null, supplier_address: null,
    });
    return enriched.supplier;
  } catch {
    return inv.supplier;
  }
}

function sberView(inv: QueueInvoiceRow): QueueSberView | null {
  if (!inv.sber_status) return null;
  return {
    status: inv.sber_status,
    number: inv.sber_payment_number ?? null,
    bank_status: inv.sber_bank_status ?? null,
    bank_kind: inv.sber_bank_status ? bankStatusKind(inv.sber_bank_status) : null,
    bank_label: inv.sber_bank_status ? bankStatusLabel(inv.sber_bank_status) : null,
    bank_status_at: inv.sber_bank_status_at ?? null,
  };
}

const DECIDED = new Set(['done', 'reverted', 'no_photo']);

export function buildQueueRow(
  inv: QueueInvoiceRow,
  lines: QueueLineRow[],
  pendingKeys: ReadonlySet<string>,
  reocr: ReocrListRow | undefined,
  gate: ReadonlyArray<{ code: string; message: string }>,
  supplier: string | null,
  photo: { state: PhotoState; pages: number },
): QueueListRow {
  const summary = summarizeLines(lines, pendingKeys);
  const reasons = queueReasons({
    gate, supplier_inn: inv.supplier_inn, onec_status: inv.onec_status, onec_error: inv.onec_error, risk_counts: summary.risk_counts,
  });
  return {
    id: inv.id,
    invoice_number: inv.invoice_number,
    invoice_date: inv.invoice_date,
    supplier,
    supplier_inn: inv.supplier_inn,
    total_sum: inv.total_sum,
    vat_sum: inv.vat_sum,
    created_at: inv.created_at,
    approved_for_1c: !!Number(inv.approved_for_1c),
    approved_at: inv.approved_at ?? null,
    onec_status: inv.onec_status ?? null,
    onec_error: inv.onec_error ?? null,
    onec_pulled_at: inv.onec_pulled_at ?? null,
    state: queueState(inv, reasons),
    reasons,
    ...summary,
    pages: photo.pages,
    photo: photo.state,
    paid_externally: !!Number(inv.paid_externally ?? 0),
    sber: sberView(inv),
    reocr: reocrView(reocr, lines),
  };
}

export function summarizeQueue(rows: QueueListRow[]): QueueListSummary {
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const workable = rows.filter(r => r.state !== 'approved');
  return {
    count: rows.length,
    total_sum: round2(rows.reduce((s, r) => s + Number(r.total_sum ?? 0), 0)),
    vat_sum: round2(rows.reduce((s, r) => s + Number(r.vat_sum ?? 0), 0)),
    ready: rows.filter(r => r.state === 'ready').length,
    blocked: rows.filter(r => r.state === 'blocked').length,
    approved: rows.filter(r => r.state === 'approved').length,
    sber_created: rows.filter(r => r.sber?.status === 'created').length,
    sber_paid: rows.filter(r => r.sber?.bank_kind === 'paid').length,
    no_photo: rows.filter(r => r.photo !== 'ok').length,
    legacy: rows.filter(r => r.legacy_lines > 0).length,
    reocr_todo: workable.filter(r => !(r.reocr && DECIDED.has(r.reocr.status))).length,
    reocr_pending_apply: workable.filter(r => r.reocr?.status === 'done' && !r.reocr.applied_at
      && r.reocr.summary != null && (r.reocr.summary.changed + r.reocr.summary.added + r.reocr.summary.removed) > 0).length,
    llm_todo: workable.filter(r => r.unmapped_open > 0).length,
  };
}

/** GET /api/queue — вся очередь компании. */
export async function loadQueueList(ownerUserId: number): Promise<QueueList> {
  const [invoices, lines, pendingKeys, reocr] = await Promise.all([
    queueRepo.listQueueInvoices(ownerUserId),
    queueRepo.queueLines(ownerUserId),
    queueRepo.pendingNewItemKeys(ownerUserId),
    queueRepo.latestReocrByInvoice(ownerUserId),
  ]);
  const byInvoice = new Map<number, QueueLineRow[]>();
  for (const l of lines) {
    const list = byInvoice.get(Number(l.invoice_id));
    if (list) list.push(l); else byInvoice.set(Number(l.invoice_id), [l]);
  }
  const data = await mapLimit(invoices, 4, async (inv) => {
    const [gate, supplier] = await Promise.all([gateReasons(inv.id), displaySupplier(inv)]);
    return buildQueueRow(inv, byInvoice.get(inv.id) ?? [], pendingKeys, reocr.get(inv.id), gate, supplier,
      photoState(inv.file_name, inv.file_path));
  });
  return {
    data,
    summary: summarizeQueue(data),
    jobs: { reocr: queueJobStatus(ownerUserId, 'reocr'), llm_map: queueJobStatus(ownerUserId, 'llm_map') },
  };
}

export interface QueueCardItem extends QueueLineRow {
  price_deviation_pct: number | null;
  legacy: boolean;
  risks: LineRisk[];
}

export interface QueueCard extends QueueLineSummary {
  invoice: {
    id: number;
    invoice_number: string | null;
    invoice_date: string | null;
    supplier: string | null;
    supplier_inn: string | null;
    supplier_match: string | null;
    total_sum: number | null;
    vat_sum: number | null;
    items_total_mismatch: number;
    status: string;
    approved_for_1c: boolean;
    sent_at: string | null;
    duplicate_of: number | null;
    created_at: string;
  };
  in_queue: boolean;
  workable: boolean;
  state: QueueState;
  reasons: QueueReason[];
  items: QueueCardItem[];
  pages: number;
  photo: PhotoState;
  reocr: ReocrView | null;
}

/** invoices.onec_status / onec_error есть в SELECT * (миграция «business control»), но не в типе Invoice. */
type InvoiceWithOnec = Invoice & { onec_status?: string | null; onec_error?: string | null };

/** GET /api/queue/:id — накладная владельца: замечания по строкам и сравнение перераспознавания. */
export async function loadQueueCard(ownerUserId: number, inv: InvoiceWithOnec): Promise<QueueCard> {
  const [lines, pendingKeys, row, gate, supplier] = await Promise.all([
    queueRepo.invoiceLines(ownerUserId, inv.id),
    queueRepo.pendingNewItemKeys(ownerUserId),
    queueRepo.latestReocr(ownerUserId, inv.id),
    gateReasons(inv.id),
    displaySupplier(inv),
  ]);
  const summary = summarizeLines(lines, pendingKeys);
  const reasons = queueReasons({
    gate, supplier_inn: inv.supplier_inn, onec_status: inv.onec_status ?? null, onec_error: inv.onec_error ?? null,
    risk_counts: summary.risk_counts,
  });
  const workable = isWorkable(inv);
  const photo = photoState(inv.file_name, inv.file_path);
  return {
    invoice: {
      id: inv.id,
      invoice_number: inv.invoice_number,
      invoice_date: inv.invoice_date,
      supplier,
      supplier_inn: inv.supplier_inn,
      supplier_match: inv.supplier_match,
      total_sum: inv.total_sum,
      vat_sum: inv.vat_sum,
      items_total_mismatch: inv.items_total_mismatch,
      status: inv.status,
      approved_for_1c: !!Number(inv.approved_for_1c),
      sent_at: inv.sent_at,
      duplicate_of: inv.duplicate_of,
      created_at: inv.created_at,
    },
    in_queue: isInQueue(inv),
    workable,
    state: queueState(inv, reasons),
    reasons,
    ...summary,
    items: lines.map(l => ({
      ...l,
      price_deviation_pct: priceDeviationPct(l),
      legacy: isLegacyLine(l),
      risks: lineRisks(l, pendingKeys),
    })),
    pages: photo.pages,
    photo: photo.state,
    reocr: reocrView(row, lines, { withDiff: true, workable }),
  };
}
