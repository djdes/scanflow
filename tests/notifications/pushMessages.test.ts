import { describe, expect, it } from 'vitest';
import { isAllowedPushEndpoint, pushBatchMessage, pushMessage } from '../../src/notifications/pushMessages';

// Уведомления на телефон (мобильное приложение /m/, правило 48): коротко,
// простыми словами, нажатие открывает накладную в приложении.
const NB = '\u00a0';
const inv = { id: 42, supplier: 'ООО «Молочная ферма»', total_sum: 12400, invoice_number: 'РН-1048' };

describe('pushMessage — текст уведомления', () => {
  it('прочитали — поставщик и сумма, ссылка на накладную', () => {
    expect(pushMessage('invoice_recognized', { invoice_id: 42 }, inv)).toEqual({
      title: 'Накладная прочитана',
      body: `ООО «Молочная ферма» · 12${NB}400${NB}₽`,
      url: '/m/#/inv/42',
      tag: 'inv-42',
    });
  });

  it.each([
    ['recognition_error', 'Не прочиталась накладная', 'Переснимите при хорошем свете.'],
    ['suspicious_total', 'Проверьте сумму', 'ООО «Молочная ферма»: сумма не сходится.'],
    ['elevated_prices', 'Цены выше обычного', `ООО «Молочная ферма» · 12${NB}400${NB}₽`],
    ['sent_to_1c', 'Накладная в 1С ✓', `ООО «Молочная ферма» · 12${NB}400${NB}₽`],
    ['sber_payment_overdue', 'Не оплачена накладная', `ООО «Молочная ферма» · 12${NB}400${NB}₽`],
  ] as const)('%s', (event, title, body) => {
    const msg = pushMessage(event, { invoice_id: 42 }, inv);
    expect(msg).toMatchObject({ title, body, url: '/m/#/inv/42', tag: 'inv-42' });
  });

  it('о своих действиях человека не тревожим', () => {
    for (const event of ['photo_uploaded', 'approved_for_1c', 'invoice_edited', 'weekly_price_digest'] as const) {
      expect(pushMessage(event, { invoice_id: 42 }, inv)).toBeNull();
    }
  });

  it('без поставщика и суммы — не пустая строка', () => {
    expect(pushMessage('invoice_recognized', { invoice_id: 7 }, { id: 7, supplier: null, total_sum: null }))
      .toMatchObject({ body: 'Откройте, чтобы посмотреть.' });
    expect(pushMessage('sent_to_1c', { invoice_id: 7 }, { id: 7, supplier: 'ИП Иванов', total_sum: null }))
      .toMatchObject({ body: 'ИП Иванов' });
  });

  it('длинное название поставщика укорачивается', () => {
    const long = 'Общество с ограниченной ответственностью «Очень длинное название поставщика продуктов питания»';
    const msg = pushMessage('invoice_recognized', { invoice_id: 1 }, { id: 1, supplier: long, total_sum: 5 });
    expect(msg!.body.length).toBeLessThanOrEqual(90);
    expect(msg!.body).toContain('…');
  });
});

describe('pushBatchMessage — сводка пачки', () => {
  it('сколько прочитали и сколько с ошибкой', () => {
    expect(pushBatchMessage({ uploaded: 5, recognized: 4, errors: [{}] })).toEqual({
      title: 'Прочитано 4 накладные',
      body: '1 не прочиталась — переснимите.',
      url: '/m/#/list/all',
      tag: 'batch',
    });
    expect(pushBatchMessage({ uploaded: 2, recognized: 2, errors: [] }))
      .toMatchObject({ title: 'Прочитано 2 накладные', body: 'Можно проверять.' });
    expect(pushBatchMessage({ uploaded: 1, recognized: 0, errors: [] })).toBeNull();
  });
});

describe('isAllowedPushEndpoint — сервер шлёт только в службы уведомлений браузеров', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc:def',
    'https://jmt17.google.com/fcm/send/abc:def',
    'https://web.push.apple.com/QH0x',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAA',
    'https://wns2-par02p.notify.windows.com/w/?token=x',
  ])('пускает %s', (url) => expect(isAllowedPushEndpoint(url)).toBe(true));

  it.each([
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://192.168.33.3/fcm/send',
    'https://localhost/push',
    'https://evil.example.com/fcm.googleapis.com',
    'https://fcm.googleapis.com.evil.com/x',
    'https://xjmt17.google.com/x',
    'https://fcm.googleapis.com:8443/x',
    'not a url',
    '',
  ])('не пускает %s', (url) => expect(isAllowedPushEndpoint(url)).toBe(false));
});
