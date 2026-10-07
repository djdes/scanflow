import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// БД-свободный тест: модель недоступна при приёме фото → накладная ждёт (waiting_ai),
// а не падает; возобновление идёт тем же путём, что новая загрузка, с окном
// соседних страниц от времени загрузки.
vi.mock('../../src/config', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/config')>();
  const nodeFs = await import('node:fs');
  const nodeOs = await import('node:os');
  const nodePath = await import('node:path');
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'sf-waiting-ai-'));
  const mk = (name: string) => { const d = nodePath.join(root, name); nodeFs.mkdirSync(d); return d; };
  return {
    config: {
      ...real.config,
      inboxDir: mk('inbox'), processedDir: mk('processed'), failedDir: mk('failed'),
      dryRun: false, anthropicApiKey: '',
    },
  };
});
vi.mock('../../src/utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../src/database/db', () => ({
  getDb: () => { throw new Error('тест не должен ходить в БД мимо замоканных репозиториев'); },
}));
vi.mock('../../src/ocr/ocrManager', () => ({ OcrManager: class {} }));
vi.mock('../../src/database/repositories/invoiceRepo', () => ({
  DuplicateFileHashError: class DuplicateFileHashError extends Error {},
  invoiceRepo: {
    findByFileHash: vi.fn(), create: vi.fn(), updateStatus: vi.fn(), updateInvoiceData: vi.fn(),
    findDuplicateOriginal: vi.fn(), markAsDuplicate: vi.fn(), unmarkAsDuplicate: vi.fn(),
    getAnalyzerConfig: vi.fn(), addItem: vi.fn(), recalculateTotal: vi.fn(), getById: vi.fn(),
    getItems: vi.fn(), deleteItems: vi.fn(), resetAttrChecks: vi.fn(), approveForOneC: vi.fn(),
    findRecentByNumber: vi.fn(), findRecentByFileNamePattern: vi.fn(), findRecentBySupplier: vi.fn(),
    findMostRecentProcessedForContinuation: vi.fn(), countInFlightOlderThan: vi.fn(),
    appendFileName: vi.fn(), appendRawText: vi.fn(), recordMerge: vi.fn(), delete: vi.fn(),
    getTelegramMessageIds: vi.fn(), markWaitingAi: vi.fn(), clearErrorMessage: vi.fn(),
  },
}));
vi.mock('../../src/database/repositories/userRepo', () => ({ userRepo: { firstUserId: vi.fn(), getTelegramConfig: vi.fn() } }));
vi.mock('../../src/database/repositories/mappingRepo', () => ({
  mappingRepo: { getConfirmed: vi.fn(), touchUsage: vi.fn(), getByScannedName: vi.fn(), upsertLearned: vi.fn(), upsert: vi.fn() },
}));
vi.mock('../../src/database/repositories/onecNomenclatureRepo', () => ({ onecNomenclatureRepo: { listItems: vi.fn(async () => []), getByGuid: vi.fn() } }));
vi.mock('../../src/automation/qualityGate', () => ({ evaluateInvoiceQuality: vi.fn() }));
vi.mock('../../src/ocr/claudeApiAnalyzer', () => ({ mapItemsWithAi: vi.fn() }));
vi.mock('../../src/utils/mailer', () => ({ sendErrorEmail: vi.fn(async () => {}) }));
vi.mock('../../src/services/resolveSupplierName', () => ({ resolveSupplierName: vi.fn(async (raw: string | null | undefined) => raw ?? undefined) }));
vi.mock('../../src/services/supplierMatch', () => ({ linkApprovedSupplier: vi.fn(async () => ({ match: null, supplier: null })) }));
vi.mock('../../src/database/repositories/snapshotRepo', () => ({ snapshotRepo: { record: vi.fn() } }));
vi.mock('../../src/services/lineConversion', () => ({
  convertInvoiceLine: vi.fn(async (a: { raw: { quantity: number | null; unit: string | null; price: number | null; total: number | null } }) => ({
    quantity: a.raw.quantity, unit: a.raw.unit, price: a.raw.price, total: a.raw.total,
    conversion: { raw_quantity: a.raw.quantity, raw_unit: a.raw.unit, raw_price: a.raw.price, raw_total: a.raw.total, conv_source: 'same' },
  })),
}));
vi.mock('../../src/services/engineFlags', () => ({ getEngineFlags: vi.fn(async () => ({ mapping_v2: true, units_v2: true })) }));
vi.mock('../../src/database/repositories/rejectionRepo', () => ({ rejectionRepo: { guidsFor: vi.fn(async () => new Set()) } }));
vi.mock('../../src/notifications/events', () => ({ emit: vi.fn(async () => {}), emitElevatedPricesIfAny: vi.fn(async () => {}) }));
vi.mock('../../src/notifications/telegram/telegramClient', () => ({ editMessageText: vi.fn() }));
vi.mock('../../src/services/autoSendSber', () => ({ autoSendSberForInvoice: vi.fn() }));
vi.mock('../../src/database/repositories/ocrCorrectionRepo', () => ({ ocrCorrectionRepo: { apply: vi.fn(async (d: unknown) => d) } }));
vi.mock('../../src/database/repositories/webhookConfigRepo', () => ({ webhookConfigRepo: { autoSend1cEnabled: vi.fn(async () => false) } }));
vi.mock('../../src/database/repositories/supplierMappingRepo', () => ({ makeSupplierKey: (inn: string | null, name: string | null) => inn || name || null }));
vi.mock('../../src/services/aiOutage', () => ({ reportAiOutage: vi.fn(async () => {}) }));

