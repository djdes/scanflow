import { describe, it, expect } from 'vitest';
import {
  buildNewItemGroups,
  pendingRequestsWithoutLines,
  validateMapGroupBody,
  validateCreateItemBody,
  indexPendingRequests,
  attachNewItems,
  matchRequestsToCatalog,
  findCatalogItemByName,
  suggestNewItemUnit,
  newItemGroupKey,
  NEW_ITEM_NAME_MAX,
  type UnmappedLine,
  type NewItemRequestLike,
} from '../../src/services/newItems';

// Чистая логика «Новых товаров» (пакет v2, п.12) — без БД.

function line(p: Partial<UnmappedLine> & { id: number; original_name: string }): UnmappedLine {
  return {
    invoice_id: 1, mapped_name: null, name_overridden: 0, unit: 'шт', raw_unit: 'шт',
    price: 100, raw_price: 100, supplier: 'ООО Альфа',
    ...p,
  };
}

function request(p: Partial<NewItemRequestLike> & { name_key: string }): NewItemRequestLike {
  return { id: 1, name: 'Капуста морская', unit: 'кг', parent_guid: null, status: 'pending', onec_guid: null, ...p };
}

const KELP = [
  line({ id: 10, invoice_id: 1, original_name: 'Капуста морская(3кг)', mapped_name: 'Капуста морская', unit: 'кг', raw_unit: 'кг', price: 120, raw_price: 120, supplier: 'ООО Альфа' }),
  line({ id: 11, invoice_id: 2, original_name: 'Капуста морская (3 кг)', mapped_name: 'Капуста морская', price: 360, raw_price: 360, supplier: 'ООО Бета' }),
  line({ id: 12, invoice_id: 2, original_name: 'Капуста морская 3кг', mapped_name: 'Капуста морская', price: 355, raw_price: 355, supplier: 'ООО Бета' }),
];
const OLIVES = line({ id: 13, invoice_id: 3, original_name: 'Маслины 300г 1/12', mapped_name: 'Маслины', price: 99, raw_price: 99, supplier: 'ООО Гамма' });

