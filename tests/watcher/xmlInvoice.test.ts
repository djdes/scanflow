import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// БД-свободный тест ветки XML в FileWatcher: все репозитории и внешние сервисы
// замоканы, inbox/processed/failed — временные каталоги, XML — настоящие
// фикстуры (tests/xml/fixtures). Распознавание (OcrManager) при XML вызываться
// не должно вовсе — заглушка бросает.
vi.mock('../../src/config', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/config')>();
  const nodeFs = await import('node:fs');
  const nodeOs = await import('node:os');
  const nodePath = await import('node:path');
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'sf-xml-watcher-'));
  const mk = (name: string) => { const d = nodePath.join(root, name); nodeFs.mkdirSync(d); return d; };
  return {
    config: {
      ...real.config,
      inboxDir: mk('inbox'), processedDir: mk('processed'), failedDir: mk('failed'),
      dryRun: false, anthropicApiKey: '',
    },
  };
});
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/database/db', () => ({
  getDb: () => { throw new Error('тест ветки XML не должен ходить в БД мимо замоканных репозиториев'); },
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
    getTelegramMessageIds: vi.fn(),
  },
}));
vi.mock('../../src/database/repositories/userRepo', () => ({ userRepo: { firstUserId: vi.fn(), getTelegramConfig: vi.fn() } }));
vi.mock('../../src/database/repositories/mappingRepo', () => ({
  mappingRepo: { getConfirmed: vi.fn(), touchUsage: vi.fn(), getByScannedName: vi.fn(), upsertLearned: vi.fn(), upsert: vi.fn() },
}));
vi.mock('../../src/database/repositories/onecNomenclatureRepo', () => ({ onecNomenclatureRepo: { listItems: vi.fn(), getByGuid: vi.fn() } }));
vi.mock('../../src/automation/qualityGate', () => ({ evaluateInvoiceQuality: vi.fn() }));
vi.mock('../../src/ocr/claudeApiAnalyzer', () => ({ mapItemsWithClaudeApi: vi.fn() }));
vi.mock('../../src/utils/mailer', () => ({ sendErrorEmail: vi.fn(async () => {}) }));
vi.mock('../../src/services/resolveSupplierName', () => ({
  resolveSupplierName: vi.fn(async (raw: string | null | undefined) => (raw ? `canon:${raw}` : undefined)),
}));
vi.mock('../../src/services/supplierMatch', () => ({ linkApprovedSupplier: vi.fn(async () => ({ match: null, supplier: null })) }));
vi.mock('../../src/database/repositories/snapshotRepo', () => ({ snapshotRepo: { record: vi.fn() } }));
vi.mock('../../src/services/lineConversion', () => ({
  // Пересчёт — своя зона (tests/services/lineConversion); здесь важно, ЧТО в него пришло.
  convertInvoiceLine: vi.fn(async (a: { raw: { quantity: number | null; unit: string | null; price: number | null; total: number | null } }) => ({
    quantity: a.raw.quantity, unit: a.raw.unit, price: a.raw.price, total: a.raw.total,
    conversion: { raw_quantity: a.raw.quantity, raw_unit: a.raw.unit, raw_price: a.raw.price, raw_total: a.raw.total, conv_source: 'same' },
  })),
}));
vi.mock('../../src/services/engineFlags', () => ({ getEngineFlags: vi.fn(async () => ({ mapping_v2: true, units_v2: true })) }));
vi.mock('../../src/database/repositories/rejectionRepo', () => ({ rejectionRepo: { guidsFor: vi.fn(async () => new Set()) } }));
vi.mock('../../src/parser/itemSanitizer', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/parser/itemSanitizer')>();
  return {
    ...real,
    sanitizeItemArithmetic: vi.fn(real.sanitizeItemArithmetic),
    sanitizeInvoiceVat: vi.fn(real.sanitizeInvoiceVat),
    sanitizeItemVatPerItem: vi.fn(real.sanitizeItemVatPerItem),
  };
});
vi.mock('../../src/notifications/events', () => ({ emit: vi.fn(async () => {}), emitElevatedPricesIfAny: vi.fn(async () => {}) }));
vi.mock('../../src/notifications/telegram/telegramClient', () => ({ editMessageText: vi.fn() }));
vi.mock('../../src/services/autoSendSber', () => ({ autoSendSberForInvoice: vi.fn() }));
vi.mock('../../src/database/repositories/ocrCorrectionRepo', () => ({ ocrCorrectionRepo: { apply: vi.fn(async (d: unknown) => d) } }));
vi.mock('../../src/database/repositories/webhookConfigRepo', () => ({ webhookConfigRepo: { autoSend1cEnabled: vi.fn(async () => false) } }));
vi.mock('../../src/database/repositories/supplierMappingRepo', () => ({
  makeSupplierKey: (inn: string | null, name: string | null) => inn || name || null,
}));

