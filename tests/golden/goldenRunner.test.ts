import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Всё внешнее замокано: БД (любое обращение — падение теста), репозитории,
// OCR и Claude. Проверяем оркестрацию: последовательность, пропуски, ошибки,
// и что прогон НИЧЕГО не пишет в накладные.
const cfg = vi.hoisted(() => ({ processedDir: '', failedDir: '', inboxDir: '', anthropicApiKey: '' }));
const ocr = vi.hoisted(() => ({ preprocessImage: vi.fn(), analyze: vi.fn() }));

vi.mock('../../src/config', () => ({ config: cfg }));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/database/db', () => ({
  getDb: () => { throw new Error('прогон эталонов не должен ходить в БД мимо репозиториев'); },
}));
vi.mock('../../src/database/repositories/invoiceRepo', () => ({
  invoiceRepo: {
    getById: vi.fn(),
    getItems: vi.fn(),
    getAnalyzerConfig: vi.fn(),
    // Пишущие методы — чтобы убедиться, что их не зовут.
    updateInvoiceData: vi.fn(),
    updateStatus: vi.fn(),
    deleteItems: vi.fn(),
    addItem: vi.fn(),
    recalculateTotal: vi.fn(),
    updateItemFields: vi.fn(),
    updateItemQuantity: vi.fn(),
    resetAttrChecks: vi.fn(),
  },
}));
vi.mock('../../src/database/repositories/goldenRepo', () => ({
  goldenRepo: {
    createRun: vi.fn(),
    saveProgress: vi.fn(),
    finishRun: vi.fn(),
    listRunning: vi.fn(),
    markInterrupted: vi.fn(),
  },
}));
vi.mock('../../src/ocr/ocrManager', () => ({
  OcrManager: class { preprocessImage = ocr.preprocessImage; },
}));
vi.mock('../../src/learning/supplierMemory', () => ({ buildSupplierMemory: vi.fn(async () => 'ПАМЯТКА') }));
vi.mock('../../src/ocr/claudeApiAnalyzer', () => ({
  analyzeImageWithVerification: ocr.analyze,
}));

import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';
import { goldenRepo } from '../../src/database/repositories/goldenRepo';
import type { ParsedInvoiceData } from '../../src/ocr/types';
import {
  evaluateGoldenInvoice,
  executeGoldenRun,
  startGoldenRun,
  activeGoldenRunId,
  reconcileInterruptedGoldenRuns,
  summarizeGoldenResults,
  locateGoldenPhoto,
  GoldenRunBusyError,
  GoldenRunConfigError,
  type GoldenRunnerDeps,
} from '../../src/golden/goldenRunner';

const repo = vi.mocked(invoiceRepo);
const golden = vi.mocked(goldenRepo);
const ctx = { apiKey: 'sk-test', model: 'claude-sonnet-5' };

function invoice(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    owner_user_id: 1,
    file_name: `photo-${id}.jpg`,
    file_path: `/data/processed/photo-${id}.jpg`,
    invoice_number: `N-${id}`,
    invoice_date: '2026-09-15',
    supplier: 'ООО Ромашка',
    supplier_inn: '7724357632',
    total_sum: 2200,
    vat_sum: 200,
    ...overrides,
  };
}

const truthItems = [
  { id: 1, quantity: 60, unit: 'шт', price: 20, total: 1200, vat_rate: 10 },
  { id: 2, quantity: 10, unit: 'шт', price: 100, total: 1000, vat_rate: 10 },
];

function reading(overrides: Partial<ParsedInvoiceData> = {}, id = 1): ParsedInvoiceData {
  return {
    invoice_number: `N-${id}`,
    invoice_date: '2026-09-15',
    supplier_inn: '7724357632',
    total_sum: 2200,
    vat_sum: 200,
    items: [
      { name: 'Батон', quantity: 60, unit: 'шт', price: 20, total: 1200, vat_rate: 10 },
      { name: 'Молоко', quantity: 10, unit: 'шт', price: 100, total: 1000, vat_rate: 10 },
    ],
    ...overrides,
  };
}

