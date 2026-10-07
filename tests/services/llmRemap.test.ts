import { AiUnavailableError } from '../../src/ai/errors';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// «LLM-маппинг» накладной, вынесенный из POST /api/invoices/:id/llm-remap.
// Всё внешнее замокано: БД (любое обращение мимо репозиториев — падение),
// репозитории, Claude, пересчёт строки. Проверяем: ответы маршрута прежние,
// проверки v2 (подтверждённое правило, «не это», атрибуты) работают при
// mapping_v2 и не работают без него.

const h = vi.hoisted(() => ({
  flags: { units_v2: false, mapping_v2: true } as Record<string, boolean>,
  mapItems: vi.fn(),
  cfg: { anthropicApiKey: '' },
}));

vi.mock('../../src/config', () => ({ config: h.cfg }));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/database/db', () => ({
  getDb: () => { throw new Error('llmRemap не должен ходить в БД мимо репозиториев'); },
}));
vi.mock('../../src/database/repositories/invoiceRepo', () => ({
  invoiceRepo: {
    getItems: vi.fn(),
    getItemById: vi.fn(),
    getAnalyzerConfig: vi.fn(),
    updateItemMapping: vi.fn(),
    updateItemFields: vi.fn(),
    recalculateTotal: vi.fn(),
  },
}));
vi.mock('../../src/database/repositories/mappingRepo', () => ({
  mappingRepo: { getByScannedName: vi.fn(), update: vi.fn(), getConfirmed: vi.fn() },
}));
vi.mock('../../src/database/repositories/onecNomenclatureRepo', () => ({
  onecNomenclatureRepo: { listItems: vi.fn(), getByGuid: vi.fn() },
}));
vi.mock('../../src/database/repositories/rejectionRepo', () => ({
  rejectionRepo: { guidsFor: vi.fn() },
}));
vi.mock('../../src/database/repositories/editLogRepo', () => ({ logEdit: vi.fn() }));
vi.mock('../../src/ocr/claudeApiAnalyzer', () => ({ mapItemsWithAi: h.mapItems }));
vi.mock('../../src/services/itemReconvert', () => ({ reconvertStoredItem: vi.fn() }));
vi.mock('../../src/services/engineFlags', () => ({ getEngineFlags: vi.fn(async () => h.flags) }));

import { llmRemapInvoice, EMPTY_CATALOG_ERROR, NO_API_KEY_ERROR } from '../../src/services/llmRemap';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';
import { mappingRepo } from '../../src/database/repositories/mappingRepo';
import { onecNomenclatureRepo } from '../../src/database/repositories/onecNomenclatureRepo';
import { rejectionRepo } from '../../src/database/repositories/rejectionRepo';
import { logEdit } from '../../src/database/repositories/editLogRepo';
import { reconvertStoredItem } from '../../src/services/itemReconvert';
import type { Invoice } from '../../src/database/repositories/invoiceRepo';

const repo = vi.mocked(invoiceRepo);
const maps = vi.mocked(mappingRepo);
const onec = vi.mocked(onecNomenclatureRepo);
const rej = vi.mocked(rejectionRepo);

const INVOICE = { id: 7, owner_user_id: 3, supplier: 'ООО Альфа', supplier_inn: '7724357632' } as unknown as Invoice;

const CATALOG = [
  { guid: 'g-milk1', name: 'Молоко 3,2% 1л', unit: 'шт' },
  { guid: 'g-milk2', name: 'Молоко 3,2% 2л', unit: 'шт' },
  { guid: 'g-bread', name: 'Батон нарезной', unit: 'шт' },
];

function item(id: number, p: Record<string, unknown> = {}) {
  return {
    id, invoice_id: 7, original_name: `Товар ${id}`, mapped_name: null, quantity: 2, unit: 'шт', price: 50, total: 100,
    vat_rate: 10, mapping_confidence: 0, onec_guid: null, row_no: null, name_overridden: 0, conv_source: 'legacy_stored',
    ...p,
  };
}

