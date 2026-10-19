import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const catalogScript = readFileSync('public/js/onecCatalog.js', 'utf8');
const invoicesScript = readFileSync('public/js/invoices.js', 'utf8');
const rows = [
  { guid: 'a', name: 'Сахар белый', code: '000123', unit: 'кг' },
  { guid: 'b', name: 'Подложка D-21 (квадратная)', code: 'SKU-77', unit: 'шт' },
];
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const catalog = (apiJson = vi.fn().mockResolvedValue({ data: rows }), extra = {}) => {
  const c = runInNewContext(`${catalogScript}\nOnecCatalog;`, { App: { apiJson }, console: { error() {}, warn() {} }, ...extra });
  return { c, apiJson };
};
const invoices = (apiJson = vi.fn().mockResolvedValue({ success: true }), extra = {}) => {
  const notify = vi.fn();
  const i = runInNewContext(`${invoicesScript}\nInvoices;`, { App: { apiJson, notify, esc, formatMoney: String }, ...extra });
  i.showDetail = vi.fn();
  return { i, apiJson, notify };
};

describe('доступность справочника 1С', () => {
  it('поиск по части названия, нескольким основам и коду работает без Fuse/CDN', async () => {
    const { c } = catalog();
    expect(await c.load()).toBe(true);
    expect(c.loaded).toBe(true);
    expect(c.search('сах')[0]).toMatchObject(rows[0]);
    expect(c.search('подложк d-21')[0].guid).toBe('b');
    expect(c.search('sku-77')[0]).toMatchObject(rows[1]);
    expect(c.search('несуществующий товар')).toHaveLength(0);
  });

  it('сбой создания fuzzy-индекса не скрывает загруженный справочник', async () => {
    const { c } = catalog(undefined, { Fuse: class { constructor() { throw new Error('broken'); } } });
    expect(await c.load()).toBe(true);
    expect(c.search('000123')[0].guid).toBe('a');
  });

  it('ошибка загрузки отличается от пустого каталога и допускает повторную попытку', async () => {
    const api = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ data: [] });
    const { c } = catalog(api);
    expect(await c.load()).toBe(false);
    expect(c.loaded).toBe(false);
    expect(c.isEmpty()).toBe(false);
    expect(c.lastError).toBe('offline');
    expect(await c.load()).toBe(true);
    expect(c.isEmpty()).toBe(true);
    expect(c.lastError).toBe(null);
  });

  it('ошибка обновления сохраняет ранее загруженные товары, успешное обновление заменяет их', async () => {
    const api = vi.fn().mockResolvedValueOnce({ data: rows }).mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ data: [rows[1]] });
    const { c } = catalog(api);
    await c.load();
    expect(await c.load(true)).toBe(false);
    expect(c.loaded).toBe(true);
    expect(c.getByGuid('a')).toMatchObject(rows[0]);
    expect(c.lastError).toBe('offline');
    await c.load(true);
    expect(c.items).toHaveLength(1);
    expect(c.getByGuid('a')).toBe(null);
    expect(c.lastError).toBe(null);
  });

  it('объединяет одновременные загрузки и проверяет формат ответа', async () => {
    const { c, apiJson } = catalog();
    await Promise.all([c.load(), c.load(), c.load(true)]);
    expect(apiJson).toHaveBeenCalledTimes(1);
    await c.load();
    expect(apiJson).toHaveBeenCalledTimes(1);
    const broken = catalog(vi.fn().mockResolvedValue({ data: null })).c;
    expect(await broken.load()).toBe(false);
    expect(broken.loaded).toBe(false);
  });
});

describe('явное сопоставление строки накладной', () => {
  const item = { id: 2, original_name: 'Полное длинное название из скана', mapped_name: 'Неподтверждённая подсказка', quantity: 1, unit: 'шт', total: 10 };

  it('показывает кнопку выбора и не выдаёт подсказку за сохранённую привязку', () => {
    const { i } = invoices();
    const html = i._itemRow({ id: 7, items: [item] }, item, 0);
    expect(html).toContain('NomenclaturePicker.open(7, 2)');
    expect(html).toContain('Выбрать из 1С');
    expect(html).toContain('Товар из 1С не выбран');
    expect(html).not.toContain('Неподтверждённая подсказка');
  });

  it('отображает сохранённое название и экранирует его', () => {
    const { i } = invoices();
    const mapped = { ...item, onec_guid: 'a', mapped_name: '<img src=x onerror=alert(1)>' };
    const html = i._itemRow({ id: 7, items: [mapped] }, mapped, 0);
    expect(html).toContain('Изменить');
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img src=x');
  });

  it('передаёт GUID серверу и сообщает об успехе только после сохранения', async () => {
    const { i, apiJson, notify } = invoices();
    expect(await i.selectNomItem(7, 2, 'a', 'Сахар', { refresh: false, throwOnError: true })).toBe(true);
    expect(apiJson).toHaveBeenCalledWith('/invoices/7/items/2/map', { method: 'PUT', body: { onec_guid: 'a' } });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('сохранено'), 'success');
    expect(i.showDetail).not.toHaveBeenCalled();
  });

  it('сохраняет существующее подтверждение упаковки', async () => {
    const confirm = vi.fn().mockReturnValue(true);
    const { i, apiJson } = invoices(undefined, { confirm, InvoiceCard: { inv: { id: 7, items: [{ id: 2, original_name: 'Сахар (50 кг)', quantity: 3 }] } } });
    await i.selectNomItem(7, 2, 'a', 'Сахар', { refresh: false });
    expect(confirm).toHaveBeenCalled();
    expect(apiJson).toHaveBeenCalledWith('/invoices/7/items/2/map', { method: 'PUT', body: { onec_guid: 'a', pack_size: 50, pack_unit: 'кг' } });
  });

  it('возвращает ошибку диалогу, чтобы он остался открытым без ложного успеха', async () => {
    const { i, notify } = invoices(vi.fn().mockRejectedValue(new Error('Товар не найден в вашем справочнике')));
    await expect(i.selectNomItem(7, 2, 'other-owner', 'Чужой', { throwOnError: true })).rejects.toThrow('вашем справочнике');
    expect(notify).not.toHaveBeenCalled();
    expect(i.showDetail).not.toHaveBeenCalled();
  });

  it('своё название сохраняет отдельным действием без выбора GUID', async () => {
    const { i, apiJson } = invoices();
    expect(await i.saveCustomName(7, 2, '  Этикетка новая  ', { refresh: false, throwOnError: true })).toBe(true);
    expect(apiJson).toHaveBeenCalledWith('/invoices/7/items/2', { method: 'PATCH', body: { mapped_name: 'Этикетка новая' } });
    expect(i.showDetail).not.toHaveBeenCalled();
  });
});