function deps(overrides: Partial<GoldenRunnerDeps> = {}): GoldenRunnerDeps {
  return {
    recognize: vi.fn(async (_p: string) => reading()),
    locatePhoto: vi.fn((name: string) => `/photos/${name}`),
    ...overrides,
  };
}

function expectNoInvoiceWrites(): void {
  for (const m of ['updateInvoiceData', 'updateStatus', 'deleteItems', 'addItem', 'recalculateTotal',
    'updateItemFields', 'updateItemQuantity', 'resetAttrChecks'] as const) {
    expect(repo[m], `invoiceRepo.${m} не должен вызываться`).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  repo.getById.mockImplementation(async (id: number) => invoice(id) as never);
  repo.getItems.mockResolvedValue(truthItems as never);
  repo.getAnalyzerConfig.mockResolvedValue({ anthropic_api_key: 'sk-db', claude_model: 'claude-sonnet-5' } as never);
  golden.createRun.mockResolvedValue(42);
  golden.saveProgress.mockResolvedValue();
  golden.finishRun.mockResolvedValue();
  golden.listRunning.mockResolvedValue([]);
  golden.markInterrupted.mockResolvedValue();
});

describe('evaluateGoldenInvoice — одна накладная', () => {
  it('совпало всё → ok, сравнение с «правдой» из накладной', async () => {
    const d = deps();
    const r = await evaluateGoldenInvoice(1, ctx, d);
    expect(r.status).toBe('ok');
    expect(r.invoice_number).toBe('N-1');
    expect(r.compare?.summary.all_ok).toBe(true);
    expect(d.recognize).toHaveBeenCalledWith('/photos/photo-1.jpg', ctx);
    expectNoInvoiceWrites();
  });

  it('НДС прочитан иначе → mismatch с полем vat_sum', async () => {
    const r = await evaluateGoldenInvoice(1, ctx, deps({ recognize: vi.fn(async () => reading({ vat_sum: 366.67 })) }));
    expect(r.status).toBe('mismatch');
    expect(r.compare?.summary.failed).toEqual(['vat_sum']);
  });

  it('правда строк — raw_* («как в накладной»), когда они есть', async () => {
    repo.getItems.mockResolvedValue([
      { id: 1, quantity: 24, unit: 'кг', price: 50, total: 1200, raw_quantity: 60, raw_unit: 'шт', raw_price: 20, raw_total: 1200 },
      { id: 2, quantity: 10, unit: 'шт', price: 100, total: 1000, raw_quantity: 10, raw_unit: 'шт', raw_price: 100, raw_total: 1000 },
    ] as never);
    const r = await evaluateGoldenInvoice(1, ctx, deps());
    expect(r.status).toBe('ok');
  });

  it('многостраничная → skipped multipage, Claude не вызывается', async () => {
    repo.getById.mockResolvedValue(invoice(1, { file_name: 'p1.jpg, p2.jpg' }) as never);
    const d = deps();
    const r = await evaluateGoldenInvoice(1, ctx, d);
    expect(r).toMatchObject({ status: 'skipped', reason: 'multipage' });
    expect(d.recognize).not.toHaveBeenCalled();
  });

  it('фото нет на диске → skipped no_photo', async () => {
    const d = deps({ locatePhoto: vi.fn(() => null) });
    const r = await evaluateGoldenInvoice(1, ctx, d);
    expect(r).toMatchObject({ status: 'skipped', reason: 'no_photo' });
    expect(d.recognize).not.toHaveBeenCalled();
  });

  it('пустой file_name → skipped no_photo', async () => {
    repo.getById.mockResolvedValue(invoice(1, { file_name: '' }) as never);
    const r = await evaluateGoldenInvoice(1, ctx, deps());
    expect(r).toMatchObject({ status: 'skipped', reason: 'no_photo' });
  });

  it('накладной больше нет → skipped not_found', async () => {
    repo.getById.mockResolvedValue(undefined as never);
    const r = await evaluateGoldenInvoice(1, ctx, deps());
    expect(r).toMatchObject({ status: 'skipped', reason: 'not_found' });
  });

  it('распознавание упало → status error с текстом, без исключения наружу', async () => {
    const r = await evaluateGoldenInvoice(1, ctx, deps({
      recognize: vi.fn(async () => { throw new Error('Claude API error: 529 overloaded'); }),
    }));
    expect(r.status).toBe('error');
    expect(r.error).toContain('529');
  });
});

