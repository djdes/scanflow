import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// БД-свободный тест роутера «Новые товары» (пакет v2, п.12): репозитории и
// действия замоканы, чистая логика (группировка, проверка тела) — настоящая.
// Аутентификация — подставной мидлвар с нужным req.user.
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/database/db', () => ({
  getDb: () => { throw new Error('роут «Новые товары» не должен ходить в БД мимо репозиториев'); },
}));
vi.mock('../../src/database/repositories/onecNomenclatureRepo', () => ({
  onecNomenclatureRepo: { getByGuid: vi.fn(), listItems: vi.fn() },
}));
vi.mock('../../src/database/repositories/newItemRequestRepo', () => ({
  newItemRequestRepo: {
    unsentUnmappedLines: vi.fn(), list: vi.fn(), getByKey: vi.fn(), getById: vi.fn(),
    upsertPending: vi.fn(), cancel: vi.fn(), cancelPendingByKey: vi.fn(),
  },
}));
vi.mock('../../src/database/repositories/invoiceRepo', () => ({
  invoiceRepo: { setItemCustomName: vi.fn() },
}));
vi.mock('../../src/database/repositories/editLogRepo', () => ({ logEdit: vi.fn() }));
vi.mock('../../src/services/newItemActions', () => ({
  mapNewItemGroup: vi.fn(),
  unsentGroupLines: vi.fn(),
}));

import newItemsRouter, { setMapper } from '../../src/api/routes/newItems';
import { onecNomenclatureRepo } from '../../src/database/repositories/onecNomenclatureRepo';
import { newItemRequestRepo } from '../../src/database/repositories/newItemRequestRepo';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';
import { logEdit } from '../../src/database/repositories/editLogRepo';
import { mapNewItemGroup, unsentGroupLines } from '../../src/services/newItemActions';
import { newItemGroupKey } from '../../src/services/newItems';

const catalogRepo = vi.mocked(onecNomenclatureRepo);
const reqRepo = vi.mocked(newItemRequestRepo);
const mapGroup = vi.mocked(mapNewItemGroup);
const groupLines = vi.mocked(unsentGroupLines);
const mapper = { invalidateCache: vi.fn() };
setMapper(mapper as never);

const USER = { id: 2, username: 'user', role: 'user' };
const KEY = newItemGroupKey('Батон нарезной 0,4кг');

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.user = USER; next(); });
  a.use('/api/new-items', newItemsRouter);
  a.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return a;
}

const LINE = {
  id: 101, invoice_id: 11, original_name: 'Батон нарезной 0,4кг', mapped_name: 'Батон нарезной', name_overridden: 0,
  unit: 'шт', raw_unit: 'шт', price: 32.2, raw_price: 32.2, supplier: 'ООО Хлеб', supplier_inn: '7700000000',
};

beforeEach(() => {
  vi.clearAllMocks();
  reqRepo.unsentUnmappedLines.mockResolvedValue([LINE, { ...LINE, id: 102, invoice_id: 12, original_name: 'БАТОН НАРЕЗНОЙ 0,4 КГ' }]);
  reqRepo.list.mockResolvedValue([]);
  reqRepo.getByKey.mockResolvedValue(undefined);
  reqRepo.cancelPendingByKey.mockResolvedValue(false);
  groupLines.mockResolvedValue([LINE, { ...LINE, id: 102, invoice_id: 12 }]);
  catalogRepo.listItems.mockResolvedValue([
    { guid: 'item-1', name: 'Батон обычный', unit: 'шт', parent_guid: 'grp-bread', is_folder: 0 } as never,
  ]);
  reqRepo.upsertPending.mockImplementation(async (_owner, r) => ({
    id: 7, owner_user_id: 2, name_key: r.nameKey, name: r.name, unit: r.unit, parent_guid: r.parentGuid,
    status: 'pending', onec_guid: null, created_by: 2, created_at: '', updated_at: '',
  }));
});