import { FileWatcher } from '../../src/watcher/fileWatcher';
import { config } from '../../src/config';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';
import { evaluateInvoiceQuality } from '../../src/automation/qualityGate';
import { sendErrorEmail } from '../../src/utils/mailer';
import { emit } from '../../src/notifications/events';
import { reportAiOutage } from '../../src/services/aiOutage';
import { AiUnavailableError } from '../../src/ai/errors';

const repo = vi.mocked(invoiceRepo);
const ocr = { recognizeWithClaudeApi: vi.fn(), recognizeHybrid: vi.fn(), recognize: vi.fn(), recognizeWithEngine: vi.fn(), analyzeMultiPageText: vi.fn() };
const mapper = {
  mapSupplierOverride: vi.fn(async () => null),
  map: vi.fn(async (name: string) => ({ original_name: name, mapped_name: name, onec_guid: null, confidence: 0, source: 'none', mapping_id: null, pack_size: null, pack_unit: null })),
  invalidateCache: vi.fn(),
};
const watcher = () => new FileWatcher(ocr as never, mapper as never);

let uniq = 0;
function photoIn(dir: string): { name: string; file: string } {
  const name = `upload-wait-${++uniq}.jpg`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, `jpeg-${uniq}-${Date.now()}`);
  return { name, file };
}

const parsed = {
  invoice_type: 'торг_12', invoice_number: '424', invoice_date: '2026-10-07', supplier: 'ООО Ромашка',
  supplier_inn: null, total_sum: 100, vat_sum: null,
  items: [{ name: 'Хлеб', quantity: 2, unit: 'шт', price: 50, total: 100, vat_rate: null, row_no: 1, pack_size: null }],
};

beforeEach(() => {
  vi.clearAllMocks();
  repo.findByFileHash.mockResolvedValue(undefined);
  repo.create.mockImplementation(async (d: { file_name: string; owner_user_id?: number | null }) => ({
    id: 101, file_name: d.file_name, owner_user_id: d.owner_user_id ?? null, invoice_number: null, supplier: null, total_sum: null,
  }) as never);
  repo.getAnalyzerConfig.mockResolvedValue({ mode: 'gpt', llm_mapper_enabled: false } as never);
  repo.findDuplicateOriginal.mockResolvedValue(undefined);
  vi.mocked(evaluateInvoiceQuality).mockResolvedValue({ allowed: false, score: 0, reasons: [], settings: {} } as never);
});