import { FileWatcher } from '../../src/watcher/fileWatcher';
import { config } from '../../src/config';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';
import { mappingRepo } from '../../src/database/repositories/mappingRepo';
import { onecNomenclatureRepo } from '../../src/database/repositories/onecNomenclatureRepo';
import { evaluateInvoiceQuality } from '../../src/automation/qualityGate';
import { mapItemsWithClaudeApi } from '../../src/ocr/claudeApiAnalyzer';
import { sendErrorEmail } from '../../src/utils/mailer';
import { linkApprovedSupplier } from '../../src/services/supplierMatch';
import { snapshotRepo } from '../../src/database/repositories/snapshotRepo';
import { convertInvoiceLine } from '../../src/services/lineConversion';
import { sanitizeInvoiceVat, sanitizeItemArithmetic, sanitizeItemVatPerItem } from '../../src/parser/itemSanitizer';
import { emit } from '../../src/notifications/events';
import { ocrCorrectionRepo } from '../../src/database/repositories/ocrCorrectionRepo';
import { FnsXmlError } from '../../src/xml';

const repo = vi.mocked(invoiceRepo);
const FIXTURES = path.join(__dirname, '..', 'xml', 'fixtures');

const noOcr = () => { throw new Error('распознавание не должно вызываться для XML'); };
const stubOcr = {
  recognizeWithClaudeApi: vi.fn(noOcr), recognizeHybrid: vi.fn(noOcr), recognize: vi.fn(noOcr),
  recognizeWithEngine: vi.fn(noOcr), analyzeMultiPageText: vi.fn(noOcr),
};
const mapper = {
  mapSupplierOverride: vi.fn(async () => null),
  map: vi.fn(async (name: string) => ({
    original_name: name, mapped_name: name, onec_guid: null, confidence: 0, source: 'none',
    mapping_id: null, pack_size: null, pack_unit: null,
  })),
  invalidateCache: vi.fn(),
};

function watcher(): FileWatcher {
  return new FileWatcher(stubOcr as never, mapper as never);
}

/** Положить фикстуру в каталог под именем, как её сохранила бы загрузка. */
function put(fixture: string, dir: string, name: string): string {
  const p = path.join(dir, name);
  fs.copyFileSync(path.join(FIXTURES, fixture), p);
  return p;
}

function analyzerConfig(over: Record<string, unknown> = {}) {
  return {
    mode: 'claude_api', anthropic_api_key: null, claude_model: 'claude-sonnet-5', llm_mapper_enabled: false,
    auto_send_1c: false, auto_send_sber: false, projectsflow_token: null, projectsflow_project_id: null,
    dadata_api_key: null, ...over,
  };
}