describe('executeGoldenRun — прогон целиком', () => {
  it('строго последовательно, ошибка одной накладной не останавливает прогон, итог записан', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const recognize = vi.fn(async (p: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      if (p.includes('photo-2')) throw new Error('boom');
      if (p.includes('photo-3')) return reading({ invoice_number: 'N-X' }, 3);
      const id = Number(p.match(/photo-(\d+)/)![1]);
      return reading({}, id);
    });
    repo.getById.mockImplementation(async (id: number) =>
      (id === 4 ? invoice(4, { file_name: 'a.jpg,b.jpg' }) : invoice(id)) as never);

    const summary = await executeGoldenRun(42, [1, 2, 3, 4], ctx, deps({ recognize }));

    expect(maxInFlight).toBe(1);
    expect(recognize).toHaveBeenCalledTimes(3); // 4-я — многостраничная, без Claude
    expect(golden.saveProgress).toHaveBeenCalledTimes(4);
    expect(golden.finishRun).toHaveBeenCalledTimes(1);
    const [runId, status, finalSummary, results] = golden.finishRun.mock.calls[0];
    expect(runId).toBe(42);
    expect(status).toBe('done');
    expect((results as Array<{ status: string }>).map(r => r.status)).toEqual(['ok', 'error', 'mismatch', 'skipped']);
    expect(finalSummary).toMatchObject({
      planned: 4, processed: 4, compared: 2, ok: 1, mismatch: 1, errors: 1, skipped: 1,
      skipped_reasons: { multipage: 1 },
      header_ok: 9, header_total: 10, header_accuracy: 0.9,
      field_failures: { invoice_number: 1 },
      model: 'claude-sonnet-5',
    });
    expect(summary).toEqual(finalSummary);
    expectNoInvoiceWrites();
  });

  it('сбой записи прогресса не останавливает прогон', async () => {
    golden.saveProgress.mockRejectedValue(new Error('lock wait timeout'));
    await executeGoldenRun(42, [1, 2], ctx, deps());
    expect(golden.finishRun).toHaveBeenCalledWith(42, 'done', expect.anything(), expect.anything());
  });

  it('не удалось записать итог → повторная попытка со статусом error', async () => {
    golden.finishRun.mockRejectedValueOnce(new Error('connection lost')).mockResolvedValueOnce();
    const summary = await executeGoldenRun(42, [1], ctx, deps());
    expect(golden.finishRun).toHaveBeenCalledTimes(2);
    expect(golden.finishRun.mock.calls[1][1]).toBe('error');
    expect(summary.error).toContain('connection lost');
  });
});