describe('GET /api/new-items', () => {
  it('группы строк компании вызывающего + заявки без строк', async () => {
    reqRepo.list.mockResolvedValue([
      { id: 5, owner_user_id: 2, name_key: 'сахар', name: 'Сахар', unit: 'кг', parent_guid: null, status: 'pending', onec_guid: null, created_by: 2, created_at: 'c', updated_at: 'u' },
    ] as never);
    const res = await request(app()).get('/api/new-items');
    expect(res.status).toBe(200);
    expect(reqRepo.unsentUnmappedLines).toHaveBeenCalledWith(2);
    expect(reqRepo.list).toHaveBeenCalledWith(2);
    expect(res.body.count).toBe(1);
    expect(res.body.data[0]).toMatchObject({ name_key: KEY, lines: 2, invoices: [12, 11], unit: 'шт', request: null });
    expect(res.body.waiting).toEqual([{ id: 5, name_key: 'сахар', name: 'Сахар', unit: 'кг', parent_guid: null, status: 'pending', created_at: 'c', updated_at: 'u' }]);
  });
});

describe('POST /api/new-items/map', () => {
  it('позиция из каталога компании → группа сопоставлена, заявка снята, кэш подбора сброшен', async () => {
    catalogRepo.getByGuid.mockResolvedValue({ guid: 'g-1', name: 'Батон нарезной', unit: 'кг', is_folder: 0 } as never);
    reqRepo.getByKey.mockResolvedValue({ id: 7, status: 'pending' } as never);
    mapGroup.mockResolvedValue({ lines: 2, invoices: 2, rules: 2, reconverted: 2 });
    reqRepo.cancelPendingByKey.mockResolvedValue(true);
    const res = await request(app()).post('/api/new-items/map').send({ name_key: KEY, onec_guid: 'g-1' });
    expect(res.status).toBe(200);
    expect(catalogRepo.getByGuid).toHaveBeenCalledWith('g-1', 2);
    expect(mapGroup).toHaveBeenCalledWith({
      ownerUserId: 2, nameKey: KEY, onecGuid: 'g-1', catalogName: 'Батон нарезной',
      userId: 2, source: 'new_items_page', requestId: 7,
    });
    expect(reqRepo.cancelPendingByKey).toHaveBeenCalledWith(2, KEY);
    expect(mapper.invalidateCache).toHaveBeenCalledWith(2);
    expect(res.body.data).toMatchObject({ lines: 2, invoices: 2, name: 'Батон нарезной', request_cancelled: true });
  });

  it('позиции нет в каталоге компании (в т.ч. чужая) → 400, ничего не меняется', async () => {
    catalogRepo.getByGuid.mockResolvedValue(undefined);
    const res = await request(app()).post('/api/new-items/map').send({ name_key: KEY, onec_guid: 'foreign' });
    expect(res.status).toBe(400);
    expect(mapGroup).not.toHaveBeenCalled();
  });

  it('группа справочника вместо товара → 400', async () => {
    catalogRepo.getByGuid.mockResolvedValue({ guid: 'grp', name: 'Хлеб', unit: null, is_folder: 1 } as never);
    const res = await request(app()).post('/api/new-items/map').send({ name_key: KEY, onec_guid: 'grp' });
    expect(res.status).toBe(400);
    expect(mapGroup).not.toHaveBeenCalled();
  });

  it('строк группы уже нет → 404, заявка не трогается', async () => {
    catalogRepo.getByGuid.mockResolvedValue({ guid: 'g-1', name: 'Батон', unit: 'кг', is_folder: 0 } as never);
    mapGroup.mockResolvedValue({ lines: 0, invoices: 0, rules: 0, reconverted: 0 });
    const res = await request(app()).post('/api/new-items/map').send({ name_key: KEY, onec_guid: 'g-1' });
    expect(res.status).toBe(404);
    expect(reqRepo.cancelPendingByKey).not.toHaveBeenCalled();
  });

  it('кривое тело → 400', async () => {
    expect((await request(app()).post('/api/new-items/map').send({ name_key: KEY })).status).toBe(400);
    expect((await request(app()).post('/api/new-items/map').send({ onec_guid: 'g' })).status).toBe(400);
    expect(catalogRepo.getByGuid).not.toHaveBeenCalled();
  });
});

