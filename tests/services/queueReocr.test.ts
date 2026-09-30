import { describe, it, expect, vi, beforeEach } from 'vitest';

// «Перераспознать очередь»: сравнение строк, предложенные строки, прогон
// одной накладной, запуск и применение. БД, Claude и пересчёт единиц
// замоканы; главное — шапку не пишем никогда, строки меняем только в apply.

const h = vi.hoisted(() => ({
  flags: { units_v2: true, mapping_v2: true } as Record<string, boolean>,
  cfg: { anthropicApiKey: '', processedDir: '', failedDir: '', inboxDir: '' },
}));

vi.mock('../../src/config', () => ({ config: h.cfg }));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/database/db', () => ({
  getDb: () => { throw new Error('перераспознавание не должно ходить в БД мимо репозиториев'); },
}));
vi.mock('../../src/database/repositories/invoiceRepo', () => ({
  invoiceRepo: {
    getById: vi.fn(),
    getItems: vi.fn(),
    getAnalyzerConfig: vi.fn(),
    recalculateTotal: vi.fn(),
    resetAttrChecks: vi.fn(),
    // Пишущие методы шапки/строк — чтобы убедиться, что их не зовут.
    updateInvoiceData: vi.fn(),
    updateStatus: vi.fn(),
    addItem: vi.fn(),
    deleteItems: vi.fn(),
    updateItemFields: vi.fn(),
    updateItemMapping: vi.fn(),
  },
}));
vi.mock('../../src/database/repositories/queueRepo', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/database/repositories/queueRepo')>();
  return {
    ...orig,
    queueRepo: {
      startReocr: vi.fn(),
      finishReocr: vi.fn(),
      recordReocrOutcome: vi.fn(),
      latestReocr: vi.fn(),
      replaceItems: vi.fn(),
      existingGuids: vi.fn(),
      queueIds: vi.fn(),
      markInterruptedReocr: vi.fn(),
    },
  };
});
vi.mock('../../src/database/repositories/onecNomenclatureRepo', () => ({
  onecNomenclatureRepo: { listItems: vi.fn(), getByGuid: vi.fn() },
}));
vi.mock('../../src/database/repositories/mappingRepo', () => ({
  mappingRepo: { getByScannedName: vi.fn(), getConfirmed: vi.fn() },
}));
vi.mock('../../src/database/repositories/rejectionRepo', () => ({ rejectionRepo: { guidsFor: vi.fn() } }));
vi.mock('../../src/database/repositories/ocrCorrectionRepo', () => ({ ocrCorrectionRepo: { apply: vi.fn(async (d: unknown) => d) } }));
vi.mock('../../src/database/repositories/editLogRepo', () => ({ logEdit: vi.fn() }));
vi.mock('../../src/ocr/ocrManager', () => ({ OcrManager: class { preprocessImage = vi.fn(); } }));
vi.mock('../../src/ocr/claudeApiAnalyzer', () => ({
  analyzeImageWithVerification: vi.fn(),
  analyzeMultiPageTextWithVerification: vi.fn(),
}));
vi.mock('../../src/learning/supplierMemory', () => ({ buildSupplierMemory: vi.fn(async () => 'ПАМЯТКА') }));
vi.mock('../../src/services/engineFlags', () => ({ getEngineFlags: vi.fn(async () => h.flags) }));
vi.mock('../../src/pricing/priceStats', () => ({ recomputeMedianForGuids: vi.fn(async () => undefined) }));
vi.mock('../../src/services/lineConversion', () => ({
  // Пересчёт единиц — отдельно проверенный модуль; здесь «как в накладной».
  convertInvoiceLine: vi.fn(async (a: { raw: { quantity: number | null; unit: string | null; price: number | null; total: number | null } }) => ({
    quantity: a.raw.quantity, unit: a.raw.unit, price: a.raw.price, total: a.raw.total,
    conversion: {
      raw_quantity: a.raw.quantity, raw_unit: a.raw.unit, raw_price: a.raw.price, raw_total: a.raw.total,
      conv_factor: 1, conv_note: null, conv_source: 'same', qty_flag: null, qty_flag_note: null,
    },
  })),
}));

import {
  diffLines,
  headerDiff,
  linesFingerprint,
  reocrView,
  buildProposedLines,
  reocrInvoice,
  startQueueReocr,
  applyQueueReocr,
  revertQueueReocr,
  reconcileInterruptedReocr,
  ReocrApplyError,
  type ProposedLine,
  type CurrentLineLike,
  type ReocrDeps,
  type ReocrRunContext,
} from '../../src/services/queueReocr';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';
import { queueRepo, QueueReplaceConflict } from '../../src/database/repositories/queueRepo';
import { onecNomenclatureRepo } from '../../src/database/repositories/onecNomenclatureRepo';
import { mappingRepo } from '../../src/database/repositories/mappingRepo';
import { rejectionRepo } from '../../src/database/repositories/rejectionRepo';
import { logEdit } from '../../src/database/repositories/editLogRepo';
import { convertInvoiceLine } from '../../src/services/lineConversion';
import { resetQueueJobsForTests, activeQueueJob, startQueueJob, QueueJobBusyError, QueueStartError } from '../../src/services/queueJobs';
import type { ParsedInvoiceData } from '../../src/ocr/types';

const repo = vi.mocked(invoiceRepo);
const qrepo = vi.mocked(queueRepo);
const onec = vi.mocked(onecNomenclatureRepo);
const maps = vi.mocked(mappingRepo);

// ── Фикстуры ────────────────────────────────────────────────────────────────

function cur(id: number, name: string, p: Partial<CurrentLineLike> = {}): CurrentLineLike {
  return {
    id, original_name: name, mapped_name: name, onec_guid: null,
    quantity: 1, unit: 'шт', price: 100, total: 100, vat_rate: 10, conv_source: 'legacy_stored', name_overridden: 0,
    ...p,
  };
}

