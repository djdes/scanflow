import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { beforeEach, describe, expect, it } from 'vitest';

// Карточка накладной «по шагам»: чистые функции без DOM (спек 2026-10-09).
const script = readFileSync('public/js/invoice-card.js', 'utf8');
let card: any;
const App = {
  formatMoney: (v: number) => Number(v).toFixed(2).replace('.', ','),
  formatDate: (d: string) => d.split('-').reverse().join('.'),
  isXmlInvoice: (inv: any) => String(inv.ocr_engine || '').startsWith('xml_') || /\.xml$/i.test(inv.file_name || ''),
  esc: (s: string) => s,
};
beforeEach(() => { card = runInNewContext(`${script}\nInvoiceCard;`, { App }); });

const all6 = { attr_checked_number: 1, attr_checked_date: 1, attr_checked_supplier: 1, attr_checked_total: 1, attr_checked_vat: 1, attr_checked_vat_rate: 1 };
const base = (over: any = {}) => ({
  id: 787, status: 'processed', approved_for_1c: 0, onec_status: 'not_sent', invoice_number: '17-0605773', invoice_date: '2026-10-06',
  supplier: 'ООО «Свит Лайф Фудсервис»', total_sum: 107528.07, vat_sum: 13864.03,
  items: [{ id: 1, onec_guid: 'g', vat_rate: 10 }, { id: 2, onec_guid: null, vat_rate: 22 }], ...over,
});
const sber = { connected: true, payer_complete: true };

describe('реквизиты сверки', () => {
  it('шесть реквизитов со значениями и отметками', () => {
    const r = card.requisites(base({ attr_checked_number: 1, attr_checked_total: 1 }));
    expect(r.map((x: any) => x.key)).toEqual(['number', 'date', 'supplier', 'total', 'vat', 'vat_rate']);
    expect(r.find((x: any) => x.key === 'date').value).toBe('06.10.2026');
    expect(r.find((x: any) => x.key === 'vat_rate').value).toBe('10%, 22%');
    expect(r.filter((x: any) => x.checked).map((x: any) => x.key)).toEqual(['number', 'total']);
    expect(card.checkedCount(base(all6))).toBe(6);
  });
  it('НДС ноль — «без НДС», нет данных — прочерк', () => {
    expect(card.requisites(base({ vat_sum: 0 })).find((x: any) => x.key === 'vat').value).toBe('без НДС');
    expect(card.requisites(base({ vat_sum: null, items: [] })).find((x: any) => x.key === 'vat_rate').value).toBe('—');
  });
});