describe('startGoldenRun — запуск из API', () => {
  it('возвращается сразу, не дожидаясь распознавания; второй запуск — занято; после конца — свободно', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const recognize = vi.fn(async () => { await gate; return reading(); });

    const started = await startGoldenRun({ ownerUserId: 1, startedBy: 1, invoiceIds: [1] }, deps({ recognize }));
    expect(started).toEqual({ runId: 42, model: 'claude-sonnet-5' });
    expect(golden.createRun).toHaveBeenCalledWith(expect.objectContaining({
      ownerUserId: 1, startedBy: 1, model: 'claude-sonnet-5',
    }));
    expect(activeGoldenRunId()).toBe(42);
    expect(golden.finishRun).not.toHaveBeenCalled(); // распознавание ещё висит

    await expect(startGoldenRun({ ownerUserId: 1, startedBy: 1, invoiceIds: [1] }, deps()))
      .rejects.toBeInstanceOf(GoldenRunBusyError);

    release();
    await vi.waitFor(() => expect(activeGoldenRunId()).toBeNull());
    expect(golden.finishRun).toHaveBeenCalledWith(42, 'done', expect.anything(), expect.anything());
  });

  it('модель и ключ — из analyzer_config, один раз на прогон', async () => {
    const recognize = vi.fn(async () => reading());
    await startGoldenRun({ ownerUserId: 1, startedBy: 1, invoiceIds: [1, 2] }, deps({ recognize }));
    await vi.waitFor(() => expect(activeGoldenRunId()).toBeNull());
    expect(recognize).toHaveBeenCalledTimes(2);
    for (const call of recognize.mock.calls) {
      expect(call[1]).toEqual({ apiKey: 'sk-db', model: 'claude-sonnet-5', memory: 'ПАМЯТКА' });
    }
    expect(repo.getAnalyzerConfig).toHaveBeenCalledTimes(1);
  });

  it('нет API-ключа → GoldenRunConfigError, прогон не создаётся, замок снят', async () => {
    repo.getAnalyzerConfig.mockResolvedValue({ anthropic_api_key: null, claude_model: 'claude-sonnet-5' } as never);
    await expect(startGoldenRun({ ownerUserId: 1, startedBy: 1, invoiceIds: [1] }, deps()))
      .rejects.toBeInstanceOf(GoldenRunConfigError);
    expect(golden.createRun).not.toHaveBeenCalled();
    expect(activeGoldenRunId()).toBeNull();
  });
});

describe('reconcileInterruptedGoldenRuns', () => {
  it('«running», которого нет в этом процессе, помечается ошибкой с сохранением прогресса', async () => {
    golden.listRunning.mockResolvedValue([{ id: 5, summary: '{"planned":3,"processed":1}' }]);
    expect(await reconcileInterruptedGoldenRuns()).toBe(1);
    expect(golden.markInterrupted).toHaveBeenCalledWith(5, expect.objectContaining({
      planned: 3, processed: 1, error: expect.stringContaining('прерван'),
    }));
  });

  it('гонка: пока читали «running», начался новый прогон (INSERT без id) — свежую строку не трогает', async () => {
    let releaseList!: (rows: Array<{ id: number; summary: string | null }>) => void;
    golden.listRunning.mockImplementation(() => new Promise(r => { releaseList = r; }));
    let releaseCreate!: (id: number) => void;
    golden.createRun.mockImplementation(() => new Promise(r => { releaseCreate = r; }));

    const reconciling = reconcileInterruptedGoldenRuns();          // ждёт listRunning
    const starting = startGoldenRun({ ownerUserId: 1, startedBy: 1, invoiceIds: [1] }, deps());
    await vi.waitFor(() => expect(golden.createRun).toHaveBeenCalled()); // резерв 0, INSERT «в полёте»
    releaseList([{ id: 43, summary: null }]);                        // SELECT успел увидеть новую строку
    expect(await reconciling).toBe(0);
    expect(golden.markInterrupted).not.toHaveBeenCalled();

    releaseCreate(43);
    await starting;
    await vi.waitFor(() => expect(activeGoldenRunId()).toBeNull());
  });

  it('идущий в этом процессе прогон не трогает', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    await startGoldenRun({ ownerUserId: 1, startedBy: 1, invoiceIds: [1] },
      deps({ recognize: vi.fn(async () => { await gate; return reading(); }) }));
    golden.listRunning.mockResolvedValue([{ id: 42, summary: null }]);
    expect(await reconcileInterruptedGoldenRuns()).toBe(0);
    expect(golden.markInterrupted).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(activeGoldenRunId()).toBeNull());
  });
});