describe('buildNewItemGroups — группы строк по ключу товара', () => {
  it('разные написания одного товара — одна группа; самые массовые — выше', () => {
    const groups = buildNewItemGroups([OLIVES, ...KELP], []);
    expect(groups.map(g => g.lines)).toEqual([3, 1]);
    const kelp = groups[0];
    expect(kelp.name_key).toBe(newItemGroupKey('Капуста морская 3кг'));
    expect(kelp.names).toHaveLength(3);
    // при равной частоте — самое свежее написание (строка с большим id)
    expect(kelp.sample_name).toBe('Капуста морская 3кг');
    expect(kelp.invoices).toEqual([2, 1]);
    expect(kelp.suppliers).toEqual(['ООО Бета', 'ООО Альфа']);
    expect(kelp.supplier_count).toBe(2);
    expect(kelp.request).toBeNull();
    expect(groups[1].sample_name).toBe('Маслины 300г 1/12');
  });

  it('единица — самая частая «как в накладной», цена — из самой свежей строки', () => {
    const [kelp] = buildNewItemGroups(KELP, []);
    expect(kelp.unit).toBe('шт');
    expect(kelp.unit_class).toBe('count');
    expect(kelp.suggested_unit).toBe('шт');
    expect(kelp.last_price).toBe(355);
    expect(kelp.last_price_unit).toBe('шт');
  });

  it('название для «Создать в 1С»: очищенное самое частое написание', () => {
    const [kelp] = buildNewItemGroups(KELP, []);
    expect(kelp.suggested_name).toBe('Капуста морская');
    expect(kelp.suggested_name.length).toBeLessThanOrEqual(NEW_ITEM_NAME_MAX);
  });

  it('своё название человека на строке важнее очищенного', () => {
    const lines = [...KELP, line({ id: 14, invoice_id: 5, original_name: 'КАПУСТА МОРСКАЯ 3 КГ', mapped_name: 'Ламинария 3 кг', name_overridden: 1 })];
    const [kelp] = buildNewItemGroups(lines, []);
    expect(kelp.lines).toBe(4);
    expect(kelp.suggested_name).toBe('Ламинария 3 кг');
  });

  it('ждущая заявка: статус, подсказки из заявки, строки без её названия считаются', () => {
    const key = newItemGroupKey('Капуста морская 3кг');
    const lines = [
      ...KELP.map(l => ({ ...l, mapped_name: 'Ламинария', name_overridden: 1 })),
      line({ id: 20, invoice_id: 9, original_name: 'капуста морская 3 кг', mapped_name: 'Капуста морская' }),
    ];
    const [kelp] = buildNewItemGroups(lines, [request({ id: 7, name_key: key, name: 'ламинария', unit: 'кг', parent_guid: 'p-1' })]);
    expect(kelp.request).toEqual({ id: 7, status: 'pending', name: 'ламинария', unit: 'кг', parent_guid: 'p-1', onec_guid: null });
    expect(kelp.suggested_name).toBe('ламинария');
    expect(kelp.suggested_unit).toBe('кг');
    // регистр не важен: «Ламинария» = «ламинария»; строка 20 пришла позже и названия не получила
    expect(kelp.lines_without_request_name).toBe(1);
  });

  it('отменённая заявка не показывается, выполненная — показывается без счётчика', () => {
    const key = newItemGroupKey('Маслины 300г');
    expect(buildNewItemGroups([OLIVES], [request({ name_key: key, status: 'cancelled' })])[0].request).toBeNull();
    const created = buildNewItemGroups([OLIVES], [request({ name_key: key, status: 'created', onec_guid: 'g-9' })])[0];
    expect(created.request).toMatchObject({ status: 'created', onec_guid: 'g-9' });
    expect(created.lines_without_request_name).toBe(0);
  });

  it('строки без ключа (одна пунктуация) пропускаются; предел числа групп', () => {
    const groups = buildNewItemGroups([...KELP, OLIVES, line({ id: 30, original_name: ' -- ' })], [], 1);
    expect(groups).toHaveLength(1);
    expect(groups[0].lines).toBe(3);
  });

  it('единица новой позиции по единице строк', () => {
    const [g] = buildNewItemGroups([line({ id: 1, original_name: 'Сливки 33% 1л', unit: 'мл', raw_unit: 'мл' })], []);
    expect(g.suggested_unit).toBe('л');
    expect(g.unit_class).toBe('volume');
  });
});

describe('suggestNewItemUnit', () => {
  it.each([
    ['г', 'кг'], ['кг', 'кг'], ['мл', 'л'], ['л', 'л'], ['кор', 'упак'], ['уп.', 'упак'],
    ['бут', 'шт'], ['шт.', 'шт'], ['xyz', null], [null, null],
  ])('%s → %s', (raw, expected) => {
    expect(suggestNewItemUnit(raw)).toBe(expected);
  });
});

describe('pendingRequestsWithoutLines', () => {
  it('ждущие заявки, у которых не осталось строк на странице', () => {
    const kelpKey = newItemGroupKey('Капуста морская 3кг');
    const reqs = [
      request({ id: 1, name_key: kelpKey }),
      request({ id: 2, name_key: 'нет строк' }),
      request({ id: 3, name_key: 'выполнена', status: 'created' }),
    ];
    expect(pendingRequestsWithoutLines(reqs, KELP).map(r => r.id)).toEqual([2]);
  });
});

describe('validateMapGroupBody', () => {
  it('принимает ключ и позицию', () => {
    expect(validateMapGroupBody({ name_key: ' 3кг капуста морская ', onec_guid: ' g-1 ' }))
      .toEqual({ ok: true, value: { name_key: '3кг капуста морская', onec_guid: 'g-1' } });
  });

  it.each([
    [null], [[]], ['строка'], [{}], [{ name_key: 'k' }], [{ name_key: 'k', onec_guid: '' }],
    [{ name_key: 'k', onec_guid: 5 }], [{ name_key: '', onec_guid: 'g' }], [{ name_key: 'x'.repeat(192), onec_guid: 'g' }],
    [{ name_key: 'k', onec_guid: 'g'.repeat(65) }],
  ])('отклоняет %j', (body) => {
    expect(validateMapGroupBody(body).ok).toBe(false);
  });
});