function prop(name: string, p: Partial<ProposedLine> = {}): ProposedLine {
  const base: ProposedLine = {
    original_name: name, mapped_name: name, onec_guid: null, mapping_confidence: 0, mapping_source: 'none',
    quantity: 1, unit: 'шт', price: 100, total: 100, vat_rate: 10,
    conversion: {
      raw_quantity: 1, raw_unit: 'шт', raw_price: 100, raw_total: 100,
      conv_factor: 1, conv_note: null, conv_source: 'same', qty_flag: null, qty_flag_note: null,
    },
  };
  return { ...base, ...p };
}

function invoice(p: Record<string, unknown> = {}) {
  return {
    id: 10, owner_user_id: 1, status: 'processed', approved_for_1c: 0, sent_at: null, duplicate_of: null,
    file_name: 'photo-10.jpg', file_path: '/data/processed/photo-10.jpg',
    invoice_number: 'А-12', invoice_date: '2026-09-15', supplier: 'ООО Ромашка', supplier_inn: '7724357632',
    total_sum: 1000, vat_sum: 90.91, items_total_mismatch: 0, supplier_match: 'inn',
    ...p,
  };
}

function mapperStub() {
  return {
    map: vi.fn(async (name: string) => ({
      original_name: name, mapped_name: name, onec_guid: null, confidence: 0, source: 'none' as const,
      mapping_id: null, pack_size: null, pack_unit: null,
    })),
    mapSupplierOverride: vi.fn(async () => null),
  };
}

const CATALOG = [
  { guid: 'g-milk1', name: 'Молоко 3,2% 1л', unit: 'шт' },
  { guid: 'g-milk2', name: 'Молоко 3,2% 2л', unit: 'шт' },
  { guid: 'g-bread', name: 'Батон нарезной', unit: 'шт' },
];

beforeEach(() => {
  vi.clearAllMocks();
  resetQueueJobsForTests();
  h.flags = { units_v2: true, mapping_v2: true };
  maps.getConfirmed.mockResolvedValue(undefined);
  maps.getByScannedName.mockResolvedValue(undefined);
  vi.mocked(rejectionRepo.guidsFor).mockResolvedValue(new Set());
  onec.getByGuid.mockImplementation(async (guid: string) => {
    const c = CATALOG.find(x => x.guid === guid);
    return c ? ({ ...c } as never) : undefined;
  });
});

// ── Сравнение строк ────────────────────────────────────────────────────────

describe('diffLines', () => {
  it('одинаковые строки — всё «без изменений»', () => {
    const d = diffLines([cur(1, 'Батон'), cur(2, 'Молоко')], [prop('Батон'), prop('Молоко')]);
    expect(d.rows.map(r => r.kind)).toEqual(['same', 'same']);
    expect(d.summary).toMatchObject({ current: 2, proposed: 2, same: 2, changed: 0, added: 0, removed: 0, sum_current: 200, sum_proposed: 200 });
  });

  it('строка до v2 «60 шт батона» против пересчитанной «24 кг» — изменены количество, единица, цена', () => {
    const d = diffLines(
      [cur(1, 'Батон 0,4кг', { quantity: 60, unit: 'шт', price: 20, total: 1200, onec_guid: 'g-bread' })],
      [prop('Батон 0,4кг', { quantity: 24, unit: 'кг', price: 50, total: 1200, onec_guid: 'g-bread' })],
    );
    expect(d.rows).toHaveLength(1);
    expect(d.rows[0].kind).toBe('changed');
    expect(d.rows[0].fields).toEqual(['quantity', 'unit', 'price']);
  });

  it('строка потерялась в середине — «удалена», соседи остаются на месте', () => {
    const d = diffLines([cur(1, 'Батон'), cur(2, 'Кефир'), cur(3, 'Сметана')], [prop('Батон'), prop('Сметана')]);
    expect(d.rows.map(r => `${r.kind}:${r.current?.original_name ?? r.proposed?.original_name}`))
      .toEqual(['same:Батон', 'removed:Кефир', 'same:Сметана']);
  });

  it('новая строка — «новая»; порядок слов и регистр в названии не важны', () => {
    const d = diffLines([cur(1, 'Молоко 3,2% 1л')], [prop('1л МОЛОКО 3,2%', { mapped_name: 'Молоко 3,2% 1л' }), prop('Творог 5%')]);
    expect(d.rows.map(r => r.kind)).toEqual(['same', 'added']);
  });

  it('товар прочитан иначе (между опорными строками) — «изменена: название» (и название для 1С)', () => {
    const d = diffLines([cur(1, 'Батон'), cur(2, 'Кефир'), cur(3, 'Сметана')], [prop('Батон'), prop('Ряженка'), prop('Сметана')]);
    expect(d.rows[1]).toMatchObject({ kind: 'changed', fields: ['name', 'onec'] });
    expect(d.rows[1].current?.original_name).toBe('Кефир');
    expect(d.rows[1].proposed?.original_name).toBe('Ряженка');
  });

  it('позиция 1С: другая позиция — изменение; у новых товаров сравнивается название для 1С', () => {
    const changedGuid = diffLines([cur(1, 'Молоко', { onec_guid: 'g-milk1' })], [prop('Молоко', { onec_guid: 'g-milk2' })]);
    expect(changedGuid.rows[0].fields).toEqual(['onec']);
    const renamed = diffLines([cur(1, 'Капуста', { mapped_name: 'Ламинария', name_overridden: 1 })], [prop('Капуста', { mapped_name: 'Капуста морская' })]);
    expect(renamed.rows[0].fields).toEqual(['onec']);
    expect(renamed.summary.manual_lines).toBe(1);
  });

  it('ставка НДС и сумма сравниваются с допуском в копейку', () => {
    const d = diffLines([cur(1, 'Батон', { total: 100.004, vat_rate: 10 })], [prop('Батон', { total: 100, vat_rate: 20 })]);
    expect(d.rows[0].fields).toEqual(['vat_rate']);
  });
});