function hit(guid: string, extra: Record<string, unknown> = {}) {
  const c = CATALOG.find(x => x.guid === guid)!;
  return { catalog_idx: CATALOG.indexOf(c) + 1, guid, name: c.name, pack_size: null, unit_override: null, ...extra };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.flags = { units_v2: false, mapping_v2: true };
  repo.getAnalyzerConfig.mockResolvedValue({ mode: 'gpt', gpt_model: 'gpt-6.1-sol', anthropic_api_key: null, claude_model: 'claude-sonnet-5' } as never);
  onec.listItems.mockResolvedValue(CATALOG.map(c => ({ ...c, code: null, full_name: null, parent_guid: null, is_folder: 0, is_weighted: 0, synced_at: '' })) as never);
  onec.getByGuid.mockImplementation(async (guid: string) => {
    const c = CATALOG.find(x => x.guid === guid);
    return c ? ({ ...c } as never) : undefined;
  });
  maps.getConfirmed.mockResolvedValue(undefined);
  maps.getByScannedName.mockResolvedValue(undefined);
  rej.guidsFor.mockResolvedValue(new Set());
  repo.recalculateTotal.mockResolvedValue();
});

describe('ответы — как у прежнего маршрута', () => {
  it('нечего сопоставлять → requested 0 с сообщением, Claude не вызывается', async () => {
    repo.getItems.mockResolvedValue([item(1, { onec_guid: 'g-bread', mapping_confidence: 1 })] as never);
    const out = await llmRemapInvoice(INVOICE, { includeAll: false });
    expect(out).toEqual({
      ok: true, guarded: 0,
      data: { id: 7, requested: 0, matched: 0, changed: 0, repacked: 0, total: 1, message: 'Нет несопоставленных товаров' },
    });
    expect(h.mapItems).not.toHaveBeenCalled();
  });

  it('пустой каталог → 400, режим Claude без ключа → 500, ошибка модели → 502, модель недоступна — исключение', async () => {
    repo.getItems.mockResolvedValue([item(1)] as never);
    onec.listItems.mockResolvedValueOnce([] as never);
    expect(await llmRemapInvoice(INVOICE, { includeAll: false })).toEqual({ ok: false, status: 400, error: EMPTY_CATALOG_ERROR });

    repo.getAnalyzerConfig.mockResolvedValueOnce({ mode: 'claude_api', anthropic_api_key: null, claude_model: 'm' } as never);
    expect(await llmRemapInvoice(INVOICE, { includeAll: false })).toEqual({ ok: false, status: 500, error: NO_API_KEY_ERROR });

    h.mapItems.mockResolvedValueOnce({ success: false, error: 'AI mapper error: timeout' });
    expect(await llmRemapInvoice(INVOICE, { includeAll: false })).toEqual({ ok: false, status: 502, error: 'AI mapper error: timeout' });

    // Недоступность модели пробрасывается: маршрут ответит 503, задача очереди встанет на паузу.
    h.mapItems.mockRejectedValueOnce(new AiUnavailableError('rate_limited', null));
    await expect(llmRemapInvoice(INVOICE, { includeAll: false })).rejects.toBeInstanceOf(AiUnavailableError);
  });

  it('сопоставление несопоставленных: в запрос — только строки без позиции, каталог — компании владельца', async () => {
    repo.getItems.mockResolvedValue([item(1), item(2, { onec_guid: 'g-milk1', mapping_confidence: 1 })] as never);
    h.mapItems.mockResolvedValue({ success: true, matched: new Map([['1', hit('g-bread')]]) });
    const out = await llmRemapInvoice(INVOICE, { includeAll: false });
    expect(onec.listItems).toHaveBeenCalledWith({ ownerUserId: 3, excludeFolders: true });
    expect(h.mapItems.mock.calls[0][0]).toEqual([{ key: '1', name: 'Товар 1', unit: 'шт' }]);
    expect(repo.updateItemMapping).toHaveBeenCalledWith(1, 'g-bread', 'Батон нарезной', 1.0);
    expect(repo.recalculateTotal).toHaveBeenCalledWith(7);
    expect(out).toEqual({ ok: true, guarded: 0, data: { id: 7, requested: 1, matched: 1, changed: 1, repacked: 0, coerced: 0, total: 2 } });
    expect(vi.mocked(logEdit)).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: 7, entity: 'mapping', field: 'llm_remap' }));
  });

  it('переданный каталог используется как есть — второй раз из БД не читается', async () => {
    repo.getItems.mockResolvedValue([item(1)] as never);
    h.mapItems.mockResolvedValue({ success: true, matched: new Map() });
    await llmRemapInvoice(INVOICE, { includeAll: false, catalog: CATALOG });
    expect(onec.listItems).not.toHaveBeenCalled();
    expect(h.mapItems.mock.calls[0][1]).toBe(CATALOG);
  });
});

