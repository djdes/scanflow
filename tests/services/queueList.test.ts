import { describe, it, expect, vi, beforeEach } from 'vitest';

// Сборка страницы «Очередь в 1С»: БД, гейт автопилота, справочник
// поставщиков и поиск фото замоканы. Проверяем готовность (гейт + то, что 1С
// не примет), Сбер, счётчики для кнопок и изоляцию по владельцу.

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/database/db', () => ({
  getDb: () => { throw new Error('сборка очереди не должна ходить в БД мимо репозиториев'); },
}));
vi.mock('../../src/database/repositories/queueRepo', () => ({
  queueRepo: {
    listQueueInvoices: vi.fn(),
    queueLines: vi.fn(),
    pendingNewItemKeys: vi.fn(),
    latestReocrByInvoice: vi.fn(),
    invoiceLines: vi.fn(),
    latestReocr: vi.fn(),
  },
}));
vi.mock('../../src/automation/qualityGate', () => ({ evaluateInvoiceQuality: vi.fn() }));
vi.mock('../../src/services/enrichSupplier', () => ({
  enrichInvoiceWithSupplier: vi.fn(async (i: { supplier: string | null; supplier_inn: string | null }) =>
    (i.supplier_inn === '7724357632' ? { ...i, supplier: 'ООО «Ромашка»' } : i)),
}));
vi.mock('../../src/golden/goldenRunner', () => ({
  locateGoldenPhoto: vi.fn((name: string) => (name.startsWith('gone') ? null : `/photos/${name}`)),
}));

import { loadQueueList, loadQueueCard, mapLimit, photoState, summarizeQueue } from '../../src/services/queueList';
import { queueRepo } from '../../src/database/repositories/queueRepo';
import { evaluateInvoiceQuality } from '../../src/automation/qualityGate';
import { linesFingerprint } from '../../src/services/queueReocr';
import { resetQueueJobsForTests } from '../../src/services/queueJobs';
import type { Invoice } from '../../src/database/repositories/invoiceRepo';

const qrepo = vi.mocked(queueRepo);
const gate = vi.mocked(evaluateInvoiceQuality);

function inv(p: Record<string, unknown> = {}) {
  return {
    id: 10, owner_user_id: 2, invoice_number: '12', invoice_date: '2026-09-15', supplier: 'Ромашка', supplier_inn: '7724357632',
    total_sum: 1200, vat_sum: 109.09, created_at: '2026-09-16 10:00:00', file_name: 'photo-10.jpg', file_path: null,
    items_total_mismatch: 0, supplier_match: 'inn', status: 'processed', approved_for_1c: 0, approved_at: null,
    sent_at: null, duplicate_of: null, onec_status: 'not_sent', onec_error: null, onec_pulled_at: null, paid_externally: 0,
    sber_status: null, sber_payment_number: null, sber_bank_status: null, sber_bank_status_at: null,
    ...p,
  };
}

function lineRow(p: Record<string, unknown> = {}) {
  return {
    id: 1, invoice_id: 10, original_name: 'Батон 0,4кг', mapped_name: 'Батон', quantity: 60, unit: 'шт', price: 20, total: 1200,
    vat_rate: 10, mapping_confidence: 1, onec_guid: 'g-bread', row_no: null, name_overridden: 0,
    conv_source: 'same', qty_flag: null, qty_flag_note: null,
    onec_unit: 'шт', onec_found: 1, median_price: null, median_price_unit: null, median_samples: null,
    ...p,
  };
}

const passed = { allowed: true, score: 100, reasons: [], settings: {} as never };

beforeEach(() => {
  vi.clearAllMocks();
  resetQueueJobsForTests();
  qrepo.pendingNewItemKeys.mockResolvedValue(new Set());
  qrepo.latestReocrByInvoice.mockResolvedValue(new Map());
  qrepo.latestReocr.mockResolvedValue(undefined);
  gate.mockResolvedValue(passed);
});