describe('validateCreateItemBody', () => {
  const ok = { name_key: 'k', name: 'Батон нарезной 0,4 кг', unit: 'шт' };

  it('нормализует название и приводит единицу к канонической', () => {
    const r = validateCreateItemBody({ ...ok, name: '  Батон\tнарезной \n 0,4 кг\u0007 ', unit: 'Шт.' });
    expect(r).toEqual({ ok: true, value: { name_key: 'k', name: 'Батон нарезной 0,4 кг', unit: 'шт', parent_guid: null } });
  });

  it.each([['уп', 'упак'], ['упаковка', 'упак'], ['литр', 'л'], ['КГ', 'кг']])('единица %s → %s', (raw, unit) => {
    const r = validateCreateItemBody({ ...ok, unit: raw });
    expect(r.ok && r.value.unit).toBe(unit);
  });

  it.each([['г'], ['кор'], ['мл'], [''], [5]])('единица %j не подходит', (unit) => {
    const r = validateCreateItemBody({ ...ok, unit });
    expect(r.ok).toBe(false);
  });

  it('название: пустое и длиннее 150 символов — ошибка, ровно 150 — можно', () => {
    expect(validateCreateItemBody({ ...ok, name: '   ' }).ok).toBe(false);
    expect(validateCreateItemBody({ ...ok, name: 5 }).ok).toBe(false);
    expect(validateCreateItemBody({ ...ok, name: 'я'.repeat(151) }).ok).toBe(false);
    expect(validateCreateItemBody({ ...ok, name: 'я'.repeat(150) }).ok).toBe(true);
  });

  it('группа необязательна; пустая строка = без группы; мусор — ошибка', () => {
    const noParent = validateCreateItemBody({ ...ok, parent_guid: '' });
    expect(noParent.ok && noParent.value.parent_guid).toBeNull();
    const withParent = validateCreateItemBody({ ...ok, parent_guid: ' 9f1c-aa ' });
    expect(withParent.ok && withParent.value.parent_guid).toBe('9f1c-aa');
    expect(validateCreateItemBody({ ...ok, parent_guid: 12 }).ok).toBe(false);
    expect(validateCreateItemBody({ ...ok, parent_guid: '   ' }).ok).toBe(false);
    expect(validateCreateItemBody({ ...ok, parent_guid: 'x'.repeat(65) }).ok).toBe(false);
  });

  it('без ключа группы — ошибка', () => {
    expect(validateCreateItemBody({ name: 'Хлеб', unit: 'шт' }).ok).toBe(false);
    expect(validateCreateItemBody(null).ok).toBe(false);
  });
});

describe('выгрузка /pending: new_item в строке', () => {
  const kelpKey = newItemGroupKey('Капуста морская 3кг');
  const index = indexPendingRequests([
    { owner_user_id: 5, name_key: kelpKey, name: 'Ламинария', unit: 'кг', parent_guid: 'grp-1', status: 'pending' },
    { owner_user_id: 5, name_key: newItemGroupKey('Маслины 300г'), name: 'Маслины', unit: 'шт', parent_guid: null, status: 'created' },
    { owner_user_id: 6, name_key: newItemGroupKey('Маслины 300г'), name: 'Маслины Б', unit: 'шт', parent_guid: '', status: 'pending' },
  ]);

  it('индекс — только ждущие заявки, по компании', () => {
    expect(index.size).toBe(2);
  });

  it('строка без позиции с заявкой получает new_item (любое написание товара)', () => {
    const items = [{ id: 1, original_name: 'КАПУСТА МОРСКАЯ (3 КГ)', onec_guid: null, mapped_name: 'Ламинария' }];
    const out = attachNewItems(items, 5, index);
    expect(out[0]).toEqual({ ...items[0], new_item: { name: 'Ламинария', unit: 'кг', parent_guid: 'grp-1' } });
  });

  it('остальные строки — те же объекты, выгрузка не меняется ни на байт', () => {
    const mapped = { id: 2, original_name: 'Капуста морская 3кг', onec_guid: 'g-1', mapped_name: 'Капуста' };
    const noRequest = { id: 3, original_name: 'Сахар 1кг', onec_guid: null, mapped_name: 'Сахар' };
    const olivesCreated = { id: 4, original_name: 'Маслины 300г 1/12', onec_guid: '', mapped_name: 'Маслины' };
    const before = JSON.stringify([mapped, noRequest, olivesCreated]);
    const out = attachNewItems([mapped, noRequest, olivesCreated], 5, index);
    expect(out[0]).toBe(mapped);
    expect(out[1]).toBe(noRequest);
    expect(out[2]).toBe(olivesCreated); // заявка компании 5 уже выполнена
    expect(JSON.stringify(out)).toBe(before);
  });

  it('заявка другой компании не применяется; пустая группа = null', () => {
    const olives = { id: 5, original_name: 'Маслины 300г', onec_guid: null };
    expect(attachNewItems([olives], 5, index)[0]).toBe(olives);
    expect(attachNewItems([olives], 6, index)[0]).toEqual({ ...olives, new_item: { name: 'Маслины Б', unit: 'шт', parent_guid: null } });
  });

  it('нет владельца или заявок — массив возвращается как есть', () => {
    const items = [{ id: 1, original_name: 'Капуста морская 3кг', onec_guid: null }];
    expect(attachNewItems(items, null, index)).toBe(items);
    expect(attachNewItems(items, 5, new Map())).toBe(items);
  });
});