describe('POST /api/new-items/create', () => {
  const body = { name_key: KEY, name: '  Батон нарезной 0,4 кг ', unit: 'Шт.', parent_guid: 'grp-bread' };

  it('заявка сохраняется, строки группы получают название, правки — в журнал', async () => {
    const res = await request(app()).post('/api/new-items/create').send(body);
    expect(res.status).toBe(200);
    expect(groupLines).toHaveBeenCalledWith(2, KEY);
    expect(catalogRepo.listItems).toHaveBeenCalledWith({ ownerUserId: 2 });
    expect(reqRepo.upsertPending).toHaveBeenCalledWith(2, {
      nameKey: KEY, name: 'Батон нарезной 0,4 кг', unit: 'шт', parentGuid: 'grp-bread', createdBy: 2,
    });
    expect(invoiceRepo.setItemCustomName).toHaveBeenCalledTimes(2);
    expect(invoiceRepo.setItemCustomName).toHaveBeenCalledWith(101, 'Батон нарезной 0,4 кг');
    expect(invoiceRepo.setItemCustomName).toHaveBeenCalledWith(102, 'Батон нарезной 0,4 кг');
    expect(logEdit).toHaveBeenCalledTimes(2);
    expect(vi.mocked(logEdit).mock.calls[0][0]).toMatchObject({
      ownerUserId: 2, invoiceId: 11, itemId: 101, entity: 'mapping', field: 'new_item_create',
      oldValue: 'Батон нарезной', newValue: 'Батон нарезной 0,4 кг',
    });
    expect(res.body.data).toMatchObject({ lines: 2, invoices: 2, request: { id: 7, status: 'pending', unit: 'шт', parent_guid: 'grp-bread' } });
  });

  it('группа — только из каталога компании (позиция, папка или чья-то группа)', async () => {
    const res = await request(app()).post('/api/new-items/create').send({ ...body, parent_guid: 'чужая-группа' });
    expect(res.status).toBe(400);
    expect(reqRepo.upsertPending).not.toHaveBeenCalled();
    // guid самой позиции/папки тоже годится
    const ok = await request(app()).post('/api/new-items/create').send({ ...body, parent_guid: 'item-1' });
    expect(ok.status).toBe(200);
  });

  it('позиция с таким названием уже есть → 409 с позицией, заявка не создаётся', async () => {
    catalogRepo.listItems.mockResolvedValue([
      { guid: 'b-1', name: 'БАТОН НАРЕЗНОЙ 0,4 КГ', unit: 'шт', parent_guid: null, is_folder: 0 } as never,
    ]);
    const res = await request(app()).post('/api/new-items/create').send({ ...body, parent_guid: undefined });
    expect(res.status).toBe(409);
    expect(res.body.existing).toEqual({ guid: 'b-1', name: 'БАТОН НАРЕЗНОЙ 0,4 КГ', unit: 'шт' });
    expect(reqRepo.upsertPending).not.toHaveBeenCalled();
    expect(invoiceRepo.setItemCustomName).not.toHaveBeenCalled();
  });

  it('недопустимая единица → 400; строк группы нет → 404', async () => {
    expect((await request(app()).post('/api/new-items/create').send({ ...body, unit: 'г' })).status).toBe(400);
    groupLines.mockResolvedValue([]);
    expect((await request(app()).post('/api/new-items/create').send(body)).status).toBe(404);
    expect(reqRepo.upsertPending).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/new-items/:id', () => {
  it('ждущая заявка отменяется', async () => {
    reqRepo.getById.mockResolvedValue({ id: 7, status: 'pending', name: 'Батон', unit: 'шт', parent_guid: null, name_key: KEY } as never);
    reqRepo.cancel.mockResolvedValue(true);
    const res = await request(app()).delete('/api/new-items/7');
    expect(res.status).toBe(200);
    expect(reqRepo.getById).toHaveBeenCalledWith(2, 7);
    expect(reqRepo.cancel).toHaveBeenCalledWith(2, 7);
    expect(vi.mocked(logEdit).mock.calls[0][0]).toMatchObject({ field: 'new_item_cancel', ownerUserId: 2 });
  });

  it('чужая/несуществующая → 404; выполненная → 409; кривой id → 400', async () => {
    reqRepo.getById.mockResolvedValue(undefined);
    expect((await request(app()).delete('/api/new-items/8')).status).toBe(404);
    reqRepo.getById.mockResolvedValue({ id: 9, status: 'created' } as never);
    expect((await request(app()).delete('/api/new-items/9')).status).toBe(409);
    expect((await request(app()).delete('/api/new-items/abc')).status).toBe(400);
    expect(reqRepo.cancel).not.toHaveBeenCalled();
  });
});