describe('loadQueueList', () => {
  it('готова / с замечаниями / одобрена; причины гейта; Сбер; фото; итоги и счётчики для кнопок', async () => {
    qrepo.listQueueInvoices.mockResolvedValue([
      inv(),
      inv({ id: 11, supplier_inn: null, supplier: 'ИП Кнутова', file_name: 'gone-11.jpg', total_sum: 800, vat_sum: 0,
        sber_status: 'created', sber_payment_number: '17', sber_bank_status: 'IMPLEMENTED' }),
      inv({ id: 12, approved_for_1c: 1, approved_at: '2026-09-20 09:00:00', total_sum: 1000, vat_sum: null,
        sber_status: 'created', sber_bank_status: 'CREATED' }),
    ] as never);
    qrepo.queueLines.mockResolvedValue([
      lineRow(),
      lineRow({ id: 2, invoice_id: 11, onec_guid: null, onec_unit: null, mapping_confidence: 0, conv_source: 'legacy_stored' }),
      lineRow({ id: 3, invoice_id: 11, unit: 'шт', onec_unit: 'кг', qty_flag: null }),
      lineRow({ id: 4, invoice_id: 12, qty_flag: 'needs_weight' }),
    ] as never);
    gate.mockImplementation(async (id: number) => (id === 11
      ? { ...passed, allowed: false, reasons: [{ code: 'unmapped', message: 'Не сопоставлено с 1С: 1' }, { code: 'amount_limit', message: 'лимит автопилота' }] }
      : passed));

    const list = await loadQueueList(2);
    expect(qrepo.listQueueInvoices).toHaveBeenCalledWith(2);
    expect(qrepo.queueLines).toHaveBeenCalledWith(2);
    expect(gate.mock.calls.map(c => c[0]).sort()).toEqual([10, 11, 12]);

    const [a, b, c] = list.data;
    expect(a).toMatchObject({ id: 10, state: 'ready', reasons: [], supplier: 'ООО «Ромашка»', photo: 'ok', pages: 1, sber: null, lines: 1, unmapped: 0 });
    expect(b.state).toBe('blocked');
    expect(b.reasons.map(r => [r.code, r.hard])).toEqual([['unmapped', false], ['supplier_inn', true], ['unit_mismatch', false]]);
    expect(b).toMatchObject({ supplier: 'ИП Кнутова', photo: 'missing', unmapped: 1, unmapped_open: 1, legacy_lines: 1 });
    expect(b.sber).toEqual({ status: 'created', number: '17', bank_status: 'IMPLEMENTED', bank_kind: 'paid', bank_label: 'Исполнен', bank_status_at: null });
    expect(c).toMatchObject({ id: 12, state: 'approved', approved_for_1c: true, flagged: 1 });
    expect(c.reasons).toEqual([]); // флаг пересчёта — причина гейта (unit_suspect), а гейт здесь замокан «чистым»

    expect(list.summary).toEqual({
      count: 3, total_sum: 3000, vat_sum: 109.09, ready: 1, blocked: 1, approved: 1,
      sber_created: 2, sber_paid: 1, no_photo: 1, legacy: 1,
      reocr_todo: 2, reocr_pending_apply: 0, llm_todo: 1,
    });
    expect(list.jobs).toEqual({ reocr: { job: null, busy: null }, llm_map: { job: null, busy: null } });
  });

  it('перераспознавание в списке: итоги, «строки меняли после», решённые не входят в «перераспознать очередь»', async () => {
    const lines = [lineRow()];
    qrepo.listQueueInvoices.mockResolvedValue([inv(), inv({ id: 11 }), inv({ id: 12 })] as never);
    qrepo.queueLines.mockResolvedValue(lines as never);
    const base = { owner_user_id: 2, model: 'm', pages: 1, header_diff: '[]', error: null, started_by: 2, started_at: '', finished_at: '', applied_by: null };
    qrepo.latestReocrByInvoice.mockResolvedValue(new Map([
      [10, { ...base, id: 1, invoice_id: 10, status: 'done', applied_at: null, lines_fingerprint: 'другие строки',
        summary: JSON.stringify({ changed: 2, added: 0, removed: 1, header_diff: 0 }) }],
      [11, { ...base, id: 2, invoice_id: 11, status: 'error', applied_at: null, lines_fingerprint: null, summary: null }],
    ]) as never);
    const list = await loadQueueList(2);
    expect(list.data[0].reocr).toMatchObject({ id: 1, status: 'done', stale: true, summary: { changed: 2, removed: 1 } });
    expect(list.data[0].reocr?.diff).toBeUndefined(); // тяжёлое сравнение — только в карточке
    expect(list.data[1].reocr).toMatchObject({ status: 'error', stale: false });
    expect(list.summary.reocr_pending_apply).toBe(1);
    expect(list.summary.reocr_todo).toBe(2); // 11 (ошибка) и 12 (не было)
  });

  it('сбой проверки одной накладной не роняет страницу — замечание «не удалось проверить»', async () => {
    qrepo.listQueueInvoices.mockResolvedValue([inv()] as never);
    qrepo.queueLines.mockResolvedValue([] as never);
    gate.mockRejectedValue(new Error('Deadlock found'));
    const list = await loadQueueList(2);
    expect(list.data[0]).toMatchObject({ state: 'blocked', reasons: [{ code: 'check_failed', hard: false }] });
  });
});