describe('проверки v2 (mapping_v2)', () => {
  it('подтверждённое человеком правило важнее выбора ИИ', async () => {
    repo.getItems.mockResolvedValue([item(1, { original_name: 'Молоко 3,2% 1л' })] as never);
    h.mapItems.mockResolvedValue({ success: true, matched: new Map([['1', hit('g-milk2')]]) });
    maps.getConfirmed.mockResolvedValue({ id: 40, onec_guid: 'g-milk1', confirmed_at: '2026-09-01', pack_size: null, pack_unit: null } as never);
    const out = await llmRemapInvoice(INVOICE, { includeAll: false });
    expect(repo.updateItemMapping).toHaveBeenCalledWith(1, 'g-milk1', 'Молоко 3,2% 1л', 1.0);
    expect(out.ok && out.guarded).toBe(1);
    expect(out.ok && out.data.matched).toBe(1);
  });

  it('ИИ согласен с подтверждённым правилом — это не «отклонено»', async () => {
    repo.getItems.mockResolvedValue([item(1, { original_name: 'Молоко 3,2% 1л' })] as never);
    h.mapItems.mockResolvedValue({ success: true, matched: new Map([['1', hit('g-milk1')]]) });
    maps.getConfirmed.mockResolvedValue({ id: 40, onec_guid: 'g-milk1', confirmed_at: '2026-09-01', pack_size: null, pack_unit: null } as never);
    const out = await llmRemapInvoice(INVOICE, { includeAll: false });
    expect(repo.updateItemMapping).toHaveBeenCalledWith(1, 'g-milk1', 'Молоко 3,2% 1л', 1.0);
    expect(out.ok && out.guarded).toBe(0);
  });

  describe('упаковка при подтверждённом правиле (units_v2)', () => {
    beforeEach(() => {
      h.flags = { units_v2: true, mapping_v2: true };
      repo.getItems.mockResolvedValue([item(1, { original_name: 'Молоко 3,2% 1л', conv_source: 'same' })] as never);
      repo.getItemById.mockResolvedValue({ ...item(1, { original_name: 'Молоко 3,2% 1л', conv_source: 'same' }) } as never);
      vi.mocked(reconvertStoredItem).mockResolvedValue(true);
    });
    const packOf = () => vi.mocked(reconvertStoredItem).mock.calls[0][2]?.pack;

    it('та же позиция, у правила своя упаковка — упаковка правила, а не подсказка ИИ', async () => {
      h.mapItems.mockResolvedValue({ success: true, matched: new Map([['1', hit('g-milk1', { pack_size: 6, unit_override: 'шт' })]]) });
      maps.getConfirmed.mockResolvedValue({ id: 40, onec_guid: 'g-milk1', confirmed_at: '2026-09-01', pack_size: 12, pack_unit: 'шт' } as never);
      await llmRemapInvoice(INVOICE, { includeAll: false });
      expect(packOf()).toEqual({ size: 12, unit: 'шт' });
    });

    it('та же позиция, у правила упаковки нет — подсказка ИИ остаётся', async () => {
      h.mapItems.mockResolvedValue({ success: true, matched: new Map([['1', hit('g-milk1', { pack_size: 6, unit_override: 'шт' })]]) });
      maps.getConfirmed.mockResolvedValue({ id: 40, onec_guid: 'g-milk1', confirmed_at: '2026-09-01', pack_size: null, pack_unit: null } as never);
      await llmRemapInvoice(INVOICE, { includeAll: false });
      expect(packOf()).toEqual({ size: 6, unit: 'шт' });
    });

    it('ИИ выбрал другую позицию — его упаковка не переносится на позицию правила', async () => {
      h.mapItems.mockResolvedValue({ success: true, matched: new Map([['1', hit('g-milk2', { pack_size: 6, unit_override: 'шт' })]]) });
      maps.getConfirmed.mockResolvedValue({ id: 40, onec_guid: 'g-milk1', confirmed_at: '2026-09-01', pack_size: null, pack_unit: null } as never);
      await llmRemapInvoice(INVOICE, { includeAll: false });
      expect(vi.mocked(reconvertStoredItem).mock.calls[0][2]).toMatchObject({ onecGuid: 'g-milk1', pack: null });
    });
  });

  it('позиция, отклонённая человеком («не это»), не ставится', async () => {
    repo.getItems.mockResolvedValue([item(1, { original_name: 'Батон' })] as never);
    h.mapItems.mockResolvedValue({ success: true, matched: new Map([['1', hit('g-bread')]]) });
    rej.guidsFor.mockResolvedValue(new Set(['g-bread']));
    const out = await llmRemapInvoice(INVOICE, { includeAll: false });
    expect(repo.updateItemMapping).not.toHaveBeenCalled();
    expect(out).toEqual({ ok: true, guarded: 1, data: expect.objectContaining({ requested: 1, matched: 0, changed: 0 }) });
  });

  it('противоречие по объёму («1л» ≠ «2л») — выбор ИИ не ставится', async () => {
    repo.getItems.mockResolvedValue([item(1, { original_name: 'Молоко 3,2% 1л' })] as never);
    h.mapItems.mockResolvedValue({ success: true, matched: new Map([['1', hit('g-milk2')]]) });
    const out = await llmRemapInvoice(INVOICE, { includeAll: false });
    expect(repo.updateItemMapping).not.toHaveBeenCalled();
    expect(out.ok && out.guarded).toBe(1);
  });

  it('при выключенном mapping_v2 — прежнее поведение: выбор ИИ ставится как есть', async () => {
    h.flags = { units_v2: false, mapping_v2: false };
    repo.getItems.mockResolvedValue([item(1, { original_name: 'Молоко 3,2% 1л' })] as never);
    h.mapItems.mockResolvedValue({ success: true, matched: new Map([['1', hit('g-milk2')]]) });
    rej.guidsFor.mockResolvedValue(new Set(['g-milk2']));
    const out = await llmRemapInvoice(INVOICE, { includeAll: false });
    expect(repo.updateItemMapping).toHaveBeenCalledWith(1, 'g-milk2', 'Молоко 3,2% 2л', 1.0);
    expect(maps.getConfirmed).not.toHaveBeenCalled();
    expect(out.ok && out.guarded).toBe(0);
  });

  it('includeAll: ИИ ничего не нашёл для сопоставленной строки — позиция остаётся', async () => {
    repo.getItems.mockResolvedValue([item(1, { onec_guid: 'g-bread', mapping_confidence: 1 })] as never);
    h.mapItems.mockResolvedValue({ success: true, matched: new Map() });
    const out = await llmRemapInvoice(INVOICE, { includeAll: true });
    expect(repo.updateItemMapping).not.toHaveBeenCalled();
    expect(out.ok && out.data).toMatchObject({ requested: 1, matched: 0, changed: 0 });
  });
});