describe('matchRequestsToCatalog — позиция по заявке появилась в каталоге', () => {
  const catalog = [
    { guid: 'folder', name: 'Батон нарезной 0,4 кг', unit: null, is_folder: 1 },
    { guid: 'b-kg', name: 'БАТОН НАРЕЗНОЙ 0,4 кг', unit: 'кг', is_folder: 0 },
    { guid: 'b-sht', name: '  батон   нарезной 0,4 кг ', unit: 'шт', is_folder: 0 },
    { guid: 'milk', name: 'Молоко 3,2% 1л', unit: 'л (дм3)', is_folder: 0 },
    { guid: 'hedgehog', name: 'Ёжики в тумане', unit: 'шт', is_folder: 0 },
  ];

  it('то же название без учёта регистра и пробелов; группы не считаются; при нескольких — с той же единицей', () => {
    const m = matchRequestsToCatalog([{ id: 1, name: 'Батон нарезной 0,4 кг', unit: 'шт', status: 'pending' }], catalog);
    expect(m).toEqual([{ requestId: 1, item: catalog[2] }]);
    const kg = matchRequestsToCatalog([{ id: 2, name: 'батон нарезной 0,4 кг', unit: 'кг', status: 'pending' }], catalog);
    expect(kg[0].item.guid).toBe('b-kg');
  });

  it('«л» совпадает с «л (дм3)» классификатора; ё = е', () => {
    expect(matchRequestsToCatalog([{ id: 3, name: 'молоко 3,2% 1л', unit: 'л', status: 'pending' }], catalog)[0].item.guid).toBe('milk');
    expect(matchRequestsToCatalog([{ id: 4, name: 'Ежики в тумане', unit: 'шт', status: 'pending' }], catalog)[0].item.guid).toBe('hedgehog');
  });

  it('не ждущие заявки и отсутствующие названия — мимо', () => {
    expect(matchRequestsToCatalog([
      { id: 5, name: 'Батон нарезной 0,4 кг', unit: 'шт', status: 'created' },
      { id: 6, name: 'Батон нарезной 0,4 кг', unit: 'шт', status: 'cancelled' },
      { id: 7, name: 'Батон нарезной', unit: 'шт', status: 'pending' },
    ], catalog)).toEqual([]);
  });

  it('при одинаковых кандидатах без совпадения единицы — детерминированно', () => {
    const twins = [
      { guid: 'z', name: 'Соль', unit: 'кг', is_folder: 0 },
      { guid: 'a', name: 'соль', unit: 'кг', is_folder: 0 },
    ];
    expect(findCatalogItemByName('СОЛЬ', 'шт', twins)?.guid).toBe('a');
    expect(findCatalogItemByName('Перец', 'шт', twins)).toBeNull();
  });
});