let uniq = 0;
beforeEach(() => {
  vi.clearAllMocks();
  uniq++;
  repo.findByFileHash.mockResolvedValue(undefined);
  repo.create.mockImplementation(async (d: { file_name: string; owner_user_id?: number | null }) => ({
    id: 101, file_name: d.file_name, owner_user_id: d.owner_user_id ?? null, invoice_number: null, supplier: null, total_sum: null,
  }) as never);
  repo.getAnalyzerConfig.mockResolvedValue(analyzerConfig() as never);
  repo.findDuplicateOriginal.mockResolvedValue(undefined);
  repo.getById.mockImplementation(async (id: number) => ({
    id, owner_user_id: 5, invoice_number: 'ТД-01234', supplier: 'x', total_sum: 7740.25, items_total_mismatch: 0,
  }) as never);
  vi.mocked(evaluateInvoiceQuality).mockResolvedValue({ allowed: true, score: 100, reasons: [], settings: {} } as never);
  vi.mocked(mappingRepo.getConfirmed).mockResolvedValue(undefined as never);
  vi.mocked(mappingRepo.getByScannedName).mockResolvedValue(undefined as never);
});

describe('FileWatcher.processFile — УПД в XML', () => {
  it('без распознавания: шапка, дубли, строки как в документе, итог, снимок, привязка, уведомления; файл в processed/', async () => {
    const name = `upload-${uniq}.xml`;
    const inbox = put('upd_503_ul_win1251.xml', config.inboxDir, name);

    const id = await watcher().processFile(inbox, name, undefined, { source: 'web', ownerUserId: 5 });

    expect(id).toBe(101);
    for (const m of Object.values(stubOcr)) expect(m).not.toHaveBeenCalled();
    expect(ocrCorrectionRepo.apply).not.toHaveBeenCalled();              // в XML нет ошибок чтения
    expect(sanitizeInvoiceVat).not.toHaveBeenCalled();                  // данные документа не «чинятся»
    expect(sanitizeItemVatPerItem).not.toHaveBeenCalled();
    expect(sanitizeItemArithmetic).not.toHaveBeenCalled();

    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ file_name: name, owner_user_id: 5, file_hash: expect.any(String) }));
    expect(repo.updateStatus.mock.calls.map(c => c[1])).toEqual(['ocr_processing', 'parsing', 'processed']);
    expect(repo.updateInvoiceData).toHaveBeenCalledWith(101, {
      raw_text: expect.stringContaining('"source": "xml"'), ocr_engine: 'xml_upd',
    });
    expect(repo.updateInvoiceData).toHaveBeenCalledWith(101, expect.objectContaining({
      invoice_number: 'ТД-01234',
      invoice_date: '2026-09-28',
      invoice_type: 'упд',
      supplier: 'canon:Общество с ограниченной ответственностью "Северное молоко"',
      supplier_inn: '7701234560',
      supplier_kpp: '770101001',
      supplier_bik: '044525225',
      supplier_account: '40702810938000012345',
      total_sum: 7740.25,
      vat_sum: 734.75,
    }));
    expect(repo.findDuplicateOriginal).toHaveBeenCalledWith(
      101, 'ТД-01234', '7701234560', 'ООО "Северное молоко"', '2026-09-28', 7740.25, 30,
      expect.any(Array), { account: '40702810938000012345', bic: '044525225' },
    );

    // Пересчёт единиц — от значений документа как есть (правило 22), без подсказки ИИ.
    expect(convertInvoiceLine).toHaveBeenCalledTimes(4);
    expect(vi.mocked(convertInvoiceLine).mock.calls[0][0]).toMatchObject({
      ownerUserId: 5, supplierKey: '7701234560', name: 'Молоко питьевое ультрапастеризованное 3,2% 1 л',
      raw: { quantity: 24, unit: 'шт', price: 88, total: 2112 }, llmPackHint: null,
    });
    expect(repo.addItem).toHaveBeenCalledTimes(4);
    expect(repo.addItem.mock.calls.map(c => [c[0].original_name, c[0].quantity, c[0].unit, c[0].total, c[0].vat_rate, c[0].row_no])).toEqual([
      ['Молоко питьевое ультрапастеризованное 3,2% 1 л', 24, 'шт', 2112, 10, 1],
      ['Сыр "Российский" 50%', 5.25, 'кг', 3580.5, 10, 2],
      ['Салфетки бумажные 24х24 (х100/2400)', 3, 'упак', 347.7, 22, 3],
      ['Масло сливочное 82,5% 180 г', 10, 'шт', 1700.05, 10, 4],
    ]);
    expect(repo.addItem.mock.calls[0][0]).toMatchObject({ invoice_id: 101, conversion: expect.objectContaining({ raw_quantity: 24 }) });
    expect(mapper.map).toHaveBeenCalledTimes(4);
    expect(mapper.map).toHaveBeenCalledWith('Сыр "Российский" 50%', 5, {
      supplierInn: '7701234560', supplierName: 'Общество с ограниченной ответственностью "Северное молоко"',
    });

    expect(repo.recalculateTotal).toHaveBeenCalledWith(101, { keepVat: true });  // НДС документа не подменяется
    expect(snapshotRepo.record).toHaveBeenCalledWith(101, 'recognized');
    expect(linkApprovedSupplier).toHaveBeenCalledWith(101, { exactInn: true });
    expect(vi.mocked(emit).mock.calls.map(c => c[0])).toEqual(['photo_uploaded', 'invoice_recognized']);
    expect(evaluateInvoiceQuality).toHaveBeenCalledWith(101);                 // автопилот — те же ворота
    expect(sendErrorEmail).not.toHaveBeenCalled();

    expect(fs.existsSync(inbox)).toBe(false);
    expect(fs.existsSync(path.join(config.processedDir, name))).toBe(true);
  });

  it('LLM-маппер включён: выбор ИИ — отдельным запросом сопоставления, остальные строки — обычный подбор', async () => {
    repo.getAnalyzerConfig.mockResolvedValue(analyzerConfig({ llm_mapper_enabled: true, anthropic_api_key: 'sk-test' }) as never);
    vi.mocked(onecNomenclatureRepo.listItems).mockResolvedValue([
      { guid: 'g-milk', name: 'Молоко 3,2% 1л', unit: 'шт' },
      { guid: 'g-cheese', name: 'Сыр Российский', unit: 'кг' },
    ] as never);
    vi.mocked(mapItemsWithClaudeApi).mockResolvedValue({
      success: true,
      matched: new Map([['0', { catalog_idx: 1, guid: 'g-milk', name: 'Молоко 3,2% 1л', pack_size: null, unit_override: null }]]),
    });
    const name = `upload-${uniq}.xml`;
    const inbox = put('upd_503_ul_win1251.xml', config.inboxDir, name);

    await watcher().processFile(inbox, name, undefined, { source: 'email', ownerUserId: 5 });

    expect(mapItemsWithClaudeApi).toHaveBeenCalledTimes(1);
    const [items, catalog, apiKey] = vi.mocked(mapItemsWithClaudeApi).mock.calls[0];
    expect(items.map(i => i.key)).toEqual(['0', '1', '2', '3']);
    expect(items[1]).toEqual({ key: '1', name: 'Сыр "Российский" 50%', unit: 'кг' });
    expect(catalog).toHaveLength(2);
    expect(apiKey).toBe('sk-test');
    expect(repo.addItem.mock.calls[0][0]).toMatchObject({ onec_guid: 'g-milk', mapped_name: 'Молоко 3,2% 1л', mapping_confidence: 1 });
    expect(mappingRepo.upsertLearned).toHaveBeenCalledWith(expect.objectContaining({ onec_guid: 'g-milk', source: 'llm' }), 5);
    expect(mapper.map).toHaveBeenCalledTimes(3);   // строки 2–4
  });

  it('сбой запроса сопоставления — не ошибка накладной, остаётся обычный подбор', async () => {
    repo.getAnalyzerConfig.mockResolvedValue(analyzerConfig({ llm_mapper_enabled: true, anthropic_api_key: 'sk-test' }) as never);
    vi.mocked(onecNomenclatureRepo.listItems).mockResolvedValue([{ guid: 'g', name: 'X', unit: 'шт' }] as never);
    vi.mocked(mapItemsWithClaudeApi).mockRejectedValue(new Error('529 overloaded'));
    const name = `upload-${uniq}.xml`;
    const inbox = put('torg12_551_win1251.xml', config.inboxDir, name);

    const id = await watcher().processFile(inbox, name, undefined, { ownerUserId: 5 });

    expect(id).toBe(101);
    expect(mapper.map).toHaveBeenCalledTimes(3);
    expect(repo.updateStatus).toHaveBeenLastCalledWith(101, 'processed');
    expect(repo.updateInvoiceData).toHaveBeenCalledWith(101, expect.objectContaining({ ocr_engine: 'xml_torg12' }));
  });

  it('дубль уже загруженной накладной — отметка «дубликат», строки не сохраняются, файл в processed/', async () => {
    repo.findDuplicateOriginal.mockResolvedValue({ id: 55, duplicate_score: 0.97, duplicate_reasons: '["номер","ИНН"]' } as never);
    const name = `upload-${uniq}.xml`;
    const inbox = put('upd_501_ip_utf8.xml', config.inboxDir, name);

    const id = await watcher().processFile(inbox, name, undefined, { ownerUserId: 5 });

    expect(id).toBe(101);
    expect(repo.markAsDuplicate).toHaveBeenCalledWith(101, 55, 0.97, '["номер","ИНН"]');
    expect(repo.addItem).not.toHaveBeenCalled();
    expect(repo.updateStatus.mock.calls.map(c => c[1])).toEqual(['ocr_processing', 'parsing']);
    expect(fs.existsSync(path.join(config.processedDir, name))).toBe(true);
  });

  it('повреждённый XML — статус «ошибка» с понятным текстом, файл в failed/, письма администратору нет', async () => {
    const name = `upload-${uniq}.xml`;
    const inbox = put('upd_malformed.xml', config.inboxDir, name);

    await expect(watcher().processFile(inbox, name, undefined, { ownerUserId: 5 })).rejects.toBeInstanceOf(FnsXmlError);

    expect(repo.updateStatus).toHaveBeenLastCalledWith(101, 'error', expect.stringMatching(/^Файл не читается как XML: /));
    expect(vi.mocked(emit).mock.calls.map(c => c[0])).toEqual(['photo_uploaded', 'recognition_error']);
    expect(sendErrorEmail).not.toHaveBeenCalled();
    expect(repo.addItem).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(config.failedDir, name))).toBe(true);
    for (const m of Object.values(stubOcr)) expect(m).not.toHaveBeenCalled();
  });

  it('тот же файл второй раз — дедуп по SHA-256 до разбора (как у фото)', async () => {
    repo.findByFileHash.mockResolvedValue({ id: 77 } as never);
    const name = `upload-${uniq}.xml`;
    const inbox = put('upd_503_ul_win1251.xml', config.inboxDir, name);

    const id = await watcher().processFile(inbox, name, undefined, { ownerUserId: 5 });

    expect(id).toBe(77);
    expect(repo.create).not.toHaveBeenCalled();
    expect(repo.updateInvoiceData).not.toHaveBeenCalled();
  });
});