describe('массовый подбор: своё название человека, НДС шапки', () => {
  it('skipNameOverridden — строки со своим названием для 1С ИИ не трогает', async () => {
    repo.getItems.mockResolvedValue([item(1, { name_overridden: 1, mapped_name: 'Ламинария' }), item(2)] as never);
    h.mapItems.mockResolvedValue({ success: true, matched: new Map() });
    await llmRemapInvoice(INVOICE, { includeAll: false, skipNameOverridden: true });
    expect(h.mapItems.mock.calls[0][0]).toEqual([{ key: '2', name: 'Товар 2', unit: 'шт' }]);
  });

  it('keepHeaderVat — итог пересчитывается без НДС шапки; маршрут одной накладной — как раньше', async () => {
    repo.getItems.mockResolvedValue([item(1)] as never);
    h.mapItems.mockResolvedValue({ success: true, matched: new Map([['1', hit('g-bread')]]) });
    await llmRemapInvoice(INVOICE, { includeAll: false, keepHeaderVat: true });
    expect(repo.recalculateTotal).toHaveBeenLastCalledWith(7, { keepVat: true });
    await llmRemapInvoice(INVOICE, { includeAll: false });
    expect(repo.recalculateTotal).toHaveBeenLastCalledWith(7);
  });
});

describe('units_v2: строки до v2 не пересчитываются автоматически (правило 22)', () => {
  it('reconvertStoredItem зовётся без force для legacy_stored', async () => {
    h.flags = { units_v2: true, mapping_v2: true };
    repo.getItems.mockResolvedValue([item(1)] as never);
    repo.getItemById.mockResolvedValue({ ...item(1), onec_guid: 'g-bread' } as never);
    h.mapItems.mockResolvedValue({ success: true, matched: new Map([['1', hit('g-bread')]]) });
    vi.mocked(reconvertStoredItem).mockResolvedValue(false);
    await llmRemapInvoice(INVOICE, { includeAll: false });
    expect(vi.mocked(reconvertStoredItem)).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1 }), INVOICE,
      expect.objectContaining({ onecGuid: 'g-bread', force: false }),
    );
  });
});
