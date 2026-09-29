import { describe, it, expect, vi, beforeEach } from 'vitest';

// «Новые товары» (пакет v2, п.12): сопоставление группы и связывание после
// выгрузки каталога — БД-свободно, репозитории замоканы.
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/database/db', () => ({
  getDb: () => { throw new Error('действия «Новых товаров» ходят в БД только через репозитории'); },
}));
vi.mock('../../src/database/repositories/invoiceRepo', () => ({
  invoiceRepo: { updateItemMapping: vi.fn(), getItemById: vi.fn(), recalculateTotal: vi.fn() },
}));
vi.mock('../../src/database/repositories/mappingRepo', () => ({ mappingRepo: { confirm: vi.fn() } }));
vi.mock('../../src/database/repositories/rejectionRepo', () => ({ rejectionRepo: { clear: vi.fn() } }));
vi.mock('../../src/database/repositories/onecNomenclatureRepo', () => ({ onecNomenclatureRepo: { listItems: vi.fn() } }));
vi.mock('../../src/database/repositories/newItemRequestRepo', () => ({
  newItemRequestRepo: { unsentUnmappedLines: vi.fn(), listPending: vi.fn(), markCreated: vi.fn() },
}));
vi.mock('../../src/database/repositories/editLogRepo', () => ({ logEdit: vi.fn() }));
vi.mock('../../src/services/itemReconvert', () => ({ reconvertStoredItem: vi.fn() }));

import { mapNewItemGroup, linkCreatedNewItems } from '../../src/services/newItemActions';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';
import { mappingRepo } from '../../src/database/repositories/mappingRepo';
import { rejectionRepo } from '../../src/database/repositories/rejectionRepo';
import { onecNomenclatureRepo } from '../../src/database/repositories/onecNomenclatureRepo';
import { newItemRequestRepo } from '../../src/database/repositories/newItemRequestRepo';
import { logEdit } from '../../src/database/repositories/editLogRepo';
import { reconvertStoredItem } from '../../src/services/itemReconvert';
import { newItemGroupKey } from '../../src/services/newItems';

const repo = vi.mocked(invoiceRepo);
const reqRepo = vi.mocked(newItemRequestRepo);
const reconvert = vi.mocked(reconvertStoredItem);

const KEY = newItemGroupKey('Батон нарезной 0,4кг');
const base = { mapped_name: 'Батон нарезной', name_overridden: 0, unit: 'шт', raw_unit: 'шт', price: 32.2, raw_price: 32.2, supplier: 'ООО Хлеб', supplier_inn: '7700000000' };
const LINES = [
  { ...base, id: 101, invoice_id: 11, original_name: 'Батон нарезной 0,4кг' },
  { ...base, id: 102, invoice_id: 11, original_name: 'БАТОН НАРЕЗНОЙ 0,4 КГ' },
  { ...base, id: 103, invoice_id: 12, original_name: 'Батон нарезной 0,4кг', mapped_name: 'Батон нарезной 0,4 кг', name_overridden: 1 },
  { ...base, id: 104, invoice_id: 13, original_name: 'Сахар 1кг' },
];

beforeEach(() => {
  vi.clearAllMocks();
  reqRepo.unsentUnmappedLines.mockResolvedValue(LINES as never);
  repo.getItemById.mockImplementation(async (id: number) => ({ id, invoice_id: 11, original_name: 'x', conv_source: 'name' }) as never);
  reconvert.mockResolvedValue(true);
});

describe('mapNewItemGroup', () => {
  it('только строки группы: позиция 1С, подтверждённые правила, пересчёт, итоги, журнал', async () => {
    const r = await mapNewItemGroup({
      ownerUserId: 2, nameKey: KEY, onecGuid: 'g-1', catalogName: 'Батон нарезной', userId: 2, source: 'new_items_page', requestId: 7,
    });
    expect(r).toEqual({ lines: 3, invoices: 2, rules: 2, reconverted: 3 });
    expect(reqRepo.unsentUnmappedLines).toHaveBeenCalledWith(2);
    expect(repo.updateItemMapping.mock.calls.map(c => c[0])).toEqual([101, 102, 103]);
    expect(repo.updateItemMapping).toHaveBeenCalledWith(101, 'g-1', 'Батон нарезной', 1);
    // правило — на каждое написание один раз, подтверждённое человеком
    expect(mappingRepo.confirm).toHaveBeenCalledTimes(2);
    expect(mappingRepo.confirm).toHaveBeenCalledWith('Батон нарезной 0,4кг', 'g-1', 'Батон нарезной', 2, 2);
    expect(mappingRepo.confirm).toHaveBeenCalledWith('БАТОН НАРЕЗНОЙ 0,4 КГ', 'g-1', 'Батон нарезной', 2, 2);
    expect(rejectionRepo.clear).toHaveBeenCalledWith(2, KEY, 'g-1');
    // пересчёт от «как в накладной» в единицу позиции — через reconvertStoredItem
    expect(reconvert).toHaveBeenCalledTimes(3);
    expect(reconvert.mock.calls[0][1]).toEqual({ owner_user_id: 2, supplier_inn: '7700000000', supplier: 'ООО Хлеб' });
    expect(reconvert.mock.calls[0][2]).toEqual({ onecGuid: 'g-1', mappedName: 'Батон нарезной' });
    expect(repo.recalculateTotal.mock.calls.map(c => c[0])).toEqual([11, 12]);
    expect(logEdit).toHaveBeenCalledTimes(3);
    expect(vi.mocked(logEdit).mock.calls[0][0]).toMatchObject({
      ownerUserId: 2, userId: 2, invoiceId: 11, itemId: 101, entity: 'mapping', field: 'new_item_map', newValue: 'g-1',
      context: { name_key: KEY, source: 'new_items_page', request_id: 7 },
    });
  });

  it('сбой пересчёта одной строки не валит группу', async () => {
    reconvert.mockRejectedValueOnce(new Error('boom'));
    const r = await mapNewItemGroup({ ownerUserId: 2, nameKey: KEY, onecGuid: 'g-1', catalogName: 'Батон', userId: 2, source: 'new_items_page' });
    expect(r.lines).toBe(3);
    expect(r.reconverted).toBe(2);
    expect(repo.recalculateTotal).toHaveBeenCalledTimes(2);
  });

  it('нет строк группы — ничего не пишется', async () => {
    const r = await mapNewItemGroup({ ownerUserId: 2, nameKey: 'нет такого', onecGuid: 'g-1', catalogName: 'Батон', userId: 2, source: 'new_items_page' });
    expect(r).toEqual({ lines: 0, invoices: 0, rules: 0, reconverted: 0 });
    expect(repo.updateItemMapping).not.toHaveBeenCalled();
    expect(mappingRepo.confirm).not.toHaveBeenCalled();
  });
});