describe('модель недоступна при приёме фото', () => {
  it('накладная ждёт: waiting_ai с причиной, фото в processed/, без «ошибки распознавания» и письма', async () => {
    const { name, file } = photoIn(config.inboxDir);
    ocr.recognizeWithClaudeApi.mockRejectedValue(new AiUnavailableError('rate_limited', null));

    const id = await watcher().processFile(file, name, undefined, { source: 'web', ownerUserId: 5 });

    expect(id).toBe(101);
    const processed = path.join(config.processedDir, name);
    expect(repo.markWaitingAi).toHaveBeenCalledWith(101, 'Лимит подписки ChatGPT исчерпан', processed);
    expect(fs.existsSync(processed)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(repo.updateStatus.mock.calls.map(c => c[1])).not.toContain('error');
    expect(sendErrorEmail).not.toHaveBeenCalled();
    expect(vi.mocked(emit).mock.calls.map(c => c[0])).toEqual(['photo_uploaded']);
    expect(reportAiOutage).toHaveBeenCalledTimes(1);
  });

  it('обычная ошибка распознавания — по-прежнему error и уведомление', async () => {
    const { name, file } = photoIn(config.inboxDir);
    ocr.recognizeWithClaudeApi.mockRejectedValue(new Error('GPT error: bad JSON'));
    await expect(watcher().processFile(file, name, undefined, { source: 'web', ownerUserId: 5 })).rejects.toThrow('bad JSON');
    expect(repo.updateStatus).toHaveBeenCalledWith(101, 'error', 'GPT error: bad JSON');
    expect(repo.markWaitingAi).not.toHaveBeenCalled();
    expect(vi.mocked(emit).mock.calls.map(c => c[0])).toContain('recognition_error');
  });
});

describe('resumeWaitingInvoice', () => {
  const waitingRow = (name: string) => ({
    id: 101, status: 'waiting_ai', file_name: name, file_path: path.join(config.processedDir, name),
    owner_user_id: 5, created_at: '2026-10-07 07:00:00', invoice_number: null, supplier: null, total_sum: null,
  });

  it('распознаёт тем же путём, соседние страницы — в окне от created_at; итог processed', async () => {
    const { name } = photoIn(config.processedDir);
    repo.getById
      .mockResolvedValueOnce(waitingRow(name) as never)
      .mockResolvedValue({ ...waitingRow(name), status: 'processed', items_total_mismatch: 0 } as never);
    ocr.recognizeWithClaudeApi.mockResolvedValue({ text: '{}', engine: 'gpt_api', structured: parsed });

    expect(await watcher().resumeWaitingInvoice(101)).toBe('processed');
    expect(repo.clearErrorMessage).toHaveBeenCalledWith(101);
    expect(ocr.recognizeWithClaudeApi).toHaveBeenCalledWith(path.join(config.processedDir, name), 5);
    expect(repo.findRecentByNumber).toHaveBeenCalledWith('424', 'ООО Ромашка', 10, 5, '2026-10-07 07:00:00');
    expect(repo.updateStatus).toHaveBeenCalledWith(101, 'processed');
    expect(vi.mocked(emit).mock.calls.map(c => c[0])).toContain('invoice_recognized');
    expect(vi.mocked(emit).mock.calls.map(c => c[0])).not.toContain('photo_uploaded');
  });

  it('снова недоступна — waiting, накладная ждёт дальше', async () => {
    const { name } = photoIn(config.processedDir);
    repo.getById.mockResolvedValue(waitingRow(name) as never);
    ocr.recognizeWithClaudeApi.mockRejectedValue(new AiUnavailableError('network', null));
    expect(await watcher().resumeWaitingInvoice(101)).toBe('waiting');
    expect(repo.markWaitingAi).toHaveBeenCalled();
  });

  it('не ждёт — skipped; фото нет — error', async () => {
    repo.getById.mockResolvedValueOnce({ id: 101, status: 'processed' } as never);
    expect(await watcher().resumeWaitingInvoice(101)).toBe('skipped');
    repo.getById.mockResolvedValueOnce(waitingRow('нет-такого.jpg') as never);
    expect(await watcher().resumeWaitingInvoice(101)).toBe('error');
    expect(repo.updateStatus).toHaveBeenCalledWith(101, 'error', 'Фото не найдено — загрузите заново');
  });
});