describe('loadQueueCard', () => {
  const invoiceRow = (p: Record<string, unknown> = {}) => ({ ...inv(p), read_at: null, invoice_type: 'торг_12' }) as unknown as Invoice;

  it('строки с замечаниями, причины, сравнение перераспознавания; одобренную не меняем', async () => {
    const lines = [lineRow({ unit: 'шт', onec_unit: 'кг', conv_source: 'legacy_stored' })];
    qrepo.invoiceLines.mockResolvedValue(lines as never);
    qrepo.latestReocr.mockResolvedValue({
      id: 5, owner_user_id: 2, invoice_id: 10, status: 'done', model: 'm', pages: 1,
      lines_fingerprint: linesFingerprint(lines as never), summary: '{"changed":1}', header_diff: '[]',
      proposed: JSON.stringify([{ ...lineRow(), quantity: 24, unit: 'кг', price: 50, conversion: {} }]),
      replaced: null, error: null, started_by: 2, started_at: '', finished_at: '', applied_at: null, applied_by: null,
    } as never);

    const card = await loadQueueCard(2, invoiceRow());
    expect(qrepo.invoiceLines).toHaveBeenCalledWith(2, 10);
    expect(card).toMatchObject({ in_queue: true, workable: true, state: 'blocked', photo: 'ok', legacy_lines: 1 });
    expect(card.reasons.map(r => r.code)).toEqual(['unit_mismatch']);
    expect(card.items[0]).toMatchObject({ id: 1, legacy: true, risks: [{ code: 'unit_mismatch', onec_unit: 'кг' }] });
    expect(card.reocr).toMatchObject({ id: 5, can_apply: true, fingerprint: linesFingerprint(lines as never) });
    expect(card.reocr?.diff?.rows[0]).toMatchObject({ kind: 'changed', fields: ['quantity', 'unit', 'price'] });

    const approved = await loadQueueCard(2, invoiceRow({ approved_for_1c: 1 }));
    expect(approved).toMatchObject({ in_queue: true, workable: false, state: 'approved' });
    expect(approved.reocr?.can_apply).toBe(false);
  });

  it('ошибка 1С при прошлой загрузке — причина с её текстом', async () => {
    qrepo.invoiceLines.mockResolvedValue([lineRow()] as never);
    const card = await loadQueueCard(2, invoiceRow({ onec_status: 'error', onec_error: 'Не найден контрагент' }));
    expect(card.reasons).toEqual([{ code: 'onec_error', message: '1С вернула ошибку при загрузке: Не найден контрагент', hard: false }]);
  });
});

describe('мелочи', () => {
  it('photoState: все страницы / часть / ни одной', () => {
    const locate = (n: string) => (n.startsWith('gone') ? null : `/p/${n}`);
    expect(photoState('a.jpg, b.jpg', null, locate)).toEqual({ state: 'ok', pages: 2 });
    expect(photoState('a.jpg, gone.jpg', null, locate)).toEqual({ state: 'partial', pages: 2 });
    expect(photoState('gone.jpg', null, locate)).toEqual({ state: 'missing', pages: 1 });
    expect(photoState(null, null, locate)).toEqual({ state: 'missing', pages: 0 });
  });

  it('mapLimit: не больше limit одновременно, порядок результатов сохраняется', async () => {
    let inFlight = 0;
    let max = 0;
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
      inFlight++; max = Math.max(max, inFlight);
      await new Promise(r => setTimeout(r, n));
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(max).toBe(2);
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });

  it('summarizeQueue пустой очереди', () => {
    expect(summarizeQueue([])).toMatchObject({ count: 0, total_sum: 0, ready: 0, reocr_todo: 0, llm_todo: 0 });
  });
});