describe('linkCreatedNewItems — после выгрузки каталога', () => {
  const pending = [
    { id: 7, owner_user_id: 2, name_key: KEY, name: 'Батон нарезной 0,4 кг', unit: 'шт', parent_guid: null, status: 'pending', onec_guid: null },
    { id: 8, owner_user_id: 2, name_key: 'сахар', name: 'Сахар-песок', unit: 'кг', parent_guid: null, status: 'pending', onec_guid: null },
  ];

  it('позиция появилась → заявка «создано», строки группы сопоставлены, кэш подбора сброшен', async () => {
    reqRepo.listPending.mockResolvedValue(pending as never);
    vi.mocked(onecNomenclatureRepo.listItems).mockResolvedValue([
      { guid: 'new-1', name: 'батон нарезной 0,4 кг', unit: 'шт', is_folder: 0 },
      { guid: 'other', name: 'Сахар', unit: 'кг', is_folder: 0 },
    ] as never);
    reqRepo.markCreated.mockResolvedValue(true);
    const mapper = { invalidateCache: vi.fn() };
    const r = await linkCreatedNewItems(2, mapper);
    expect(r).toEqual({ linked: 1, lines: 3 });
    expect(onecNomenclatureRepo.listItems).toHaveBeenCalledWith({ ownerUserId: 2, excludeFolders: true });
    expect(reqRepo.markCreated).toHaveBeenCalledWith(2, 7, 'new-1');
    expect(reqRepo.markCreated).toHaveBeenCalledTimes(1);
    expect(repo.updateItemMapping).toHaveBeenCalledWith(101, 'new-1', 'батон нарезной 0,4 кг', 1);
    // автоматическое связывание — без пользователя, но правило подтверждённое
    expect(mappingRepo.confirm).toHaveBeenCalledWith('Батон нарезной 0,4кг', 'new-1', 'батон нарезной 0,4 кг', 2, null);
    expect(vi.mocked(logEdit).mock.calls[0][0]).toMatchObject({ userId: null, context: { source: 'catalog_sync', request_id: 7 } });
    expect(mapper.invalidateCache).toHaveBeenCalledWith(2);
  });

  it('заявку уже закрыли параллельно → строки не трогаются', async () => {
    reqRepo.listPending.mockResolvedValue([pending[0]] as never);
    vi.mocked(onecNomenclatureRepo.listItems).mockResolvedValue([{ guid: 'new-1', name: 'Батон нарезной 0,4 кг', unit: 'шт', is_folder: 0 }] as never);
    reqRepo.markCreated.mockResolvedValue(false);
    expect(await linkCreatedNewItems(2)).toEqual({ linked: 0, lines: 0 });
    expect(repo.updateItemMapping).not.toHaveBeenCalled();
  });

  it('нет ждущих заявок — каталог даже не читается', async () => {
    reqRepo.listPending.mockResolvedValue([]);
    expect(await linkCreatedNewItems(2)).toEqual({ linked: 0, lines: 0 });
    expect(onecNomenclatureRepo.listItems).not.toHaveBeenCalled();
  });

  it('никогда не бросает', async () => {
    reqRepo.listPending.mockRejectedValue(new Error('db down'));
    await expect(linkCreatedNewItems(2)).resolves.toEqual({ linked: 0, lines: 0 });
    reqRepo.listPending.mockResolvedValue([pending[0]] as never);
    vi.mocked(onecNomenclatureRepo.listItems).mockResolvedValue([{ guid: 'new-1', name: 'Батон нарезной 0,4 кг', unit: 'шт', is_folder: 0 }] as never);
    reqRepo.markCreated.mockResolvedValue(true);
    repo.updateItemMapping.mockRejectedValue(new Error('lock wait timeout'));
    await expect(linkCreatedNewItems(2)).resolves.toEqual({ linked: 0, lines: 0 });
  });
});