describe('headerDiff — только показ', () => {
  const stored = { invoice_number: '№ А-12', invoice_date: '2026-09-15', supplier_inn: '7724357632', total_sum: 1000, vat_sum: 90.91 };
  it('те же значения в другой записи — не расхождение', () => {
    expect(headerDiff(stored, { invoice_number: 'A12', invoice_date: '15.09.2026', supplier_inn: '7724 357 632', total_sum: 1000.004, vat_sum: 90.91, items: [] })).toEqual([]);
  });
  it('другие номер, дата, ИНН, сумма, НДС — расхождения; пустое в распознанном — нет', () => {
    const d = headerDiff(stored, { invoice_number: 'А-13', invoice_date: '2026-09-16', supplier_inn: '7724357633', total_sum: 1100, vat_sum: undefined, items: [] });
    expect(d.map(x => x.field)).toEqual(['invoice_number', 'invoice_date', 'supplier_inn', 'total_sum']);
    expect(d.find(x => x.field === 'total_sum')).toEqual({ field: 'total_sum', stored: 1000, recognized: 1100 });
  });
});

describe('linesFingerprint и reocrView', () => {
  it('отпечаток не зависит от порядка выборки и меняется при правке строки', () => {
    const a = [cur(1, 'Батон'), cur(2, 'Молоко')];
    expect(linesFingerprint(a)).toBe(linesFingerprint([a[1], a[0]]));
    expect(linesFingerprint(a)).not.toBe(linesFingerprint([cur(1, 'Батон', { quantity: 2 }), a[1]]));
    expect(linesFingerprint(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  function row(p: Record<string, unknown> = {}) {
    const lines = [cur(1, 'Батон')];
    return {
      id: 5, owner_user_id: 1, invoice_id: 10, status: 'done' as const, model: 'claude-sonnet-5', pages: 1,
      lines_fingerprint: linesFingerprint(lines), summary: JSON.stringify({ changed: 1 }), header_diff: '[]',
      proposed: JSON.stringify([prop('Батон', { quantity: 2, total: 200, price: 100 })]), replaced: null, error: null,
      started_by: 1, started_at: '2026-09-29 10:00:00', finished_at: '2026-09-29 10:02:00', applied_at: null, applied_by: null,
      ...p,
    };
  }

  it('строки меняли после перераспознавания → stale; сравнение — уже с текущими', () => {
    const edited = [cur(1, 'Батон', { quantity: 3, total: 300 })];
    const v = reocrView(row(), edited, { withDiff: true, workable: true })!;
    expect(v.stale).toBe(true);
    expect(v.diff?.rows[0].current?.quantity).toBe(3);
    expect(v.fingerprint).toBe(linesFingerprint(edited));
    expect(v.can_apply).toBe(true);
    expect(v.can_revert).toBeUndefined();
  });

  it('применённое, одобренное, без отличий — применять нельзя', () => {
    const lines = [cur(1, 'Батон')];
    expect(reocrView(row({ applied_at: '2026-09-29 11:00:00' }), lines, { withDiff: true, workable: true })!.can_apply).toBe(false);
    expect(reocrView(row(), lines, { withDiff: true, workable: false })!.can_apply).toBe(false);
    expect(reocrView(row({ proposed: JSON.stringify([prop('Батон')]) }), lines, { withDiff: true, workable: true })!.can_apply).toBe(false);
  });

  it('применённое с сохранёнными строками — можно вернуть, пока не одобрена; видно, что вернётся', () => {
    const replaced = JSON.stringify([{ ...cur(1, 'Батон', { quantity: 60, total: 1200 }), raw_quantity: 60 }, { id: 2, original_name: 'Кефир', total: 100 }]);
    const applied = row({ applied_at: '2026-09-29 11:00:00', replaced });
    const v = reocrView(applied, [cur(7, 'Батон', { quantity: 2, total: 200 })], { withDiff: true, workable: true })!;
    expect(v.can_revert).toBe(true);
    expect(v.replaced_summary).toEqual({ lines: 2, sum: 1300 });
    expect(reocrView(applied, [cur(7, 'Батон')], { withDiff: true, workable: false })!.can_revert).toBe(false);
    expect(reocrView(row({ applied_at: '2026-09-29 11:00:00', replaced: null }), [cur(7, 'Батон')], { withDiff: true, workable: true })!.can_revert).toBe(false);
  });

  it('список: без тяжёлых строк — только итоги и stale', () => {
    const v = reocrView({ ...row(), proposed: undefined } as never, [cur(1, 'Батон')])!;
    expect(v.diff).toBeUndefined();
    expect(v.summary).toEqual({ changed: 1 });
    expect(v.stale).toBe(false);
  });
});

// ── Предложенные строки ────────────────────────────────────────────────────

describe('buildProposedLines — тот же путь, что при приёме', () => {
  const inv = { owner_user_id: 1, supplier_inn: '7724357632', supplier: 'ООО Ромашка', total_sum: 1000, vat_sum: null };

  it('выбор Claude по catalog_idx принимается, если проверки v2 не против; подбор fuzzy не нужен', async () => {
    const mapper = mapperStub();
    const parsed: ParsedInvoiceData = { total_sum: 1000, items: [{ name: 'Молоко 3,2% 1л', quantity: 10, unit: 'шт', price: 100, total: 1000, catalog_idx: 1, pack_size: 12 }] };
    const lines = await buildProposedLines(parsed, inv, { mapper, catalog: CATALOG });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ onec_guid: 'g-milk1', mapped_name: 'Молоко 3,2% 1л', mapping_confidence: 1, quantity: 10, total: 1000 });
    expect(mapper.map).not.toHaveBeenCalled();
    // Подсказка упаковки Claude и поставщик шапки — в пересчёт единиц.
    expect(vi.mocked(convertInvoiceLine)).toHaveBeenCalledWith(expect.objectContaining({
      ownerUserId: 1, name: 'Молоко 3,2% 1л', onecGuid: 'g-milk1', llmPackHint: 12, supplierKey: 'inn:7724357632',
    }));
  });

  it('выбор Claude, противоречащий названию (1л ≠ 2л), не принимается — работает обычный подбор', async () => {
    const mapper = mapperStub();
    const parsed: ParsedInvoiceData = { items: [{ name: 'Молоко 3,2% 1л', quantity: 1, unit: 'шт', price: 90, total: 90, catalog_idx: 2 }] };
    await buildProposedLines(parsed, inv, { mapper, catalog: CATALOG });
    expect(mapper.map).toHaveBeenCalledWith('Молоко 3,2% 1л', 1, { supplierInn: '7724357632', supplierName: 'ООО Ромашка' });
  });

  it('подтверждённое правило важнее выбора Claude; правило поставщика важнее всего', async () => {
    const mapper = mapperStub();
    maps.getConfirmed.mockResolvedValue({ id: 9, onec_guid: 'g-bread', confirmed_at: '2026-09-01', pack_size: null, pack_unit: null } as never);
    const parsed: ParsedInvoiceData = { items: [{ name: 'Батон', quantity: 1, unit: 'шт', price: 40, total: 40, catalog_idx: 1 }] };
    const lines = await buildProposedLines(parsed, inv, { mapper, catalog: CATALOG });
    expect(lines[0].onec_guid).toBe('g-bread');

    mapper.mapSupplierOverride.mockResolvedValueOnce({
      original_name: 'Батон', mapped_name: 'Молоко 3,2% 2л', onec_guid: 'g-milk2', confidence: 1, source: 'supplier',
      mapping_id: null, pack_size: null, pack_unit: null,
    } as never);
    const lines2 = await buildProposedLines(parsed, inv, { mapper, catalog: CATALOG });
    expect(lines2[0]).toMatchObject({ onec_guid: 'g-milk2', mapping_source: 'supplier' });
  });

  it('строки без названия пропускаются; строки «без НДС» при итоге «с НДС» доводятся до итога', async () => {
    const parsed: ParsedInvoiceData = {
      total_sum: 1100, vat_sum: 100,
      items: [
        { name: 'Батон', quantity: 10, unit: 'шт', price: 50, total: 500, vat_rate: 10 },
        { name: '', quantity: 1, unit: 'шт', price: 1, total: 1 },
        { name: 'Кефир', quantity: 5, unit: 'шт', price: 100, total: 500, vat_rate: 10 },
      ],
    };
    const lines = await buildProposedLines(parsed, inv, { mapper: mapperStub(), catalog: null });
    expect(lines.map(l => l.original_name)).toEqual(['Батон', 'Кефир']);
    // Как при приёме: безымянная строка тоже входит в Σ для масштаба (×1100/1001).
    expect(lines.map(l => l.total)).toEqual([549.45, 549.45]);
    expect(lines.map(l => l.price)).toEqual([54.95, 109.89]);
  });
});

// ── Перераспознавание одной накладной ─────────────────────────────────────

function deps(p: Partial<ReocrDeps> = {}): ReocrDeps {
  return {
    locatePhoto: vi.fn((name: string) => `/photos/${name}`),
    loadCatalog: vi.fn(async () => CATALOG.map(c => ({ ...c, code: null, full_name: null, parent_guid: null, is_folder: 0, is_weighted: 0, synced_at: '' }))),
    recognizePage: vi.fn(async () => ({
      text: '{"page":1}',
      parsed: { invoice_number: 'А-12', invoice_date: '2026-09-15', supplier_inn: '7724357632', total_sum: 1200, items: [{ name: 'Батон 0,4кг', quantity: 60, unit: 'шт', price: 20, total: 1200, catalog_idx: 3 }] },
    })),
    mergePages: vi.fn(async () => ({ total_sum: 1200, items: [{ name: 'Батон 0,4кг', quantity: 60, unit: 'шт', price: 20, total: 1200 }] })),
    ...p,
  };
}

function ctx(p: Partial<ReocrRunContext> = {}): ReocrRunContext {
  return { ownerUserId: 1, startedBy: 1, apiKey: 'sk', model: 'claude-sonnet-5', memory: 'ПАМЯТКА', llmMapperEnabled: true, mapper: mapperStub(), ...p };
}

function expectNoInvoiceWrites(): void {
  for (const m of ['updateInvoiceData', 'updateStatus', 'addItem', 'deleteItems', 'updateItemFields', 'updateItemMapping', 'recalculateTotal'] as const) {
    expect(repo[m], `invoiceRepo.${m} не должен вызываться`).not.toHaveBeenCalled();
  }
  expect(qrepo.replaceItems).not.toHaveBeenCalled();
}

describe('reocrInvoice', () => {
  beforeEach(() => {
    repo.getById.mockResolvedValue(invoice() as never);
    repo.getItems.mockResolvedValue([cur(1, 'Батон 0,4кг', { quantity: 60, unit: 'шт', price: 20, total: 1200 })] as never);
    qrepo.startReocr.mockResolvedValue(77);
    qrepo.finishReocr.mockResolvedValue();
    qrepo.recordReocrOutcome.mockResolvedValue();
  });

  it('одна страница: боевой путь с каталогом и памяткой, предложения сохранены, шапка и строки не тронуты', async () => {
    const d = deps();
    const r = await reocrInvoice(10, ctx(), d);
    expect(r).toMatchObject({ invoice_id: 10, status: 'done' });
    const rc = vi.mocked(d.recognizePage).mock.calls[0][1];
    expect(vi.mocked(d.recognizePage).mock.calls[0][0]).toBe('/photos/photo-10.jpg');
    expect(rc).toMatchObject({ apiKey: 'sk', model: 'claude-sonnet-5', memory: 'ПАМЯТКА' });
    expect(rc.catalog.map(c => c.guid)).toEqual(['g-milk1', 'g-milk2', 'g-bread']);
    expect(qrepo.startReocr).toHaveBeenCalledWith({ ownerUserId: 1, invoiceId: 10, startedBy: 1, model: 'claude-sonnet-5', pages: 1 });
    const [rowId, finished] = qrepo.finishReocr.mock.calls[0];
    expect(rowId).toBe(77);
    expect(finished.status).toBe('done');
    expect((finished.proposed as ProposedLine[])[0]).toMatchObject({ original_name: 'Батон 0,4кг', onec_guid: 'g-bread' });
    expect(finished.headerDiff).toEqual([{ field: 'total_sum', stored: 1000, recognized: 1200 }]);
    expect(finished.linesFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expectNoInvoiceWrites();
  });

  it('подбор ИИ выключен — каталог в запрос не идёт', async () => {
    const d = deps();
    await reocrInvoice(10, ctx({ llmMapperEnabled: false }), d);
    expect(d.loadCatalog).not.toHaveBeenCalled();
    expect(vi.mocked(d.recognizePage).mock.calls[0][1].catalog).toEqual([]);
  });

  it('многостраничная: каждая страница, затем сшивка ответов', async () => {
    repo.getById.mockResolvedValue(invoice({ file_name: 'p1.jpg, p2.jpg' }) as never);
    const d = deps();
    const r = await reocrInvoice(10, ctx(), d);
    expect(r.status).toBe('done');
    expect(d.recognizePage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(d.mergePages).mock.calls[0][0]).toBe('{"page":1}\n\n--- СТРАНИЦА ---\n\n{"page":1}');
    expect(vi.mocked(d.mergePages).mock.calls[0][1]).toBe(2);
  });

  it('электронный документ (XML) не перераспознаётся: строки взяты из самого документа', async () => {
    repo.getById.mockResolvedValue(invoice({ file_name: 'ON_NSCHFDOPPR_1.xml', ocr_engine: 'xml_upd' }) as never);
    const d = deps();
    const r = await reocrInvoice(10, ctx(), d);
    expect(r).toMatchObject({ status: 'skipped', reason: 'xml' });
    expect(d.recognizePage).not.toHaveBeenCalled();
    expect(qrepo.startReocr).not.toHaveBeenCalled();
    expect(qrepo.recordReocrOutcome.mock.calls[0][0]).toMatchObject({ status: 'skipped' });
    expectNoInvoiceWrites();
  });

  it('фото удалено по сроку хранения → «фото нет», Claude не вызывается', async () => {
    const d = deps({ locatePhoto: vi.fn(() => null) });
    const r = await reocrInvoice(10, ctx(), d);
    expect(r).toMatchObject({ status: 'no_photo' });
    expect(d.recognizePage).not.toHaveBeenCalled();
    expect(qrepo.recordReocrOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: 'no_photo', invoiceId: 10 }));
    expect(qrepo.startReocr).not.toHaveBeenCalled();
  });

  it('нет одной из страниц → «фото нет» с понятной причиной', async () => {
    repo.getById.mockResolvedValue(invoice({ file_name: 'p1.jpg,p2.jpg' }) as never);
    const d = deps({ locatePhoto: vi.fn((n: string) => (n === 'p1.jpg' ? '/photos/p1.jpg' : null)) });
    const r = await reocrInvoice(10, ctx(), d);
    expect(r).toMatchObject({ status: 'no_photo', error: expect.stringContaining('1 из 2') });
    expect(d.recognizePage).not.toHaveBeenCalled();
  });

  it('накладная ушла из очереди (одобрена) → пропуск; чужая → пропуск без записи', async () => {
    repo.getById.mockResolvedValueOnce(invoice({ approved_for_1c: 1 }) as never);
    expect(await reocrInvoice(10, ctx(), deps())).toMatchObject({ status: 'skipped', reason: 'not_in_queue' });
    repo.getById.mockResolvedValueOnce(invoice({ owner_user_id: 2 }) as never);
    expect(await reocrInvoice(10, ctx(), deps())).toMatchObject({ status: 'skipped', reason: 'not_found' });
    expect(qrepo.recordReocrOutcome).toHaveBeenCalledTimes(1);
  });

  it('ошибка распознавания → результат error, строка результата закрыта, исключение наружу не летит', async () => {
    const d = deps({ recognizePage: vi.fn(async () => { throw new Error('Claude API error: 529 overloaded'); }) });
    const r = await reocrInvoice(10, ctx(), d);
    expect(r).toMatchObject({ status: 'error', error: expect.stringContaining('529') });
    expect(qrepo.finishReocr).toHaveBeenCalledWith(77, { status: 'error', error: 'Claude API error: 529 overloaded' });
    expectNoInvoiceWrites();
  });
});

// ── Запуск ────────────────────────────────────────────────────────────────

describe('startQueueReocr', () => {
  beforeEach(() => {
    repo.getAnalyzerConfig.mockResolvedValue({ anthropic_api_key: 'sk-db', claude_model: 'claude-sonnet-5', llm_mapper_enabled: true } as never);
    repo.getById.mockImplementation(async (id: number) => invoice({ id, file_name: `photo-${id}.jpg` }) as never);
    repo.getItems.mockResolvedValue([] as never);
    qrepo.queueIds.mockResolvedValue([10, 11, 12]);
    qrepo.markInterruptedReocr.mockResolvedValue(0);
    qrepo.startReocr.mockResolvedValue(1);
    qrepo.finishReocr.mockResolvedValue();
  });

  it('строго по одной накладной; модель, ключ и памятка — один раз на прогон', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const d = deps({
      recognizePage: vi.fn(async () => {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(r => setTimeout(r, 3));
        inFlight--;
        return { text: '{}', parsed: { items: [] } };
      }),
    });
    const started = await startQueueReocr({ ownerUserId: 1, startedBy: 1, invoiceIds: [10, 11, 12], mapper: mapperStub() }, d);
    expect(started.planned).toBe(3);
    expect(qrepo.queueIds).toHaveBeenCalledWith(1, { ids: [10, 11, 12] });
    await vi.waitFor(() => expect(activeQueueJob()).toBeNull());
    expect(maxInFlight).toBe(1);
    expect(d.recognizePage).toHaveBeenCalledTimes(3);
    expect(repo.getAnalyzerConfig).toHaveBeenCalledTimes(1);
  });

  it('вся очередь — без накладных, уже получивших результат (продолжение после перезапуска); redo — заново', async () => {
    const started = await startQueueReocr({ ownerUserId: 1, startedBy: 1, mapper: mapperStub() }, deps());
    expect(qrepo.queueIds).toHaveBeenLastCalledWith(1, { skipDecided: true });
    expect(started.planned).toBe(3);
    await vi.waitFor(() => expect(activeQueueJob()).toBeNull());

    await startQueueReocr({ ownerUserId: 1, startedBy: 1, redo: true, mapper: mapperStub() }, deps());
    expect(qrepo.queueIds).toHaveBeenLastCalledWith(1, { skipDecided: false });
    await vi.waitFor(() => expect(activeQueueJob()).toBeNull());
  });

  it('перед запуском оборванные перезапуском строки «идёт» закрываются', async () => {
    await startQueueReocr({ ownerUserId: 1, startedBy: 1, invoiceIds: [10], mapper: mapperStub() }, deps());
    expect(qrepo.markInterruptedReocr).toHaveBeenCalledWith(1);
    await vi.waitFor(() => expect(activeQueueJob()).toBeNull());
  });

  it('нет API-ключа → 400; нечего перераспознавать → 400 с понятной причиной; сервер занят → 409-ошибка', async () => {
    repo.getAnalyzerConfig.mockResolvedValueOnce({ anthropic_api_key: null, claude_model: 'm', llm_mapper_enabled: true } as never);
    await expect(startQueueReocr({ ownerUserId: 1, startedBy: 1, mapper: mapperStub() }, deps())).rejects.toBeInstanceOf(QueueStartError);

    qrepo.queueIds.mockResolvedValueOnce([]);
    await expect(startQueueReocr({ ownerUserId: 1, startedBy: 1, mapper: mapperStub() }, deps())).rejects.toThrow('Перераспознавать нечего');
    qrepo.queueIds.mockResolvedValueOnce([]);
    await expect(startQueueReocr({ ownerUserId: 1, startedBy: 1, invoiceIds: [5], mapper: mapperStub() }, deps())).rejects.toThrow('одобренные для 1С');

    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const { done } = startQueueJob({ kind: 'llm_map', ownerUserId: 2, startedBy: 2, invoiceIds: [1], worker: async (id) => { await gate; return { invoice_id: id, status: 'ok' }; } });
    await expect(startQueueReocr({ ownerUserId: 1, startedBy: 1, mapper: mapperStub() }, deps())).rejects.toBeInstanceOf(QueueJobBusyError);
    release();
    await done;
  });
});