describe('FileWatcher.reprocessInvoice — «Перечитать XML»', () => {
  const xmlInvoice = (over: Record<string, unknown> = {}) => ({
    id: 101, owner_user_id: 5, file_name: `upload-r${uniq}.xml`, file_path: '/nowhere/upload.xml',
    ocr_engine: 'xml_upd', duplicate_of: null, ...over,
  });

  it('разбирает исходный XML заново (без OCR), переписывает строки, снимает «дубликат»; файл из failed/ → processed/', async () => {
    const inv = xmlInvoice({ duplicate_of: 55 });
    repo.getById.mockResolvedValue(inv as never);
    const failedPath = put('upd_503_ul_win1251.xml', config.failedDir, inv.file_name);

    await watcher().reprocessInvoice(101);

    for (const m of Object.values(stubOcr)) expect(m).not.toHaveBeenCalled();
    expect(repo.resetAttrChecks).toHaveBeenCalledWith(101);
    expect(repo.deleteItems).toHaveBeenCalledWith(101);
    expect(repo.updateInvoiceData).toHaveBeenCalledWith(101, expect.objectContaining({
      invoice_number: 'ТД-01234', ocr_engine: 'xml_upd', raw_text: expect.stringContaining('"source": "xml"'),
    }));
    expect(repo.unmarkAsDuplicate).toHaveBeenCalledWith(101);
    expect(repo.addItem).toHaveBeenCalledTimes(4);
    expect(repo.recalculateTotal).toHaveBeenCalledWith(101, { keepVat: true });
    expect(linkApprovedSupplier).toHaveBeenCalledWith(101, { exactInn: true });
    expect(repo.updateStatus).toHaveBeenCalledWith(101, 'processed');
    expect(fs.existsSync(failedPath)).toBe(false);
    expect(fs.existsSync(path.join(config.processedDir, inv.file_name))).toBe(true);
  });

  it('файла нет — понятная ошибка, накладная не тронута', async () => {
    repo.getById.mockResolvedValue(xmlInvoice({ file_name: 'upload-gone.xml' }) as never);
    await expect(watcher().reprocessInvoice(101)).rejects.toThrow(/Исходный XML-файл накладной не найден/);
    expect(repo.deleteItems).not.toHaveBeenCalled();
    expect(repo.updateInvoiceData).not.toHaveBeenCalled();
  });

  it('битый файл — ошибка разбора ДО изменений', async () => {
    const inv = xmlInvoice();
    repo.getById.mockResolvedValue(inv as never);
    put('upd_malformed.xml', config.processedDir, inv.file_name);
    await expect(watcher().reprocessInvoice(101)).rejects.toBeInstanceOf(FnsXmlError);
    expect(repo.deleteItems).not.toHaveBeenCalled();
  });
});