describe('summarizeGoldenResults', () => {
  it('пустой прогон: точность null, счётчики нули', () => {
    expect(summarizeGoldenResults([], 3, 'm')).toMatchObject({
      planned: 3, processed: 0, compared: 0, header_accuracy: null, items_accuracy: null, field_failures: {},
    });
  });
});

describe('production-путь распознавания (по умолчанию)', () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-runner-'));
    cfg.processedDir = path.join(root, 'processed');
    cfg.failedDir = path.join(root, 'failed');
    cfg.inboxDir = path.join(root, 'inbox');
    for (const d of [cfg.processedDir, cfg.failedDir, cfg.inboxDir]) fs.mkdirSync(d);
  });
  afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('фото ищется processed → failed → inbox; путь с каталогами не принимается', () => {
    fs.writeFileSync(path.join(cfg.failedDir, 'f.jpg'), 'x');
    fs.writeFileSync(path.join(cfg.inboxDir, 'f.jpg'), 'x');
    expect(locateGoldenPhoto('f.jpg', null)).toBe(path.join(cfg.failedDir, 'f.jpg'));
    fs.writeFileSync(path.join(cfg.processedDir, 'f.jpg'), 'x');
    expect(locateGoldenPhoto('f.jpg', null)).toBe(path.join(cfg.processedDir, 'f.jpg'));
    expect(locateGoldenPhoto('../processed/f.jpg', null)).toBeNull();
    expect(locateGoldenPhoto('nope.jpg', null)).toBeNull();
  });

  it('запасной путь — file_path из строки, только если имя совпадает', () => {
    const elsewhere = path.join(root, 'elsewhere.jpg');
    fs.writeFileSync(elsewhere, 'x');
    expect(locateGoldenPhoto('elsewhere.jpg', elsewhere)).toBe(elsewhere);
    expect(locateGoldenPhoto('other.jpg', elsewhere)).toBeNull();
  });

  it('предобработка как в проде, Claude — без каталога 1С, временный файл удаляется', async () => {
    fs.writeFileSync(path.join(cfg.processedDir, 'photo-1.jpg'), 'jpeg');
    const tmp = path.join(root, 'ocr_tmp.jpg');
    ocr.preprocessImage.mockImplementation(async () => { fs.writeFileSync(tmp, 'prepared'); return tmp; });
    ocr.analyze.mockResolvedValue({ success: true, data: reading() });

    const r = await evaluateGoldenInvoice(1, ctx);

    expect(r.status).toBe('ok');
    expect(ocr.preprocessImage).toHaveBeenCalledWith(path.join(cfg.processedDir, 'photo-1.jpg'));
    expect(ocr.analyze).toHaveBeenCalledTimes(1);
    // (картинка, ключ, модель, каталог, памятка) — каталог 1С не передаётся,
    // памятка — из контекста прогона (в этом ctx её нет).
    expect(ocr.analyze.mock.calls[0]).toEqual([tmp, 'sk-test', 'claude-sonnet-5', undefined, undefined]);
    expect(fs.existsSync(tmp)).toBe(false);
  });

  it('Claude вернул ошибку → status error с текстом ошибки', async () => {
    fs.writeFileSync(path.join(cfg.processedDir, 'photo-1.jpg'), 'jpeg');
    ocr.preprocessImage.mockImplementation(async (p: string) => p);
    ocr.analyze.mockResolvedValue({ success: false, error: 'Claude API error: timeout' });
    const r = await evaluateGoldenInvoice(1, ctx);
    expect(r.status).toBe('error');
    expect(r.error).toContain('timeout');
    // Предобработка вернула исходник — его удалять нельзя.
    expect(fs.existsSync(path.join(cfg.processedDir, 'photo-1.jpg'))).toBe(true);
  });
});