// ── Применение ────────────────────────────────────────────────────────────

describe('applyQueueReocr', () => {
  const current = [cur(1, 'Батон 0,4кг', { quantity: 60, unit: 'шт', price: 20, total: 1200, onec_guid: 'g-bread', vat_rate: 10 })];
  const proposed = [prop('Батон 0,4кг', { quantity: 24, unit: 'кг', price: 50, total: 1200, onec_guid: 'g-bread', vat_rate: 10 })];
  const FP = linesFingerprint(current);

  function resultRow(p: Record<string, unknown> = {}) {
    return {
      id: 5, owner_user_id: 1, invoice_id: 10, status: 'done', model: 'claude-sonnet-5', pages: 1, lines_fingerprint: FP,
      summary: null, header_diff: '[]', proposed: JSON.stringify(proposed), replaced: null, error: null,
      started_by: 1, started_at: '', finished_at: '', applied_at: null, applied_by: null, ...p,
    };
  }

  beforeEach(() => {
    repo.getById.mockResolvedValue(invoice({ total_sum: 1200, vat_sum: 109.09 }) as never);
    qrepo.latestReocr.mockResolvedValue(resultRow() as never);
    qrepo.existingGuids.mockResolvedValue(new Set(['g-bread']));
    qrepo.replaceItems.mockImplementation(async (opts) => {
      opts.check({ status: 'processed', approved_for_1c: 0, sent_at: null, duplicate_of: null }, current as never);
      return { before: current as never };
    });
    repo.recalculateTotal.mockResolvedValue();
  });

  it('строки заменяются одной транзакцией, шапка не пишется, всё в журнале', async () => {
    const r = await applyQueueReocr({ ownerUserId: 1, invoiceId: 10, userId: 1, fingerprint: FP });
    expect(r).toMatchObject({ deleted: 1, inserted: 1 });
    const call = qrepo.replaceItems.mock.calls[0][0];
    expect(call).toMatchObject({ ownerUserId: 1, invoiceId: 10, resultId: 5, userId: 1, mark: 'apply' });
    expect(call.lines[0]).toMatchObject({
      original_name: 'Батон 0,4кг', quantity: 24, unit: 'кг', total: 1200, onec_guid: 'g-bread', row_no: null, name_overridden: 0,
    });
    // Итог и НДС шапки не трогаем: только флаг расхождения (keepVat, итог > 0).
    expect(repo.recalculateTotal).toHaveBeenCalledWith(10, { keepVat: true });
    expect(repo.updateInvoiceData).not.toHaveBeenCalled();
    expect(repo.resetAttrChecks).not.toHaveBeenCalled(); // ставки НДС те же
    // Число строк и сумма те же — запись в журнале всё равно есть (номер результата в «стало»).
    expect(vi.mocked(logEdit)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logEdit)).toHaveBeenCalledWith(expect.objectContaining({
      invoiceId: 10, entity: 'item', field: 'reocr_apply',
      oldValue: { lines: 1, sum: 1200 }, newValue: { lines: 1, sum: 1200, reocr_result: 5 },
      context: expect.objectContaining({ result_id: 5, before: [expect.objectContaining({ qty: 60 })], after: [expect.objectContaining({ qty: 24 })] }),
    }));
  });

  it('без итога в шапке recalculateTotal не зовётся — итог не «выводится» из строк', async () => {
    repo.getById.mockResolvedValue(invoice({ total_sum: null, vat_sum: null }) as never);
    await applyQueueReocr({ ownerUserId: 1, invoiceId: 10, userId: 1, fingerprint: FP });
    expect(qrepo.replaceItems).toHaveBeenCalled();
    expect(repo.recalculateTotal).not.toHaveBeenCalled();
  });

  it('строки меняли после показа сравнения → 409 stale', async () => {
    await expect(applyQueueReocr({ ownerUserId: 1, invoiceId: 10, userId: 1, fingerprint: 'f'.repeat(64) }))
      .rejects.toMatchObject({ status: 409, code: 'stale' });
  });

  it('гонка: в транзакции накладная уже одобрена → 409 not_in_queue', async () => {
    qrepo.replaceItems.mockImplementationOnce(async (opts) => {
      opts.check({ status: 'processed', approved_for_1c: 1, sent_at: null, duplicate_of: null }, current as never);
      return { before: [] };
    });
    await expect(applyQueueReocr({ ownerUserId: 1, invoiceId: 10, userId: 1, fingerprint: FP }))
      .rejects.toMatchObject({ status: 409, code: 'not_in_queue' });
  });

  it('повторное применение (второй клик) → 409 already_applied', async () => {
    qrepo.replaceItems.mockRejectedValueOnce(new QueueReplaceConflict('already_applied', 'Это перераспознавание уже применено'));
    await expect(applyQueueReocr({ ownerUserId: 1, invoiceId: 10, userId: 1, fingerprint: FP }))
      .rejects.toMatchObject({ status: 409, code: 'already_applied' });
  });

  it('отказы до транзакции: чужая, одобрена, отправлена, нет результата, уже применено, каталог изменился, нет сумм', async () => {
    const run = () => applyQueueReocr({ ownerUserId: 1, invoiceId: 10, userId: 1, fingerprint: FP });

    repo.getById.mockResolvedValueOnce(invoice({ owner_user_id: 2 }) as never);
    await expect(run()).rejects.toMatchObject({ status: 404, code: 'not_found' });

    repo.getById.mockResolvedValueOnce(invoice({ approved_for_1c: 1 }) as never);
    await expect(run()).rejects.toMatchObject({ status: 409, code: 'not_in_queue' });

    repo.getById.mockResolvedValueOnce(invoice({ sent_at: '2026-09-20 12:00:00', status: 'sent_to_1c' }) as never);
    await expect(run()).rejects.toMatchObject({ status: 409, code: 'not_in_queue' });

    qrepo.latestReocr.mockResolvedValueOnce(resultRow({ status: 'error' }) as never);
    await expect(run()).rejects.toMatchObject({ code: 'no_result' });

    qrepo.latestReocr.mockResolvedValueOnce(resultRow({ applied_at: '2026-09-29 12:00:00' }) as never);
    await expect(run()).rejects.toMatchObject({ code: 'already_applied' });

    qrepo.existingGuids.mockResolvedValueOnce(new Set());
    await expect(run()).rejects.toMatchObject({ code: 'catalog_changed' });

    qrepo.latestReocr.mockResolvedValueOnce(resultRow({ proposed: JSON.stringify([prop('Батон', { total: null, onec_guid: 'g-bread' })]) }) as never);
    await expect(run()).rejects.toMatchObject({ code: 'no_totals' });

    expect(qrepo.replaceItems).not.toHaveBeenCalled();
    expect(repo.recalculateTotal).not.toHaveBeenCalled();
  });

  it('поменялись ставки НДС строк — отметка «ставка сверена» снимается; НДС шапки не меняется', async () => {
    qrepo.latestReocr.mockResolvedValue(resultRow({ proposed: JSON.stringify([{ ...proposed[0], vat_rate: 20 }]) }) as never);
    await applyQueueReocr({ ownerUserId: 1, invoiceId: 10, userId: 1, fingerprint: FP });
    expect(repo.resetAttrChecks).toHaveBeenCalledWith(10, ['vat_rate']);
    expect(repo.recalculateTotal).toHaveBeenCalledWith(10, { keepVat: true });
    expect(vi.mocked(logEdit).mock.calls.every(c => c[0].entity !== 'invoice')).toBe(true);
  });

  it('ReocrApplyError несёт HTTP-статус и код', () => {
    const e = new ReocrApplyError(409, 'stale', 'x');
    expect(e).toMatchObject({ status: 409, code: 'stale', message: 'x' });
  });
});