describe('фото и накладная из XML не склеиваются', () => {
  it('фото с тем же номером не вклеивается «страницей» в XML-накладную — идёт своей накладной', async () => {
    stubOcr.recognizeWithClaudeApi.mockImplementationOnce(async () => ({
      text: '{}', engine: 'claude_api',
      structured: {
        invoice_number: 'ТД-01234', invoice_date: '2026-09-28', supplier: 'ООО Северное молоко', supplier_inn: '7701234560',
        total_sum: 2112, vat_sum: 192, invoice_type: 'упд',
        items: [{ name: 'Молоко 3,2% 1л', quantity: 24, unit: 'шт', price: 88, total: 2112, vat_rate: 10, row_no: 1 }],
      },
    }) as never);
    repo.create.mockResolvedValue({ id: 102, file_name: 'upload-photo.jpg', owner_user_id: 5 } as never);
    repo.findRecentByNumber.mockResolvedValue({
      id: 90, file_name: 'upload-1.xml', ocr_engine: 'xml_upd', invoice_number: 'ТД-01234', owner_user_id: 5,
    } as never);
    const name = `upload-photo-${uniq}.jpg`;
    const photo = path.join(config.inboxDir, name);
    fs.writeFileSync(photo, 'jpeg-bytes');

    const id = await watcher().processFile(photo, name, undefined, { ownerUserId: 5 });

    expect(id).toBe(102);
    expect(repo.appendFileName).not.toHaveBeenCalled();
    expect(repo.recordMerge).not.toHaveBeenCalled();
    expect(repo.delete).not.toHaveBeenCalled();
    expect(repo.findDuplicateOriginal).toHaveBeenCalled();   // дальше — обычный путь фото и детектор дублей
    expect(repo.addItem).toHaveBeenCalledWith(expect.objectContaining({ invoice_id: 102 }));
    expect(linkApprovedSupplier).toHaveBeenCalledWith(102);  // у фото ИНН не «точный»
  });

  it('«дофоткать» страницу к XML-накладной нельзя', async () => {
    repo.getById.mockResolvedValue({ id: 101, owner_user_id: 5, file_name: 'upload-1.xml', ocr_engine: 'xml_upd' } as never);
    await expect(watcher().addPageToInvoice(101, '/tmp/p2.jpg', 'p2.jpg')).rejects.toThrow(/XML document/);
    expect(stubOcr.recognizeWithClaudeApi).not.toHaveBeenCalled();
  });
});