describe('состояния шагов', () => {
  it('новая накладная: сверка в работе, 1С — отправить, оплата — нужна сверка', () => {
    const s = card.stepStates(base({ attr_checked_number: 1 }), sber, null);
    expect(s.verify).toMatchObject({ state: 'current', hint: '1 из 6 реквизитов' });
    expect(s.onec).toMatchObject({ state: 'idle', action: { kind: 'send1c' } });
    expect(s.onec.hint).toContain('1 новый товар');
    expect(s.pay).toMatchObject({ state: 'idle', hint: 'нужна сверка 6 из 6', action: { kind: 'pay' } });
    expect(card.defaultStep(s)).toBe('verify');
  });
  it('сверено, ждёт 1С; платежа нет → открыт шаг оплаты', () => {
    const s = card.stepStates(base({ ...all6, approved_for_1c: 1 }), sber, null);
    expect(s.verify.state).toBe('done');
    expect(s.onec).toMatchObject({ state: 'queued', hint: 'ждёт загрузки в 1С' });
    expect(card.defaultStep(s)).toBe('pay');
  });
  it('в 1С: короткая ссылка на документ; не проведён — пометка', () => {
    const ref = 'Приходная накладная 2644 (вх. 17-0605773) от 07.10.2026';
    expect(card.stepStates(base({ status: 'sent_to_1c', onec_status: 'posted', onec_document_ref: ref }), sber, null).onec)
      .toMatchObject({ state: 'done', hint: 'Приходная накладная 2644' });
    expect(card.stepStates(base({ status: 'sent_to_1c', onec_status: 'created', onec_document_ref: ref }), sber, null).onec.hint)
      .toBe('Приходная накладная 2644 · не проведён');
  });
  it('после «Сбросить статус» (Обработан, а 1С когда-то провела) — снова «Отправить в 1С»', () => {
    expect(card.stepStates(base({ status: 'processed', onec_status: 'posted' }), sber, null).onec)
      .toMatchObject({ state: 'idle', action: { kind: 'send1c' } });
  });
  it('ошибка 1С, распознавание и дубликат', () => {
    expect(card.stepStates(base({ onec_status: 'rejected' }), sber, null).onec.state).toBe('error');
    expect(card.stepStates(base({ status: 'waiting_ai' }), sber, null).onec).toMatchObject({ state: 'blocked', hint: 'ждёт распознавания' });
    const dup = card.stepStates(base({ duplicate_of: 12 }), sber, null);
    expect([dup.verify.state, dup.onec.state, dup.pay.state]).toEqual(['blocked', 'blocked', 'blocked']);
  });
  it('накладная снята не полностью — отправка в 1С закрыта, пока не добавят страницы', () => {
    const inv = base({ completeness: { message: 'Нет страницы 2 из 3' } });
    expect(card.stepStates(inv, sber, null).onec).toMatchObject({ state: 'blocked', hint: 'снята не полностью — добавьте страницы' });
    // Уже в 1С — признак на шаг не влияет.
    expect(card.stepStates({ ...inv, status: 'sent_to_1c', onec_status: 'posted' }, sber, null).onec.state).toBe('done');
  });
  it('оплата: черновик, в банке, оплачено, отклонено, вне сервиса, Сбер не подключён', () => {
    const inv = base(all6);
    const pay = (p: any, s: any = sber) => card.stepStates(inv, s, p).pay;
    expect(pay({ status: 'created', bank_status_kind: 'draft' })).toMatchObject({ state: 'progress', hint: 'черновик · ждёт подписи' });
    expect(pay({ status: 'created', bank_status_kind: 'in_progress', bank_status_label: 'Принят банком' })).toMatchObject({ state: 'progress', hint: 'Принят банком' });
    expect(pay({ status: 'created', bank_status_kind: 'paid' }).state).toBe('done');
    expect(pay({ status: 'created', bank_status_kind: 'failed' }).state).toBe('error');
    expect(pay({ status: 'failed' })).toMatchObject({ state: 'error', action: { kind: 'pay' } });
    expect(card.stepStates(base({ paid_externally: 1 }), sber, null).pay).toMatchObject({ state: 'done', hint: 'оплачено вне сервиса' });
    expect(pay(null, { connected: false })).toMatchObject({ state: 'off' });
    expect(pay(undefined, null).hint).toBe('…');
  });
  it('всё сделано — открыт шаг оплаты с результатом', () => {
    const s = card.stepStates(base({ ...all6, status: 'sent_to_1c', onec_status: 'posted' }), sber, { status: 'created', bank_status_kind: 'paid' });
    expect(card.defaultStep(s)).toBe('pay');
  });
});

describe('меню «⋯»', () => {
  const ids = (inv: any) => card.menuItems(inv).map((x: any) => (x ? x.id : '—'));
  it('фото: пересканировать, добавить страницы, позиции, реквизиты, эталон, удалить — с разделителями', () => {
    expect(ids(base())).toEqual(['rescan', 'addPages', '—', 'remapMissing', 'remapAll', 'llm', 'confirmMappings', '—', 'editHeader', 'compare', 'golden', '—', 'delete']);
    expect(card.menuItems(base()).at(-1)).toMatchObject({ danger: true });
  });
  it('XML: «Перечитать XML», без страниц и эталона; в 1С — «Сбросить статус»', () => {
    const xml = card.menuItems(base({ ocr_engine: 'xml_upd', status: 'sent_to_1c', items: [{ id: 1, onec_guid: 'g' }] }));
    expect(xml[0].label).toBe('Перечитать XML');
    expect(xml.map((x: any) => x && x.id)).not.toContain('addPages');
    expect(xml.map((x: any) => x && x.id)).not.toContain('golden');
    expect(xml.map((x: any) => x && x.id)).toContain('resetStatus');
  });
  it('«Снова проверять страницы» — только когда проверка снята отметкой', () => {
    expect(ids(base({ completeness: { confirmed: true, message: null } }))).toContain('pagesCheck');
    expect(ids(base({ completeness: { message: 'Не найдены позиции 1–20' } }))).not.toContain('pagesCheck');
  });
  it('дубликат — только «Это не дубликат» и удаление', () => {
    expect(ids(base({ duplicate_of: 3 }))).toEqual(['notDuplicate', '—', 'delete']);
  });
});