describe('revertQueueReocr — вернуть строки, какие были до применения', () => {
  // Сейчас в накладной — строки перераспознавания; в replaced — прежние, полностью.
  const applied = [cur(21, 'Батон 0,4кг', { quantity: 24, unit: 'кг', price: 50, total: 1200, onec_guid: 'g-bread', vat_rate: 10 })];
  const FP = linesFingerprint(applied);
  const previous = [{
    id: 1, invoice_id: 10, original_name: 'Батон 0,4кг', mapped_name: 'Ламинария', quantity: 60, unit: 'шт', price: 20, total: 1200,
    vat_rate: 20, mapping_confidence: 0.7, onec_guid: null, row_no: 3, name_overridden: 1,
    raw_quantity: 60, raw_unit: 'шт', raw_price: 20, raw_total: 1200, conv_factor: null, conv_note: null,
    conv_source: 'legacy_stored', qty_flag: null, qty_flag_note: null,
  }];

  function appliedRow(p: Record<string, unknown> = {}) {
    return {
      id: 5, owner_user_id: 1, invoice_id: 10, status: 'done', model: 'm', pages: 1, lines_fingerprint: 'x',
      summary: null, header_diff: '[]', proposed: '[]', replaced: JSON.stringify(previous), error: null,
      started_by: 1, started_at: '', finished_at: '', applied_at: '2026-09-30 12:00:00', applied_by: 1, ...p,
    };
  }

  beforeEach(() => {
    repo.getById.mockResolvedValue(invoice({ total_sum: 1200, vat_sum: 200 }) as never);
    qrepo.latestReocr.mockResolvedValue(appliedRow() as never);
    qrepo.replaceItems.mockImplementation(async (opts) => {
      opts.check({ status: 'processed', approved_for_1c: 0, sent_at: null, duplicate_of: null }, applied as never);
      return { before: applied as never };
    });
    repo.recalculateTotal.mockResolvedValue();
  });

  it('прежние строки возвращаются как были (своё название, № строки, «как в накладной»), шапка не пишется', async () => {
    const r = await revertQueueReocr({ ownerUserId: 1, invoiceId: 10, userId: 1, fingerprint: FP });
    expect(r).toMatchObject({ deleted: 1, inserted: 1 });
    const call = qrepo.replaceItems.mock.calls[0][0];
    expect(call).toMatchObject({ resultId: 5, mark: 'revert' });
    expect(call.lines).toEqual([{
      original_name: 'Батон 0,4кг', mapped_name: 'Ламинария', quantity: 60, unit: 'шт', price: 20, total: 1200, vat_rate: 20,
      mapping_confidence: 0.7, onec_guid: null, row_no: 3, name_overridden: 1,
      conversion: {
        raw_quantity: 60, raw_unit: 'шт', raw_price: 20, raw_total: 1200, conv_factor: null, conv_note: null,
        conv_source: 'legacy_stored', qty_flag: null, qty_flag_note: null,
      },
    }]);
    expect(repo.recalculateTotal).toHaveBeenCalledWith(10, { keepVat: true });
    expect(repo.resetAttrChecks).toHaveBeenCalledWith(10, ['vat_rate']); // ставка 10 → 20
    expect(vi.mocked(logEdit)).toHaveBeenCalledWith(expect.objectContaining({
      invoiceId: 10, entity: 'item', field: 'reocr_revert',
      oldValue: { lines: 1, sum: 1200, reocr_result: 5 }, newValue: { lines: 1, sum: 1200 },
    }));
  });

  it('не применялось, уже возвращено, нечего возвращать, одобрена, строки меняли → отказ', async () => {
    const run = (fp = FP) => revertQueueReocr({ ownerUserId: 1, invoiceId: 10, userId: 1, fingerprint: fp });

    qrepo.latestReocr.mockResolvedValueOnce(appliedRow({ applied_at: null }) as never);
    await expect(run()).rejects.toMatchObject({ status: 409, code: 'not_applied' });
    qrepo.latestReocr.mockResolvedValueOnce(appliedRow({ status: 'reverted' }) as never);
    await expect(run()).rejects.toMatchObject({ code: 'not_applied' });
    qrepo.latestReocr.mockResolvedValueOnce(appliedRow({ replaced: null }) as never);
    await expect(run()).rejects.toMatchObject({ code: 'nothing_saved' });
    repo.getById.mockResolvedValueOnce(invoice({ approved_for_1c: 1 }) as never);
    await expect(run()).rejects.toMatchObject({ status: 409, code: 'not_in_queue' });
    repo.getById.mockResolvedValueOnce(invoice({ owner_user_id: 3 }) as never);
    await expect(run()).rejects.toMatchObject({ status: 404 });
    expect(qrepo.replaceItems).not.toHaveBeenCalled();

    await expect(run('0'.repeat(64))).rejects.toMatchObject({ status: 409, code: 'stale' });
    qrepo.replaceItems.mockRejectedValueOnce(new QueueReplaceConflict('already_reverted', 'Прежние строки уже возвращены'));
    await expect(run()).rejects.toMatchObject({ status: 409, code: 'already_reverted' });
    expect(repo.recalculateTotal).not.toHaveBeenCalled();
  });
});

describe('reconcileInterruptedReocr — после перезапуска «идёт» не висит вечно', () => {
  it('своё перераспознавание не идёт → строки «идёт» закрываются ошибкой; идёт → не трогаем', async () => {
    qrepo.markInterruptedReocr.mockResolvedValue(2);
    expect(await reconcileInterruptedReocr(1)).toBe(2);
    expect(qrepo.markInterruptedReocr).toHaveBeenCalledWith(1);

    qrepo.markInterruptedReocr.mockClear();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const { done } = startQueueJob({ kind: 'reocr', ownerUserId: 1, startedBy: 1, invoiceIds: [1], worker: async (id) => { await gate; return { invoice_id: id, status: 'done' }; } });
    expect(await reconcileInterruptedReocr(1)).toBe(0);
    expect(qrepo.markInterruptedReocr).not.toHaveBeenCalled();
    // У другой компании своего прогона нет — её оборванные строки закрываются.
    await reconcileInterruptedReocr(2);
    expect(qrepo.markInterruptedReocr).toHaveBeenCalledWith(2);
    release();
    await done;
  });
});
