import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { beforeAll, describe, expect, it } from 'vitest';

// Список накладных (спек 2026-10-09): одинаковые плашки «1С» и «Оплата», кнопка действия одной ширины.
const script = readFileSync('public/js/invoices.js', 'utf8');
const App = {
  esc: (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]),
  formatMoney: (v: number) => Number(v).toFixed(2),
  formatDate: (d: string) => d,
};
let I: any;
beforeAll(() => { I = runInNewContext(`${script}\nInvoices;`, { App }); });

const tone = (html: string) => /inv-pill--(\w+)/.exec(html)?.[1];
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('колонка «1С»', () => {
  const pill = (inv: any) => I._onecPill({ status: 'processed', approved_for_1c: 0, onec_status: 'not_sent', ...inv });
  it('по пути в 1С: не отправлена → в очереди → в 1С', () => {
    expect([tone(pill({})), text(pill({}))]).toEqual(['grey', 'Не отправлена']);
    expect([tone(pill({ approved_for_1c: 1 })), text(pill({ approved_for_1c: 1 }))]).toEqual(['blue', 'В очереди ждёт загрузки']);
    expect([tone(pill({ status: 'sent_to_1c', onec_status: 'posted' })), text(pill({ status: 'sent_to_1c', onec_status: 'posted' }))]).toEqual(['green', 'В 1С']);
    expect(text(pill({ status: 'sent_to_1c', onec_status: 'created' }))).toBe('В 1С не проведена');
    // «Сбросить статус» оставляет прежний ответ 1С — накладная снова не отправлена.
    expect(text(pill({ status: 'processed', onec_status: 'posted' }))).toBe('Не отправлена');
  });
  it('внимание и ошибки', () => {
    expect(tone(pill({ review_reason: 'quantity' }))).toBe('amber');
    expect(tone(pill({ duplicate_of: 3 }))).toBe('amber');
    expect(tone(pill({ status: 'error' }))).toBe('red');
    expect(tone(pill({ status: 'waiting_ai' }))).toBe('blue');
    const rejected = pill({ onec_status: 'rejected', onec_error: 'Нет <склада>' });
    expect(tone(rejected)).toBe('red');
    expect(rejected).toContain('Нет &lt;склада&gt;');
  });
});

describe('колонка «Оплата»', () => {
  const pill = (inv: any) => I._payPill({ paid_externally: 0, sber_payment_status: null, sber_bank_kind: null, ...inv });
  it('все состояния платежа', () => {
    expect([tone(pill({})), text(pill({}))]).toEqual(['grey', 'Нет платёжки']);
    expect(text(pill({ sber_overdue: 1, sber_overdue_days: 14 }))).toBe('Нет платёжки больше 14 дней');
    expect(tone(pill({ sber_overdue: 1 }))).toBe('amber');
    expect(text(pill({ sber_payment_status: 'created', sber_bank_kind: 'draft' }))).toBe('Черновик ждёт подписи');
    expect(text(pill({ sber_payment_status: 'created', sber_bank_kind: 'in_progress', sber_bank_label: 'Принят банком' }))).toBe('В банке Принят банком');
    expect([tone(pill({ sber_payment_status: 'created', sber_bank_kind: 'paid' })), text(pill({ sber_payment_status: 'created', sber_bank_kind: 'paid' }))]).toEqual(['green', 'Оплачено исполнено банком']);
    expect(tone(pill({ sber_payment_status: 'failed' }))).toBe('red');
    expect(tone(pill({ sber_payment_status: 'pending' }))).toBe('blue');
    expect(text(pill({ paid_externally: 1, sber_payment_status: 'failed' }))).toBe('Оплачено вне сервиса');
  });
});

describe('номер строки товара', () => {
  const no = (items: any[], i: number) => /<td class="ic-row-no">(\d+)<\/td>/.exec(I._itemRow({ id: 1, items }, items[i], i))?.[1];
  const item = (id: number, row_no: number | null) => ({ id, row_no, original_name: 'Товар', quantity: 1, unit: 'кг', price: 1, total: 1, onec_guid: 'g' });
  it('как напечатан, если номера уникальны; у многостраничной (с 1 на каждом листе) — по порядку', () => {
    const printed = [item(1, 3), item(2, 4)];
    expect([no(printed, 0), no(printed, 1)]).toEqual(['3', '4']);
    const pages = [item(1, 1), item(2, 2), item(3, 1)];
    expect([no(pages, 0), no(pages, 1), no(pages, 2)]).toEqual(['1', '2', '3']);
    const missing = [item(1, null), item(2, 2)];
    expect([no(missing, 0), no(missing, 1)]).toEqual(['1', '2']);
  });
});

describe('устройство загрузки в «Истории»', () => {
  it('словами вместо строки браузера', () => {
    expect(I._deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1')).toBe('iPhone, Safari');
    expect(I._deviceLabel('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/30.0 Chrome/143.0.0.0 Mobile Safari/537.36')).toBe('Телефон Android, Samsung Internet');
    expect(I._deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 YaBrowser/25.8.0.0 Safari/537.36')).toBe('Компьютер Windows, Яндекс Браузер');
    expect(I._deviceLabel('curl/8.0')).toBe('Другое устройство');
    expect(I._deviceLabel(null)).toBe('');
  });
});

describe('кнопка действия строки', () => {
  it('одной ширины; «В 1С →» только у готовой к отправке', () => {
    const a = (inv: any) => I._rowAction({ id: 7, status: 'processed', approved_for_1c: 0, ...inv });
    for (const html of [a({}), a({ review_reason: 'total' }), a({ status: 'sent_to_1c' }), a({ duplicate_of: 2 })]) expect(html).toContain('inv-act');
    expect(text(a({}))).toBe('В 1С →');
    expect(text(a({ review_reason: 'total' }))).toBe('Проверить');
    expect(text(a({ duplicate_of: 2 }))).toBe('Открыть');
    expect(text(a({ approved_for_1c: 1 }))).toBe('Открыть');
  });
});
